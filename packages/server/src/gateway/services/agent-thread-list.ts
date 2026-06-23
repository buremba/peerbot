import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeConversationId, titleFromSessionJsonl } from "@lobu/core";
import { getDb } from "../../db/client.js";
import {
	buildApiConversationId,
	extractThreadIdFromConversationId,
	isUserOwnedApiConversationId,
} from "./api-conversation-id.js";
import { paginateSessionMessages } from "./session-message-page.js";
import { readSnapshotJsonl } from "./transcript-snapshot.js";

const SAFE_AGENT_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_THREAD_ID = /^[a-zA-Z0-9_-]+$/;

function isSafeAgentId(id: string): boolean {
	return SAFE_AGENT_ID.test(id);
}

function isSafeThreadId(id: string): boolean {
	return SAFE_THREAD_ID.test(id);
}

export interface AgentThreadSummary {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
}

async function findConversationSessionFile(
	agentId: string,
	conversationId: string,
): Promise<string | null> {
	if (!isSafeAgentId(agentId)) return null;
	const workspacesRoot = resolve("workspaces");
	const workspaceDir = resolve(workspacesRoot, agentId);
	if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return null;

	const sanitized = sanitizeConversationId(conversationId);
	const sessionPath = join(
		workspaceDir,
		sanitized,
		".openclaw",
		"session.jsonl",
	);
	try {
		await stat(sessionPath);
		return sessionPath;
	} catch {
		return null;
	}
}

async function listWorkspaceConversationIds(
	agentId: string,
): Promise<string[]> {
	if (!isSafeAgentId(agentId)) return [];
	const workspacesRoot = resolve("workspaces");
	const workspaceDir = resolve(workspacesRoot, agentId);
	if (!workspaceDir.startsWith(`${workspacesRoot}/`)) return [];

	try {
		const entries = await readdir(workspaceDir, { withFileTypes: true });
		const ids: string[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const sessionPath = join(
				workspaceDir,
				entry.name,
				".openclaw",
				"session.jsonl",
			);
			try {
				await stat(sessionPath);
				ids.push(entry.name);
			} catch {
				// not a conversation workspace
			}
		}
		return ids;
	} catch {
		return [];
	}
}

export async function listAgentThreads(args: {
	agentId: string;
	organizationId?: string;
	userId: string;
}): Promise<AgentThreadSummary[]> {
	const { agentId, organizationId, userId } = args;
	const conversationPrefix = organizationId
		? `${agentId}_${userId}_${organizationId}_`
		: `${agentId}_${userId}_`;

	const byThreadId = new Map<string, AgentThreadSummary>();

	if (organizationId) {
		const sql = getDb();
		const rows = await sql<{
			conversation_id: string;
			snapshot_jsonl: string;
			created_at: Date;
		}>`
      SELECT DISTINCT ON (conversation_id)
        conversation_id, snapshot_jsonl, created_at
      FROM public.agent_transcript_snapshot
      WHERE organization_id = ${organizationId}
        AND agent_id = ${agentId}
        AND terminal_status = 'completed'
        AND conversation_id LIKE ${`${conversationPrefix}%`}
      ORDER BY conversation_id, run_id DESC
    `;

		for (const row of rows) {
			const threadId = extractThreadIdFromConversationId(
				row.conversation_id,
				agentId,
				userId,
				organizationId,
			);
			if (!threadId || !isSafeThreadId(threadId)) continue;
			const at = row.created_at.getTime();
			byThreadId.set(threadId, {
				id: threadId,
				title: titleFromSessionJsonl(
					row.snapshot_jsonl,
					`Conversation ${byThreadId.size + 1}`,
				),
				createdAt: at,
				updatedAt: at,
			});
		}
	}

	for (const workspaceConversationId of await listWorkspaceConversationIds(
		agentId,
	)) {
		if (
			!isUserOwnedApiConversationId(
				workspaceConversationId,
				agentId,
				userId,
				organizationId,
			)
		) {
			continue;
		}
		const threadId = extractThreadIdFromConversationId(
			workspaceConversationId,
			agentId,
			userId,
			organizationId,
		);
		if (!threadId || !isSafeThreadId(threadId) || byThreadId.has(threadId)) {
			continue;
		}
		const sessionPath = await findConversationSessionFile(
			agentId,
			workspaceConversationId,
		);
		if (!sessionPath) continue;
		const content = await readFile(sessionPath, "utf-8");
		const at = (await stat(sessionPath)).mtimeMs;
		byThreadId.set(threadId, {
			id: threadId,
			title: titleFromSessionJsonl(
				content,
				`Conversation ${byThreadId.size + 1}`,
			),
			createdAt: at,
			updatedAt: at,
		});
	}

	return [...byThreadId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversationTranscriptJsonl(
	agentId: string,
	organizationId: string | undefined,
	conversationId: string,
): Promise<string | null> {
	const fromDb = await readSnapshotJsonl({
		agentId,
		organizationId,
		conversationId,
	});
	if (fromDb !== null) return fromDb;

	const sessionPath = await findConversationSessionFile(
		agentId,
		conversationId,
	);
	if (!sessionPath) return null;
	return readFile(sessionPath, "utf-8");
}

export async function readThreadMessages(args: {
	agentId: string;
	threadId: string;
	cursor: string;
	limit: number;
	organizationId?: string;
	userId: string;
}) {
	const { agentId, threadId, cursor, limit, organizationId, userId } = args;
	const conversationId = buildApiConversationId({
		agentId,
		userId,
		organizationId,
		threadId,
	});

	const content = await loadConversationTranscriptJsonl(
		agentId,
		organizationId,
		conversationId,
	);
	if (content === null) {
		return {
			messages: [],
			nextCursor: null,
			hasMore: false,
			sessionId: conversationId,
			threadId,
		};
	}

	return {
		...paginateSessionMessages(content, cursor, limit, {
			excludeVerbose: true,
			sessionIdFallback: conversationId,
		}),
		threadId,
	};
}
