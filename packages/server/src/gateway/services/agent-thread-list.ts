import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeConversationId, titleFromSessionJsonl } from "@lobu/core";
import { filterChannelsForRequester } from "../../authz/channel-visibility.js";
import { type DbClient, getDb } from "../../db/client.js";
import {
	resolveBoundChannelRows,
	stripPlatformPrefix,
} from "../channels/bound-channels.js";
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
	/** Routing key: a thread id for web conversations (chattable), or the raw
	 *  conversation id for platform conversations (read-only). */
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	/** "web" for the app's own threads; "watcher" for watcher activity; otherwise
	 *  the source platform derived from the conversation id prefix (slack, …). */
	platform: string;
	/** Raw conversation id — used to read a platform conversation read-only. */
	conversationId: string;
	/** Set on `platform: "watcher"` entries — routes to the watcher's page. */
	watcherId?: number;
}

/**
 * Platform a conversation originated on, derived from its conversation id.
 * Platform sessions key on a colon-prefixed id (e.g. `slack:{channel}:{ts}`,
 * `telegram:{chat}:{topic}`); the app's own threads use `{agentId}_{userId}_…`
 * (no colon) and are "web".
 */
export function deriveConversationPlatform(conversationId: string): string {
	const colon = conversationId.indexOf(":");
	if (colon > 0) {
		const prefix = conversationId.slice(0, colon).toLowerCase();
		if (/^[a-z][a-z0-9_-]*$/.test(prefix)) return prefix;
	}
	return "web";
}

/** `{platform}:{team}:{channel}` — team-scoped so the same channel id in two
 *  Slack workspaces never collides. `team` is "" for platforms without one. */
function channelVisibilityKey(
	platform: string,
	teamId: string | null,
	bareChannelId: string,
): string {
	return `${platform.toLowerCase()}:${teamId ?? ""}:${bareChannelId}`;
}

export interface ChannelVisibility {
	/** Team-scoped keys the requester may read (per-agent fence ∩ per-user ACL). */
	visibleKeys: Set<string>;
	/** `{platform}:{channel}` → the team ids the AGENT is bound to it in. A
	 *  channel bound in >1 team can't be disambiguated from a conversation id
	 *  alone, so it fails closed. */
	channelTeams: Map<string, Set<string>>;
}

/**
 * Which channels may THIS requester read for THIS agent — the per-agent channel
 * fence (the agent's bound channels) INTERSECTED with the per-user channel ACL
 * gate ({@link filterChannelsForRequester}), team-scoped. A platform conversation
 * is visible iff {@link isConversationVisible}. Mirrors recall's gate so a user
 * never sees a channel transcript they're not a member of.
 */
export async function resolveChannelVisibility(
	sql: DbClient,
	args: { organizationId: string; agentId: string; userId: string | null },
): Promise<ChannelVisibility> {
	const bound = await resolveBoundChannelRows(sql, {
		organizationId: args.organizationId,
		agentId: args.agentId,
	});
	const channelTeams = new Map<string, Set<string>>();
	for (const c of bound) {
		const bare = stripPlatformPrefix(c.platform, c.channel_id);
		const pc = `${c.platform.toLowerCase()}:${bare}`;
		const set = channelTeams.get(pc) ?? new Set<string>();
		set.add(c.team_id ?? "");
		channelTeams.set(pc, set);
	}
	const visible = await filterChannelsForRequester(sql, {
		organizationId: args.organizationId,
		userId: args.userId,
		rows: bound,
	});
	const visibleKeys = new Set(
		visible.map((c) =>
			channelVisibilityKey(
				c.platform,
				c.team_id,
				stripPlatformPrefix(c.platform, c.channel_id),
			),
		),
	);
	return { visibleKeys, channelTeams };
}

/** Can the requester read this platform conversation (`{platform}:{channel}:{thread}`)?
 *  Fail-closed: unbound, or a channel bound in more than one workspace (can't tie
 *  the conversation to a team), is not visible. */
export function isConversationVisible(
	conversationId: string,
	vis: ChannelVisibility,
): boolean {
	const parts = conversationId.split(":");
	const platform = (parts[0] ?? "").toLowerCase();
	const channel = parts[1] ?? "";
	const teams = vis.channelTeams.get(`${platform}:${channel}`);
	if (!teams || teams.size !== 1) return false; // unbound or ambiguous workspace
	const [team] = [...teams];
	return vis.visibleKeys.has(
		channelVisibilityKey(platform, team || null, channel),
	);
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
	/** "user" (default): only the requesting user's app threads. "all": every
	 *  conversation for the agent across platforms (Slack, Telegram, …). */
	scope?: "user" | "all";
}): Promise<AgentThreadSummary[]> {
	const { agentId, organizationId, userId, scope = "user" } = args;
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
				platform: "web",
				conversationId: row.conversation_id,
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
			platform: "web",
			conversationId: workspaceConversationId,
		});
	}

	// "all" scope: also surface this agent's PLATFORM conversations (Slack,
	// Telegram, …). Those key on a colon-prefixed conversation id rather than
	// the `{agentId}_{userId}_…` app-thread prefix, so they're excluded above.
	if (scope === "all" && organizationId) {
		const sql = getDb();
		// ACL: a platform conversation is only listed if its channel is in the
		// agent's bound channels AND (for ACL-graphed connections) the requester
		// is a member — so a user never sees a channel transcript they can't read.
		const channelVis = await resolveChannelVisibility(sql, {
			organizationId,
			agentId,
			userId,
		});
		const platformRows = await sql<{
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
        AND conversation_id LIKE '%:%'
      ORDER BY conversation_id, run_id DESC
    `;
		for (const row of platformRows) {
			if (byThreadId.has(row.conversation_id)) continue;
			if (!isConversationVisible(row.conversation_id, channelVis)) continue;
			const at = row.created_at.getTime();
			byThreadId.set(row.conversation_id, {
				id: row.conversation_id,
				title: titleFromSessionJsonl(
					row.snapshot_jsonl,
					row.conversation_id,
				),
				createdAt: at,
				updatedAt: at,
				platform: deriveConversationPlatform(row.conversation_id),
				conversationId: row.conversation_id,
			});
		}

		// One entry per WATCHER (not per run) — its latest run time + name, so the
		// activity panel can show watcher activity alongside chats and route to the
		// watcher's page.
		const watcherRows = await sql<{
			watcher_id: number;
			name: string | null;
			last_at: Date;
		}>`
      SELECT w.id AS watcher_id, w.name, mx.last_at
      FROM (
        SELECT (regexp_match(conversation_id, '_watcher_([0-9]+)_run_'))[1]::int AS watcher_id,
               max(created_at) AS last_at
        FROM public.agent_transcript_snapshot
        WHERE organization_id = ${organizationId}
          AND agent_id = ${agentId}
          AND terminal_status = 'completed'
          AND conversation_id LIKE '%\\_watcher\\_%\\_run\\_%'
        GROUP BY 1
      ) mx
      JOIN public.watchers w ON w.id = mx.watcher_id
    `;
		for (const row of watcherRows) {
			const key = `watcher_${row.watcher_id}`;
			const at = row.last_at.getTime();
			byThreadId.set(key, {
				id: key,
				title: row.name ?? `Watcher ${row.watcher_id}`,
				createdAt: at,
				updatedAt: at,
				platform: "watcher",
				conversationId: key,
				watcherId: row.watcher_id,
			});
		}
	}

	return [...byThreadId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Read one conversation's messages by its RAW conversation id (e.g. a platform
 * thread `slack:{channel}:{ts}`). Read-only — used to render platform
 * conversations that aren't routable through the app chat composer.
 */
export async function readConversationMessages(args: {
	agentId: string;
	organizationId: string;
	conversationId: string;
	cursor: string;
	limit: number;
}) {
	const { agentId, organizationId, conversationId, cursor, limit } = args;
	const jsonl = await readSnapshotJsonl({
		agentId,
		organizationId,
		conversationId,
	});
	if (jsonl === null) {
		return {
			messages: [],
			nextCursor: null,
			hasMore: false,
			sessionId: conversationId,
			threadId: conversationId,
		};
	}
	return {
		...paginateSessionMessages(jsonl, cursor, limit, {
			excludeVerbose: true,
			sessionIdFallback: conversationId,
		}),
		threadId: conversationId,
	};
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
