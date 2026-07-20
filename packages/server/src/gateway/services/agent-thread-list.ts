import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeConversationId } from "@lobu/core";
import { filterChannelsForRequester } from "../../authz/channel-visibility.js";
import { type DbClient, getDb } from "../../db/client.js";
import {
	resolveBoundChannelRows,
	stripPlatformPrefix,
} from "../channels/bound-channels.js";
import { buildApiConversationId } from "./api-conversation-id.js";
import {
	listConversations,
	webThreadIdFromConversationId,
} from "./conversations-store.js";
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
	/** "web" for the app's own threads; "behavior" for behavior activity; otherwise
	 *  the source platform derived from the conversation id prefix (slack, …). */
	platform: string;
	/** Raw conversation id — used to read a platform conversation read-only. */
	conversationId: string;
	/** Set on `platform: "behavior"` entries — routes to the behavior's page. */
	behaviorId?: number;
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
 *  Fail-closed: unbound, or a channel bound in ≥2 DISTINCT REAL workspaces (can't
 *  tie the conversation to a single team), is not visible.
 *
 *  A NULL/"" team is a WILDCARD ("workspace unknown yet" — a binding written
 *  before its workspace healed from the first inbound event), NOT a distinct
 *  workspace. `team_id` is now guaranteed to be a real workspace or NULL (never a
 *  Grid enterprise id), so the gate needs zero connector knowledge: it counts
 *  distinct non-null teams and only fails closed on genuine cross-workspace
 *  ambiguity (2+ real teams). One real team + any number of NULLs resolves to
 *  that team; all-NULL resolves via the wildcard visible key. */
export function isConversationVisible(
	conversationId: string,
	vis: ChannelVisibility,
): boolean {
	const parts = conversationId.split(":");
	const platform = (parts[0] ?? "").toLowerCase();
	const channel = parts[1] ?? "";
	const teams = vis.channelTeams.get(`${platform}:${channel}`);
	if (!teams || teams.size === 0) return false; // unbound
	const realTeams = [...teams].filter((t) => t !== "");
	if (realTeams.length > 1) return false; // genuine cross-workspace ambiguity
	// One real team (NULLs are wildcards that resolve to it), or all-NULL (a
	// teamless/unknown-yet binding — resolves via the "" wildcard visible key).
	const team = realTeams[0] ?? null;
	return vis.visibleKeys.has(channelVisibilityKey(platform, team, channel));
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
		".lobu",
		"session.jsonl",
	);
	try {
		await stat(sessionPath);
		return sessionPath;
	} catch {
		return null;
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
	// No org → no tenant scope → nothing to list from the (org-keyed) entity.
	if (!organizationId) return [];

	const byKey = new Map<string, AgentThreadSummary>();

	// Owned + platform conversations come from the `conversations` entity — the
	// single listing source. This replaces the old
	// `DISTINCT ON (conversation_id) FROM agent_transcript_snapshot` derive path
	// AND the workspace-directory scan.
	const rows = await listConversations({
		organizationId,
		agentId,
		scope,
		userId,
	});

	// Platform ("all" scope) rows are ACL-gated: a platform conversation is only
	// listed if its channel is in the agent's bound channels AND (for ACL-graphed
	// connections) the requester is a member — so a user never sees a channel
	// transcript they can't read.
	let channelVis: ChannelVisibility | null = null;
	if (scope === "all") {
		channelVis = await resolveChannelVisibility(getDb(), {
			organizationId,
			agentId,
			userId,
		});
	}

	for (const row of rows) {
		const at = row.lastActivityAt.getTime();
		const createdAt = row.createdAt.getTime();
		if (row.kind === "owned") {
			const threadId = webThreadIdFromConversationId(
				row.conversationId,
				agentId,
				userId,
				organizationId,
			);
			// Prefix-only "default thread" ids carry no routable thread id and were
			// never listed by the legacy path either — skip them.
			if (!threadId || !isSafeThreadId(threadId) || byKey.has(threadId)) {
				continue;
			}
			byKey.set(threadId, {
				id: threadId,
				title: row.title ?? `Conversation ${byKey.size + 1}`,
				createdAt,
				updatedAt: at,
				platform: "web",
				conversationId: row.conversationId,
			});
		} else if (row.kind === "platform") {
			// One entry per conversationId — that's the whole identity of a platform
			// conversation (the connection that delivered it is routing, not identity;
			// a reconnect changes it without changing the conversation). The ACL and
			// transcript read address it by conversationId alone, consistent with this.
			//
			// isConversationVisible extracts platform:channel from the id, so an
			// opaque/no-colon platform id fails closed (unlisted) — same as the prior
			// path, which only ever listed `LIKE '%:%'` platform ids. Failing closed
			// is safe; the same-channel-across-two-workspaces (Grid) case is likewise
			// handled by isConversationVisible failing closed on team ambiguity.
			if (byKey.has(row.conversationId)) continue;
			if (channelVis && !isConversationVisible(row.conversationId, channelVis)) {
				continue;
			}
			byKey.set(row.conversationId, {
				id: row.conversationId,
				title: row.title ?? row.conversationId,
				createdAt,
				updatedAt: at,
				// Label from the EXPLICIT stored platform, not by parsing the id — an
				// opaque/no-colon platform id (e.g. gchat spaces_A_threads_B) would
				// otherwise mislabel as "web".
				platform: row.platform,
				conversationId: row.conversationId,
			});
		}
	}

	// Watcher activity stays DERIVED from transcript snapshots — one entry per
	// WATCHER (not per run), its latest run time + name, so the activity panel
	// can route to the watcher's page. Watcher runs deliberately get no
	// `conversations` row (their id is globally unique and downstream correlation
	// relies on the raw `..._watcher_<id>_run_<id>` shape).
	if (scope === "all") {
		const sql = getDb();
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
			byKey.set(key, {
				id: key,
				title: row.name ?? `Behavior ${row.watcher_id}`,
				createdAt: at,
				updatedAt: at,
				platform: "behavior",
				conversationId: key,
				behaviorId: row.watcher_id,
			});
		}
	}

	return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
