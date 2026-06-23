/**
 * Agent history routes — proxy session data from worker HTTP server,
 * with direct session-file fallback for embedded dev mode, plus
 * per-thread list/message endpoints for the web-panel chat UI.
 * Auth: settings session cookie (verifySettingsSession).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigStore, ParsedMessage } from "@lobu/core";
import { createLogger, entryToMessage, parseSessionEntries } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { resolveOrgId } from "../../../lobu/stores/org-context.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { WorkerConnectionManager } from "../../gateway/connection-manager.js";
import {
	listAgentThreads,
	readThreadMessages,
} from "../../services/agent-thread-list.js";
import {
	createOwnershipResolver,
	resolveSettingsLookupUserId,
} from "../shared/agent-ownership.js";
import { errorResponse } from "../shared/helpers.js";
import { verifySettingsSession } from "./settings-auth.js";

export type { AgentThreadSummary } from "../../services/agent-thread-list.js";
export {
	buildApiConversationId,
	extractThreadIdFromConversationId,
} from "../../services/api-conversation-id.js";
export { readSnapshotJsonl } from "../../services/transcript-snapshot.js";

/**
 * Read the latest completed transcript snapshot for an agent's most-recent
 * conversation. Returns the raw JSONL content + sessionId-equivalent, or
 * null when no snapshot exists.
 */
export async function readLatestSnapshotJsonl(
	agentId: string,
	organizationId: string | undefined,
): Promise<string | null> {
	if (!organizationId) return null;
	const sql = getDb();
	const snapshotRows = await sql<{ snapshot_jsonl: string }>`
    SELECT snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND terminal_status = 'completed'
    ORDER BY run_id DESC
    LIMIT 1
  `;
	return snapshotRows[0]?.snapshot_jsonl ?? null;
}

const logger = createLogger("agent-history-routes");

const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
	return SAFE_AGENT_ID.test(id);
}

function isSafeThreadId(id: string): boolean {
	return SAFE_THREAD_ID.test(id);
}

async function findSessionFile(agentId: string): Promise<string | null> {
	if (!isSafeAgentId(agentId)) return null;
	const workspacesRoot = resolve("workspaces");
	const workspaceDir = resolve(workspacesRoot, agentId);
	if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return null;

	const directPath = join(workspaceDir, ".openclaw", "session.jsonl");
	try {
		await stat(directPath);
		return directPath;
	} catch {
		// Not found
	}

	try {
		const search = async (
			dir: string,
			depth: number,
		): Promise<string | null> => {
			if (depth > 3) return null;
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				const sessionPath = join(dir, entry.name, ".openclaw", "session.jsonl");
				try {
					await stat(sessionPath);
					return sessionPath;
				} catch {
					const deeper = await search(join(dir, entry.name), depth + 1);
					if (deeper) return deeper;
				}
			}
			return null;
		};
		return await search(workspaceDir, 0);
	} catch {
		// Workspace dir doesn't exist
	}

	return null;
}

async function readSessionMessages(
	agentId: string,
	cursorParam: string,
	limit: number,
	organizationId: string | undefined,
) {
	let content: string | null = await readLatestSnapshotJsonl(
		agentId,
		organizationId,
	);
	if (content === null) {
		const sessionPath = await findSessionFile(agentId);
		if (!sessionPath) {
			return {
				messages: [],
				nextCursor: null,
				hasMore: false,
				sessionId: "none",
			};
		}
		content = await readFile(sessionPath, "utf-8");
	}
	const { entries, sessionId } = parseSessionEntries(content);

	const allMessages: ParsedMessage[] = [];
	for (const entry of entries) {
		const msg = entryToMessage(entry);
		if (msg) allMessages.push(msg);
	}

	let startIndex = 0;
	if (cursorParam) {
		const idx = allMessages.findIndex((m) => m.id === cursorParam);
		if (idx >= 0) startIndex = idx + 1;
	}

	const pageMessages = allMessages.slice(startIndex, startIndex + limit);
	const hasMore = startIndex + limit < allMessages.length;
	const nextCursor = hasMore ? pageMessages[pageMessages.length - 1]?.id : null;

	return {
		messages: pageMessages,
		nextCursor,
		hasMore,
		sessionId: sessionId || "unknown",
	};
}

async function readSessionStats(
	agentId: string,
	organizationId: string | undefined,
) {
	let content: string | null = await readLatestSnapshotJsonl(
		agentId,
		organizationId,
	);
	if (content === null) {
		const sessionPath = await findSessionFile(agentId);
		if (!sessionPath) {
			return {
				sessionId: "none",
				messageCount: 0,
				userMessages: 0,
				assistantMessages: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
			};
		}
		content = await readFile(sessionPath, "utf-8");
	}
	const { entries, sessionId } = parseSessionEntries(content);

	let messageCount = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let currentModel: string | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message) {
			messageCount++;
			if (entry.message.role === "user") userMessages++;
			if (entry.message.role === "assistant") assistantMessages++;
			if (entry.message.usage) {
				const u = entry.message.usage as {
					inputTokens?: number;
					input?: number;
					outputTokens?: number;
					output?: number;
				};
				totalInputTokens += u.inputTokens || u.input || 0;
				totalOutputTokens += u.outputTokens || u.output || 0;
			}
		}
		if (entry.type === "model_change") {
			currentModel = `${entry.provider}/${entry.modelId}`;
		}
	}

	return {
		sessionId: sessionId || "unknown",
		messageCount,
		userMessages,
		assistantMessages,
		totalInputTokens,
		totalOutputTokens,
		currentModel,
	};
}

export function createAgentHistoryRoutes(deps: {
	connectionManager?: WorkerConnectionManager;
	agentConfigStore?: Pick<AgentConfigStore, "getMetadata">;
	userAgentsStore?: UserAgentsStore;
}) {
	const app = new Hono();
	const { connectionManager } = deps;
	const resolveOwnership = createOwnershipResolver({
		userAgentsStore: deps.userAgentsStore,
		agentMetadataStore: deps.agentConfigStore,
	});

	async function getAuthorizedAgentScope(c: Context): Promise<{
		agentId: string;
		organizationId: string | undefined;
		userId: string;
	} | null> {
		const session = await verifySettingsSession(c);
		if (!session) return null;
		const agentId = c.req.param("agentId") || session.agentId || null;
		if (!agentId || !isSafeAgentId(agentId)) return null;
		const result = await resolveOwnership(session, agentId);
		if (!result.authorized) return null;
		return {
			agentId,
			organizationId: resolveOrgId(result.organizationId) ?? undefined,
			userId: resolveSettingsLookupUserId(session),
		};
	}

	async function resolveActiveAgent(
		agentId: string,
	): Promise<{ connected: boolean; resolvedAgentId: string }> {
		if (
			connectionManager &&
			connectionManager.getDeploymentsForAgent(agentId).length > 0
		) {
			return { connected: true, resolvedAgentId: agentId };
		}
		return { connected: false, resolvedAgentId: agentId };
	}

	async function proxyOrFallback<T>(
		agentId: string,
		workerPath: string,
		fallback: (agentId: string) => Promise<T>,
	): Promise<{ data: T; proxied: boolean } | null> {
		const { resolvedAgentId } = await resolveActiveAgent(agentId);
		const httpUrl = connectionManager?.getHttpUrl(resolvedAgentId);

		if (httpUrl) {
			try {
				const response = await fetch(`${httpUrl}${workerPath}`, {
					signal: AbortSignal.timeout(5000),
				});
				if (response.ok) {
					return { data: (await response.json()) as T, proxied: true };
				}
			} catch {
				// Worker HTTP not reachable, fall through to file read
			}
		}

		try {
			return { data: await fallback(resolvedAgentId), proxied: false };
		} catch (e) {
			logger.debug("Session file fallback failed", {
				error: e,
				agentId: resolvedAgentId,
			});
			return null;
		}
	}

	app.get("/threads", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const threads = await listAgentThreads({
			agentId: scope.agentId,
			organizationId: scope.organizationId,
			userId: scope.userId,
		});
		return c.json({ threads });
	});

	app.get("/threads/:threadId/messages", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const threadId = c.req.param("threadId") || "";
		if (!isSafeThreadId(threadId)) {
			return errorResponse(c, "Invalid thread id", 400);
		}

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 200);

		const data = await readThreadMessages({
			agentId: scope.agentId,
			threadId,
			cursor,
			limit,
			organizationId: scope.organizationId,
			userId: scope.userId,
		});
		return c.json(data);
	});

	app.get("/status", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const { connected, resolvedAgentId } = await resolveActiveAgent(
			scope.agentId,
		);

		let hasSessionFile =
			(await readLatestSnapshotJsonl(resolvedAgentId, scope.organizationId)) !==
			null;
		if (!hasSessionFile) {
			hasSessionFile = !!(await findSessionFile(resolvedAgentId));
		}

		return c.json({
			connected: connected || hasSessionFile,
			hasHttpServer: !!connectionManager?.getHttpUrl(resolvedAgentId),
			deploymentCount: connectionManager
				? connectionManager.getDeploymentsForAgent(resolvedAgentId).length
				: 0,
		});
	});

	app.get("/session/messages", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);

		const result = await proxyOrFallback(
			scope.agentId,
			`/session/messages?cursor=${cursor}&limit=${limit}`,
			(resolved) =>
				readSessionMessages(resolved, cursor, limit, scope.organizationId),
		);

		if (!result) {
			return c.json(
				{
					error: "Agent offline",
					connected: false,
					messages: [],
					nextCursor: null,
					hasMore: false,
				},
				503,
			);
		}

		return c.json(result.data);
	});

	app.get("/session/stats", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);

		const result = await proxyOrFallback(
			scope.agentId,
			"/session/stats",
			(resolved) => readSessionStats(resolved, scope.organizationId),
		);

		if (!result) {
			return c.json({ error: "Agent offline", connected: false }, 503);
		}

		return c.json(result.data);
	});

	return app;
}
