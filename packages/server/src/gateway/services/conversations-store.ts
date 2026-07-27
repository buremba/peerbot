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
	/**
	 * Routable id, when the origin has one distinct from `conversationId` (a web
	 * thread's suffix). Omit/null when the conversation is routed by its
	 * `conversationId` — readers resolve `threadId ?? conversationId`.
	 */
	threadId?: string | null;
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
	// getDb() inside the try: it throws when DATABASE_URL is unset (or the pool
	// can't init), and a listing-materialization hiccup must never fail a live
	// turn — so the swallow below must cover the client acquisition too, not just
	// the query.
	try {
		const sql = getDb();
		await sql`
      INSERT INTO public.conversations (
        organization_id, agent_id, platform, conversation_id, thread_id,
        kind, user_id, title, last_activity_at
      ) VALUES (
        ${row.organizationId}, ${row.agentId}, ${row.platform},
        ${row.conversationId}, ${row.threadId ?? null}, ${row.kind},
        ${row.userId ?? null}, ${row.title ?? null}, ${row.lastActivityAt}
      )
      ON CONFLICT (organization_id, agent_id, platform, conversation_id)
      DO UPDATE SET
        last_activity_at = GREATEST(
          public.conversations.last_activity_at, EXCLUDED.last_activity_at
        ),
        -- keep the earliest known non-null title/user/thread; don't clobber with null
        title = COALESCE(public.conversations.title, EXCLUDED.title),
        user_id = COALESCE(public.conversations.user_id, EXCLUDED.user_id),
        thread_id = COALESCE(public.conversations.thread_id, EXCLUDED.thread_id),
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

export interface ConversationListRow {
	platform: string;
	conversationId: string;
	/**
	 * Routable id for this conversation, stored at write time by the origin that
	 * knows it. NULL means "route by `conversationId`" — so readers resolve the
	 * route as `threadId ?? conversationId` without parsing the id string or
	 * branching on `kind`.
	 */
	threadId: string | null;
	kind: ConversationKind;
	userId: string | null;
	title: string | null;
	lastActivityAt: Date;
	createdAt: Date;
}

/**
 * Read one conversation row by its full PK. Returns null when the row does not
 * exist (or is soft-deleted). The single get source, mirroring
 * {@link listConversations}'s read of the materialized entity.
 */
export async function getConversation(args: {
	organizationId: string;
	agentId: string;
	platform: string;
	conversationId: string;
}): Promise<ConversationListRow | null> {
	const { organizationId, agentId, platform, conversationId } = args;
	const sql = getDb();
	const rows = await sql<{
		platform: string;
		conversation_id: string;
		thread_id: string | null;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, thread_id, kind, user_id, title,
           last_activity_at, created_at
    FROM public.conversations
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND platform = ${platform}
      AND conversation_id = ${conversationId}
      AND archived_at IS NULL
    LIMIT 1
  `;
	const r = rows[0];
	if (!r) return null;
	return {
		platform: r.platform,
		conversationId: r.conversation_id,
		threadId: r.thread_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	};
}

/**
 * A turn's terminal outcome, read from the durable `runs` thread-response rows
 * the worker writes on completion. Cross-replica-safe (Postgres, not the
 * pod-local SSE buffer) — so `conversations.send({ wait: true })` can await a
 * reply without holding an SSE socket.
 */
export type ConversationReply =
	| { status: "complete"; text: string }
	| { status: "error"; error: string };

/**
 * Poll for the terminal outcome of a dispatched message. Matches the completion
 * row the worker writes to `public.runs` (queue_name='thread_response') whose
 * payload lists `messageId` in `processedMessageIds` (a turn can batch several).
 * Returns null while the turn is still in flight. `finalText` carries the full
 * assistant reply on the terminal row (see ThreadResponsePayload.finalText).
 */
export async function readConversationReply(args: {
	organizationId: string;
	conversationId: string;
	messageId: string;
}): Promise<ConversationReply | null> {
	const { organizationId, conversationId, messageId } = args;
	const sql = getDb();
	const rows = await sql<{ payload: Record<string, unknown> | null }>`
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
        AND status IN ('completed', 'failed')
        AND action_input IS NOT NULL
    )
    SELECT payload
    FROM response_rows
    WHERE payload->>'conversationId' = ${conversationId}
      AND (
        payload->>'messageId' = ${messageId}
        OR payload->'processedMessageIds' ? ${messageId}
      )
      AND (payload ? 'error' OR payload ? 'processedMessageIds')
    ORDER BY id DESC
    LIMIT 1
  `;
	const payload = rows[0]?.payload;
	if (!payload || typeof payload !== "object") return null;
	if (typeof payload.error === "string" && payload.error.length > 0) {
		return { status: "error", error: payload.error };
	}
	const finalText =
		typeof payload.finalText === "string" ? payload.finalText : "";
	return { status: "complete", text: finalText };
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
		thread_id: string | null;
		kind: ConversationKind;
		user_id: string | null;
		title: string | null;
		last_activity_at: Date | null;
		created_at: Date;
	}>`
    SELECT platform, conversation_id, thread_id, kind, user_id, title,
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
		threadId: r.thread_id,
		kind: r.kind,
		userId: r.user_id,
		title: r.title,
		lastActivityAt: r.last_activity_at ?? r.created_at,
		createdAt: r.created_at,
	}));
}
