import {
  createLogger,
  type SuggestedPrompt,
  sanitizeSuggestionPrompts,
} from "@lobu/core";
import type { DbClient } from "../../db/client.js";
import { getDb, pgTextArray } from "../../db/client.js";
import { insertEvent } from "../../utils/insert-event.js";

const logger = createLogger("persist-suggestion");

/**
 * Advisory-lock namespace for suggestion supersession. Distinct from the
 * event-dedup namespace so the two lock spaces never collide on a shared key.
 */
const SUGGESTION_LOCK_NAMESPACE = 0x5355 /* "SU" */;

/**
 * FNV-1a hash of an org-scoped subject → int4 advisory-lock key. Same pattern
 * as `eventDedupLockKey`. Including the organization prevents every tenant's
 * shared system-agent id from serializing on one global starter lock.
 */
function suggestionLockKey(subject: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < subject.length; i++) {
    hash ^= subject.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

export interface PersistSuggestionArgs {
  organizationId: string;
  conversationId: string;
  prompts: SuggestedPrompt[];
  /** The per-run token's `messageId` — stamps which turn owns these chips so
   * completion can tell "this turn's suggestions" from a stale prior set. */
  turnMessageId?: string;
  runId?: number | null;
}

/**
 * Persist the conversation's CURRENT suggestion set as a superseding
 * `interaction_type='suggestion'` event, replacing any prior current row for
 * the same conversation. Returns the new event id.
 *
 * Why explicit-supersede instead of insertEvent's origin-based path: that path
 * bails when `connectionId` is falsy (insert-event.ts findCurrentEventByOrigin),
 * which is exactly the API/Builder case. We take a per-conversation advisory
 * lock (cluster-global, so replica-safe) and pass the prior row's id as
 * `supersedesEventId` — approvals' `supersedeActionEvent` takes no lock and
 * leans on a unique index, but the "both replicas see no live row → two current
 * rows" race is NOT caught by a unique index, so the lock is mandatory here.
 */
export async function persistSuggestion(
  args: PersistSuggestionArgs,
): Promise<number> {
  const { organizationId, conversationId, prompts, turnMessageId, runId } =
    args;

  return getDb().begin(async (tx: DbClient) => {
    // Serialize concurrent writers for this conversation (duplicate queue
    // redeliveries, parallel tool calls in one turn) across all replicas.
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      `${organizationId}:suggestion:${conversationId}`,
    )})`;

    const priorRows = (await tx`
      SELECT id
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND interaction_status = 'current'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
    `) as Array<{ id: number }>;
    const supersedesEventId = priorRows[0]?.id ?? null;

    const event = await insertEvent(
      {
        entityIds: [],
        organizationId,
        // Stable per-conversation origin — useful for lookups; supersession is
        // driven explicitly by supersedesEventId, not this origin.
        originId: `suggestion:${conversationId}`,
        semanticType: "operation",
        // Keep the search document empty — UI-state suggestions must not
        // pollute memory search / feeds / retrieval.
        title: null,
        content: null,
        runId: runId ?? null,
        interactionType: "suggestion",
        interactionStatus: "current",
        interactionInput: { prompts },
        supersedesEventId,
        metadata: {
          conversationId,
          turnMessageId: turnMessageId ?? null,
        },
        authorName: "agent",
      },
      { sql: tx },
    );

    logger.info(
      `Persisted suggestion event ${event.id} for conversation ${conversationId}` +
        (supersedesEventId ? ` (superseded ${supersedesEventId})` : ""),
    );
    return Number(event.id);
  });
}

/**
 * Read the conversation's current suggestion set (for completion embedding and
 * history replay). Returns null if none is current.
 */
export async function readCurrentSuggestion(
  organizationId: string,
  conversationId: string,
  sql: DbClient = getDb(),
): Promise<{
  id: number;
  prompts: SuggestedPrompt[];
  turnMessageId: string | null;
} | null> {
  const rows = (await sql`
    SELECT id, interaction_input, metadata
    FROM current_event_records
    WHERE organization_id = ${organizationId}
      AND interaction_type = 'suggestion'
      AND interaction_status = 'current'
      AND origin_id = ${`suggestion:${conversationId}`}
    ORDER BY id DESC
    LIMIT 1
  `) as Array<{
    id: number;
    interaction_input: { prompts?: SuggestedPrompt[] } | null;
    metadata: Record<string, unknown> | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  const prompts = sanitizeSuggestionPrompts(row.interaction_input?.prompts);
  if (prompts.length === 0) return null;
  return {
    id: row.id,
    prompts,
    turnMessageId: (row.metadata?.turnMessageId as string | null) ?? null,
  };
}

/**
 * Finalize the conversation's suggestion set at a turn's terminal boundary.
 *
 * Runs on the gateway for EVERY terminal row — before the SSE owner-gate, so it
 * executes regardless of which pod (if any) holds the client's socket and is
 * NOT lost when a disconnected client leaves no SSE owner (the failure mode of
 * clearing inside the SSE-gated renderer). The whole read→decide→supersede is
 * one advisory-locked transaction keyed on the conversation, so it is race-free
 * against a concurrent `persistSuggestion` and against an out-of-order terminal
 * of an earlier turn:
 *
 *  - The current row is OWNED by this turn (its `turnMessageId` is one this turn
 *    processed) → leave it; the renderer embeds it on `complete`.
 *  - The current row belongs to a DIFFERENT turn → superseded (this turn emitted
 *    none), but ONLY if it is not newer than what this turn itself published.
 *    "Different turn" does not imply "earlier turn": per-conversation
 *    serialization orders turns as they RUN, not as their terminal rows are
 *    PROCESSED, so a terminal delayed by a queue backlog or retry can arrive
 *    after a whole subsequent turn published. `events.id` is monotonic, so a
 *    current row newer than this turn's own newest suggestion event belongs to a
 *    later turn and is left alone — otherwise a lagging terminal would erase
 *    chips the user is currently looking at, in the live payload and in history
 *    replay alike.
 *  - No current row → nothing to do.
 *
 * Idempotent: re-running (e.g. the row re-queued to the SSE owner after a
 * non-owning pod already finalized) either re-observes an owned/empty row and
 * no-ops, or the supersede is a no-op because the row is already cleared.
 */
export async function finalizeTurnSuggestions(args: {
  organizationId: string;
  conversationId: string;
  /** messageId + processedMessageIds of the completing turn. */
  turnMessageIds: string[];
}): Promise<void> {
  const { organizationId, conversationId, turnMessageIds } = args;
  const owned = new Set(turnMessageIds.filter(Boolean));
  await getDb().begin(async (tx: DbClient) => {
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      `${organizationId}:suggestion:${conversationId}`,
    )})`;
    const rows = (await tx`
      SELECT id, metadata
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND interaction_status = 'current'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{ id: number; metadata: Record<string, unknown> | null }>;
    const row = rows[0];
    if (!row) return; // nothing current
    const turnMessageId =
      (row.metadata?.turnMessageId as string | null) ?? null;
    // This turn (re)issued the current set → keep it for the renderer to embed.
    if (turnMessageId != null && owned.has(turnMessageId)) return;

    // Ordering guard. "Belongs to a different turn" does NOT imply "belongs to
    // an EARLIER turn": a terminal row whose processing lags a whole subsequent
    // turn (queue backlog or retry) arrives after that later turn already
    // published. Clearing then deletes live chips the user can see, and history
    // replay loses them too. `events.id` is monotonic, so a row created after
    // anything this turn wrote belongs to a later turn — leave it alone.
    if (owned.size > 0) {
      const mine = (await tx`
        SELECT max(id) AS id
        FROM events
        WHERE organization_id = ${organizationId}
          AND interaction_type = 'suggestion'
          AND origin_id = ${`suggestion:${conversationId}`}
          AND metadata->>'turnMessageId' = ANY(${pgTextArray([
            ...owned,
          ])}::text[])
      `) as Array<{ id: number | null }>;
      const newestMine = mine[0]?.id ?? null;
      if (newestMine != null && row.id > newestMine) return;
    }

    // A prior turn's set survived a turn that emitted none — supersede it.
    await insertEvent(
      {
        entityIds: [],
        organizationId,
        originId: `suggestion:${conversationId}`,
        semanticType: "operation",
        title: null,
        content: null,
        // 'completed' marks a terminal, non-current suggestion row so it drops
        // out of the current-set query (which filters interaction_status).
        interactionType: "suggestion",
        interactionStatus: "completed",
        interactionInput: { prompts: [] },
        supersedesEventId: row.id,
        metadata: { conversationId, cleared: true },
        authorName: "system",
      },
      { sql: tx },
    );
  });
}
