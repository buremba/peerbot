import { createLogger } from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("conversations-store");

/** A conversation's origin class, mirroring how the listing partitions ids. */
export type ConversationKind = "owned" | "platform";

/** Watcher conversation id shape: `{agentId}_watcher_{id}_run_{runId}`. These
 *  stay derived from `agent_transcript_snapshot` (one sidebar entry per WATCHER,
 *  not per run) and must NEVER get a `conversations` row. */
const WATCHER_CONVERSATION_ID = /_watcher_\d+_run_\d+$/;

export function isWatcherConversationId(conversationId: string): boolean {
	return WATCHER_CONVERSATION_ID.test(conversationId);
}

/**
 * Derive a conversation's stored (kind, platform) from the EXPLICIT dispatch
 * platform — never by parsing the id string. The app's own threads dispatch with
 * `platform: "api"` (the marker the whole gateway already gates on, e.g.
 * interactions.ts:57, unified-thread-consumer.ts:391) and are stored as
 * ('owned', 'web'); every other platform is a real external channel stored as
 * ('platform', <platform>). Returning both from one place keeps kind and the
 * stored platform from drifting apart at the call site. Watcher ids are filtered
 * out BEFORE this by {@link isWatcherConversationId}.
 */
export function classifyConversation(platform: string): {
	kind: ConversationKind;
	storedPlatform: string;
} {
	// Lowercase-canonicalize the stored platform. platform is part of the
	// conversations PK, so a connector that ever emitted, say, 'Slack' would
	// otherwise land a duplicate row alongside a 'slack' one.
	const p = platform.toLowerCase();
	return p === "api"
		? { kind: "owned", storedPlatform: "web" }
		: { kind: "platform", storedPlatform: p };
}

export interface ConversationUpsert {
	organizationId: string;
	agentId: string;
	platform: string;
	conversationId: string;
	kind: ConversationKind;
	userId?: string | null;
	title?: string | null;
	lastActivityAt: Date;
}

/**
 * Materialize (or refresh) the `conversations` row for a turn. Called on every
 * dispatch that starts a turn — the row is the single listing source. Idempotent:
 * the first turn INSERTs, later turns bump `last_activity_at` and fill in a
 * newly-known `title`/`user_id` without clobbering earlier non-null values.
 * Failures are swallowed — a listing-materialization hiccup must never fail a
 * live turn.
 */
export async function upsertConversation(
	row: ConversationUpsert,
): Promise<void> {
	const sql = getDb();
	try {
		await sql`
      INSERT INTO public.conversations (
        organization_id, agent_id, platform, conversation_id,
        kind, user_id, title, last_activity_at
      ) VALUES (
        ${row.organizationId}, ${row.agentId}, ${row.platform},
        ${row.conversationId}, ${row.kind},
        ${row.userId ?? null}, ${row.title ?? null}, ${row.lastActivityAt}
      )
      ON CONFLICT (organization_id, agent_id, platform, conversation_id)
      DO UPDATE SET
        last_activity_at = GREATEST(
          public.conversations.last_activity_at, EXCLUDED.last_activity_at
        ),
        -- keep the earliest known non-null title/user; don't clobber with null
        title = COALESCE(public.conversations.title, EXCLUDED.title),
        user_id = COALESCE(public.conversations.user_id, EXCLUDED.user_id),
        updated_at = now()
    `;
	} catch (err) {
		logger.warn(
			{
				err,
				organizationId: row.organizationId,
				agentId: row.agentId,
				conversationId: row.conversationId,
			},
			"upsertConversation failed — listing row not materialized for this turn",
		);
	}
}

/**
 * Extract the web thread id from an owned conversation's packed id, given the
 * row's OWN (agentId, userId, organizationId) columns. This is a deterministic
 * prefix strip from known columns — NOT the fuzzy reverse-parse the old
 * `extractThreadIdFromConversationId` heuristic did against the raw id string.
 *
 * Web ids are `{agentId}_{userId}_{organizationId}_{threadId}`. Returns null for
 * the prefix-only "default thread" id (no `{threadId}` suffix), which the
 * sidebar does not list — matching legacy behavior.
 */
export function webThreadIdFromConversationId(
	conversationId: string,
	agentId: string,
	userId: string,
	organizationId: string,
): string | null {
	const prefix = `${agentId}_${userId}_${organizationId}_`;
	if (!conversationId.startsWith(prefix)) return null;
	const suffix = conversationId.slice(prefix.length);
	return suffix.length > 0 ? suffix : null;
}

export interface ConversationListRow {
	platform: string;
	conversationId: string;
	kind: ConversationKind;
	userId: string | null;
	title: string | null;
	lastActivityAt: Date;
	createdAt: Date;
}

/**
 * List an agent's conversations for the sidebar, newest-first. The single
 * listing source: reads the materialized entity instead of deriving from
 * `DISTINCT ON (conversation_id) FROM agent_transcript_snapshot`.
 *
 * Returns owned + platform rows; the caller layers on per-conversation
 * visibility (platform ACL) and stitches in the derived watcher entries.
 */
export async function listConversations(args: {
	organizationId: string;
	agentId: string;
	/** "user": only this user's owned conversations. "all": every conversation. */
	scope: "user" | "all";
	userId: string;
}): Promise<ConversationListRow[]> {
	const { organizationId, agentId, scope, userId } = args;
	const sql = getDb();
	const rows = await sql<{
		platform: string;
		conversation_id: string;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, kind, user_id, title,
           last_activity_at, created_at
    FROM public.conversations
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND archived_at IS NULL
      ${
				scope === "user"
					? sql`AND kind = 'owned' AND user_id = ${userId}`
					: sql``
			}
    ORDER BY last_activity_at DESC NULLS LAST, created_at DESC
  `;
	return rows.map((r) => ({
		platform: r.platform,
		conversationId: r.conversation_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	}));
}
