/**
 * Agent history routes — proxy session data from worker HTTP server,
 * with direct session-file fallback for embedded dev mode, plus
 * per-thread list/message endpoints for the web-panel chat UI.
 * Auth: settings session cookie (verifySettingsSession).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigStore, ParsedMessage } from "@lobu/core";
import {
	AGENT_ERRORS,
	createLogger,
	entryToMessage,
	parseSessionEntries,
	toAgentErrorCode,
} from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { getDb } from "../../../db/client.js";
import { buildApiConversationId } from "../../services/api-conversation-id.js";
import type { ArtifactStore } from "../../files/artifact-store.js";
import { resolveOrgId } from "../../../lobu/stores/org-context.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { WorkerConnectionManager } from "../../gateway/connection-manager.js";
import {
	isConversationVisible,
	listAgentThreads,
	readConversationMessages,
	readThreadMessages,
	resolveChannelVisibility,
} from "../../services/agent-thread-list.js";
import { readWatcherRunThreads } from "../../services/watcher-run-thread.js";
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

type ToolApprovalHistoryInteraction = {
	type: "tool-approval";
	runId: number;
	action: string | null;
	proposal: Record<string, unknown> | null;
	current: Record<string, unknown> | null;
	fields: Record<string, unknown> | null;
	attribution: string | null;
};

type AgentErrorHistoryInteraction = {
	type: "agent-error";
	runId: number;
	error: string;
	errorCode: string | null;
	errorContext: { provider?: string; model?: string } | null;
};

type HistoryInteraction =
	| ToolApprovalHistoryInteraction
	| AgentErrorHistoryInteraction;

async function readLatestAgentErrorInteraction(
	organizationId: string,
	conversationId: string,
): Promise<AgentErrorHistoryInteraction | null> {
	const rows = await getDb()<{
		id: number;
		payload: Record<string, unknown> | null;
	}>`
		WITH response_rows AS (
			SELECT id,
			       CASE
			         WHEN jsonb_typeof(action_input) = 'string'
			           THEN (action_input #>> '{}')::jsonb
			         ELSE action_input
			       END AS payload
			FROM public.runs
			WHERE organization_id = ${organizationId}
			  AND run_type = 'chat_message'
			  AND queue_name = 'thread_response'
			  AND status IN ('pending', 'completed', 'failed')
			  AND action_input IS NOT NULL
		)
		SELECT id, payload
		FROM response_rows
		WHERE payload->>'conversationId' = ${conversationId}
		  AND (payload ? 'error' OR payload ? 'processedMessageIds')
		ORDER BY id DESC
		LIMIT 1
	`;
	const row = rows[0];
	if (!row?.payload || typeof row.payload !== "object") return null;

	// A newer successful terminal row supersedes any older error for the thread.
	if (typeof row.payload.error !== "string") return null;
	const code = toAgentErrorCode(row.payload.errorCode);
	const spec = code ? AGENT_ERRORS[code] : undefined;
	if (spec?.silent) return null;
	const error = spec?.message ?? row.payload.error;
	if (!error) return null;

	const rawContext =
		row.payload.errorContext &&
		typeof row.payload.errorContext === "object" &&
		!Array.isArray(row.payload.errorContext)
			? (row.payload.errorContext as Record<string, unknown>)
			: null;
	const provider =
		typeof rawContext?.provider === "string" ? rawContext.provider : undefined;
	const model =
		typeof rawContext?.model === "string" ? rawContext.model : undefined;
	const errorContext =
		provider || model
			? {
					...(provider ? { provider } : {}),
					...(model ? { model } : {}),
				}
			: null;

	return {
		type: "agent-error",
		runId: Number(row.id),
		error,
		errorCode: code ?? null,
		errorContext,
	};
}

// Tokenless artifact references persisted in the transcript by the message-send
// path (`[name](/api/v1/files/:id)`). They carry no expiring credential, so the
// history read path re-signs them with a fresh, absolute download URL on every
// load — keeping links live across reloads without ever persisting a token.
// Matches the path only when NOT already followed by a query string (so an
// already-signed link is left untouched).
const TOKENLESS_FILE_REF = /\/api\/v1\/files\/([A-Za-z0-9._~-]+)(?![A-Za-z0-9._~?-])/g;

/**
 * Recursively rewrite tokenless `/api/v1/files/:id` references in a user
 * message's persisted content into fresh, absolute, signed download URLs.
 * Exported for unit testing.
 */
export function resignFileRefs(
	content: unknown,
	artifactStore: ArtifactStore,
	publicGatewayUrl: string,
): unknown {
	if (typeof content === "string") {
		return content.replace(TOKENLESS_FILE_REF, (_match, artifactId: string) =>
			artifactStore.buildDownloadUrl(publicGatewayUrl, artifactId),
		);
	}
	if (Array.isArray(content)) {
		return content.map((entry) =>
			resignFileRefs(entry, artifactStore, publicGatewayUrl),
		);
	}
	if (content && typeof content === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(content)) {
			out[key] = resignFileRefs(value, artifactStore, publicGatewayUrl);
		}
		return out;
	}
	return content;
}

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
	artifactStore?: ArtifactStore;
	publicGatewayUrl?: string;
}) {
	const app = new Hono();
	const { connectionManager, artifactStore, publicGatewayUrl } = deps;
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

		// `?scope=all` widens the list to every conversation for the agent across
		// platforms (Slack, Telegram, …), not just the requesting user's threads.
		const listScope = c.req.query("scope") === "all" ? "all" : "user";
		const threads = await listAgentThreads({
			agentId: scope.agentId,
			organizationId: scope.organizationId,
			userId: scope.userId,
			scope: listScope,
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

		// Re-sign tokenless attachment references in user messages so their
		// download links are valid for this session (the transcript stores them
		// tokenless and portable; see `resignFileRefs`).
		if (artifactStore && publicGatewayUrl && Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content: resignFileRefs(
								message.content,
								artifactStore,
								publicGatewayUrl,
							),
						}
					: message,
			);
		}

		// Replay durable interaction cards the transcript doesn't carry (today the
		// builder's manage_agents write-gate approval). Reconstruct the session
		// conversationId the worker stamped (same parts), then read the still-
		// pending approval events. Self-cleaning: a resolved approval is
		// superseded out of current_event_records. Without this the interactive
		// approval card is lost on reload — only the model's text + link survive.
		let interactions: HistoryInteraction[] = [];
		if (scope.organizationId) {
			const conversationId = buildApiConversationId({
				agentId: scope.agentId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				threadId,
			});
			const rows = await getDb()<{
				run_id: number;
				action: string | null;
				proposal: Record<string, unknown> | null;
				current: Record<string, unknown> | null;
				fields: Record<string, unknown> | null;
				attribution: string | null;
			}>`
				SELECT run_id,
				       metadata->>'action' AS action,
				       metadata->'proposal' AS proposal,
				       metadata->'current' AS current,
				       -- entity_field_change (manage_entity) carries the
				       -- human-owned-field diff + attribution; manage_agents
				       -- leaves these null and replays its agent-row proposal.
				       metadata->'fields' AS fields,
				       metadata->>'attribution' AS attribution
				FROM current_event_records
				WHERE organization_id = ${scope.organizationId}
				  AND interaction_type = 'approval'
				  AND interaction_status = 'pending'
				  AND metadata->>'conversationId' = ${conversationId}
				ORDER BY run_id
			`;
			interactions = rows.map((r) => ({
				type: "tool-approval" as const,
				runId: Number(r.run_id),
				action: r.action,
				proposal: r.proposal ?? null,
				current: r.current ?? null,
				fields: r.fields ?? null,
				attribution: r.attribution ?? null,
			}));
			const errorInteraction = await readLatestAgentErrorInteraction(
				scope.organizationId,
				conversationId,
			);
			if (errorInteraction) interactions.push(errorInteraction);
		}
		return c.json({ ...data, interactions });
	});

	// Read a PLATFORM conversation (e.g. `slack:{channel}:{ts}`) read-only by its
	// raw conversation id. The id carries colons, so it's URL-encoded in the path.
	app.get("/conversations/:conversationId/messages", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);
		if (!scope.organizationId) return c.json({ messages: [] });

		const conversationId = decodeURIComponent(c.req.param("conversationId") || "");
		// Platform conversation ids are `{platform}:{...}` — alnum/._:- only.
		if (!conversationId || !/^[a-zA-Z0-9._:-]+$/.test(conversationId)) {
			return errorResponse(c, "Invalid conversation id", 400);
		}

		// ACL: the requester must be able to read this conversation's channel —
		// the same per-agent fence ∩ per-user channel gate the listing applies.
		// Fail closed (404, not 403) so an unauthorized id is indistinguishable
		// from a non-existent one.
		const channelVis = await resolveChannelVisibility(getDb(), {
			organizationId: scope.organizationId,
			agentId: scope.agentId,
			userId: scope.userId,
		});
		if (!isConversationVisible(conversationId, channelVis)) {
			return errorResponse(c, "Conversation not found", 404);
		}

		const cursor = c.req.query("cursor") || "";
		const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 200);

		const data = await readConversationMessages({
			agentId: scope.agentId,
			organizationId: scope.organizationId,
			conversationId,
			cursor,
			limit,
		});
		if (artifactStore && publicGatewayUrl && Array.isArray(data.messages)) {
			data.messages = data.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content: resignFileRefs(
								message.content,
								artifactStore,
								publicGatewayUrl,
							),
						}
					: message,
			);
		}
		return c.json(data);
	});

	// A watcher's recent completed runs as ready-to-stitch transcripts — the
	// read-only run history rendered as one conversation. Watcher conversation
	// ids are org-less but the snapshot row carries the org; the service bridges
	// that, so we just hand it the requester's resolved org.
	app.get("/watchers/:watcherId/thread", async (c) => {
		const scope = await getAuthorizedAgentScope(c);
		if (!scope) return errorResponse(c, "Unauthorized", 401);
		if (!scope.organizationId) return c.json({ runs: [] });

		const watcherId = Number(c.req.param("watcherId"));
		if (!Number.isFinite(watcherId)) {
			return errorResponse(c, "Invalid watcher id", 400);
		}
		const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);

		const data = await readWatcherRunThreads({
			agentId: scope.agentId,
			watcherId,
			organizationId: scope.organizationId,
			limit,
		});
		if (artifactStore && publicGatewayUrl) {
			for (const run of data.runs) {
				run.messages = run.messages.map((message) =>
					message.role === "user"
						? {
								...message,
								content: resignFileRefs(
									message.content,
									artifactStore,
									publicGatewayUrl,
								),
							}
						: message,
				);
			}
		}
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
