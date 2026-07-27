import {
  createLogger,
  sanitizeSuggestionPrompts,
  type SuggestedPrompt,
} from "@lobu/core";
import { getDb, pgTextArray } from "../../db/client.js";
import type { DbClient } from "../../db/client.js";
import { insertEvent } from "../../utils/insert-event.js";

const logger = createLogger("persist-suggestion");

/**
 * Advisory-lock namespace for suggestion supersession. Distinct from the
 * event-dedup namespace so the two lock spaces never collide on a shared key.
 */
const SUGGESTION_LOCK_NAMESPACE = 0x5355 /* "SU" */;

/**
 * FNV-1a hash of the conversation id → int4 advisory-lock key. Same pattern as
 * `eventDedupLockKey`, keyed on conversationId (not connectionId+originId)
 * because suggestions supersede per CONVERSATION and API/Builder sessions have
 * no numeric connectionId.
 */
function suggestionLockKey(conversationId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < conversationId.length; i++) {
    hash ^= conversationId.charCodeAt(i);
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
  args: PersistSuggestionArgs
): Promise<number> {
  const {
    organizationId,
    conversationId,
    prompts,
    turnMessageId,
    runId,
  } = args;

  return getDb().begin(async (tx: DbClient) => {
    // Serialize concurrent writers for this conversation (duplicate queue
    // redeliveries, parallel tool calls in one turn) across all replicas.
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      conversationId
    )})`;

    // Supersede the latest LIVE row whatever its interaction_status, not just a
    // 'current' one. `current_event_records` defines live as "nothing supersedes
    // me" and never looks at status, so filtering on status='current' here left
    // finalize's 'completed' clear markers with nothing pointing at them: they
    // stayed live in the view forever and every suggest→clear cycle stranded
    // another one in an append-only table. Matching the view's own definition of
    // live keeps the lineage a single chain.
    const priorRows = (await tx`
      SELECT id, run_id
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
    `) as Array<{ id: number; run_id: number | null }>;
    const prior = priorRows[0];

    // Ordering guard, mirror of finalize's: the caller decided to publish
    // OUTSIDE this lock, so a delayed agent-tool POST can arrive after a later
    // turn already ran. If the live row belongs to a LATER run than ours, it is
    // the set the user is looking at — never supersede it with stale chips.
    // Detectable only when both sides carry a run id, which is why finalize
    // stamps its clear markers with the clearing turn's run id.
    if (runId != null && prior?.run_id != null && Number(prior.run_id) > runId) {
      logger.info(
        `Skipping suggestion persist for ${conversationId}: live row run ${prior.run_id} is newer than ${runId}`
      );
      return Number(prior.id);
    }
    const supersedesEventId = prior?.id ?? null;

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
      { sql: tx }
    );

    logger.info(
      `Persisted suggestion event ${event.id} for conversation ${conversationId}` +
        (supersedesEventId ? ` (superseded ${supersedesEventId})` : "")
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
  sql: DbClient = getDb()
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
 * The completing turn's run id from `agent_run_input`, keyed by the message ids
 * the turn processed. A row exists for EVERY turn (including one that emitted no
 * suggestion event of its own) and rows are marked 'completed' rather than
 * deleted, so the id is still readable at terminal time. Returns null when no
 * message ids are supplied or none match (older workers, unstamped turns) — the
 * ordering guards that consume it treat a null run id as "unknown, don't block".
 */
export async function readTurnRunId(
  organizationId: string,
  conversationId: string,
  turnMessageIds: string[],
  sql: DbClient = getDb()
): Promise<number | null> {
  const owned = turnMessageIds.filter(Boolean);
  if (owned.length === 0) return null;
  const rows = (await sql`
    SELECT max(run_id) AS run_id
    FROM public.agent_run_input
    WHERE organization_id = ${organizationId}
      AND conversation_id = ${conversationId}
      AND message_id = ANY(${pgTextArray(owned)}::text[])
  `) as Array<{ run_id: number | null }>;
  return rows[0]?.run_id ?? null;
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
 *    none), but ONLY if that turn ran EARLIER. "Different turn" does not imply
 *    "earlier turn": per-conversation serialization orders turns as they RUN,
 *    not as their terminal rows are PROCESSED, so a terminal delayed by a queue
 *    backlog or a retry can arrive after a whole subsequent turn has published.
 *    Clearing then erases chips the user is looking at, in the live payload and
 *    in history replay alike. Ordering comes from `agent_run_input.run_id`,
 *    which exists for EVERY turn keyed by the message ids this function already
 *    receives — including a turn that emitted no suggestions and so has no
 *    suggestion event of its own to compare against.
 *  - No current row → nothing to do.
 *
 * Idempotent: re-running (e.g. the row re-queued to the SSE owner after a
 * non-owning pod already finalized) either re-observes an owned/empty row and
 * no-ops, or the supersede is a no-op because the row is already cleared.
 *
 */
export async function finalizeTurnSuggestions(args: {
  organizationId: string;
  conversationId: string;
  /** messageId + processedMessageIds of the completing turn. */
  turnMessageIds: string[];
}): Promise<void> {
  const { organizationId, conversationId, turnMessageIds } = args;
  const owned = new Set(turnMessageIds.filter(Boolean));
  return getDb().begin(async (tx: DbClient) => {
    await tx`SELECT pg_advisory_xact_lock(${SUGGESTION_LOCK_NAMESPACE}, ${suggestionLockKey(
      conversationId
    )})`;

    // This turn's run id, from `agent_run_input` — it has a row for EVERY turn
    // keyed by the message ids this finalizer already holds, including a turn
    // that emitted no suggestions (which leaves no suggestion event of its own
    // to read a run id from). Read inside the lock on `tx`. Used two ways: the
    // out-of-order-terminal guard below, and the run stamp on the clear marker.
    const turnRunId = await readTurnRunId(
      organizationId,
      conversationId,
      [...owned],
      tx
    );
    // Unlike persistSuggestion, this DOES filter on status='current': it asks
    // "is there a visible set to clear?", and only a 'current' row is visible to
    // the renderer. Widening this to any live row would make each clear observe
    // the previous clear marker and supersede it, appending a fresh 'completed'
    // row on every terminal for the rest of the conversation's life.
    const rows = (await tx`
      SELECT id, run_id, metadata
      FROM current_event_records
      WHERE organization_id = ${organizationId}
        AND interaction_type = 'suggestion'
        AND interaction_status = 'current'
        AND origin_id = ${`suggestion:${conversationId}`}
      ORDER BY id DESC
      LIMIT 1
    `) as Array<{
      id: number;
      run_id: number | null;
      metadata: Record<string, unknown> | null;
    }>;
    const row = rows[0];
    if (!row) return; // nothing current
    const turnMessageId =
      (row.metadata?.turnMessageId as string | null) ?? null;
    // This turn (re)issued the current set → keep it for the renderer to embed.
    if (turnMessageId != null && owned.has(turnMessageId)) {
      return;
    }

    // Ordering guard. "Belongs to a different turn" does NOT imply "belongs to
    // an EARLIER turn": a terminal row whose processing lags a whole subsequent
    // turn (queue backlog or retry) arrives after that later turn published.
    // Clearing then erases chips the user is looking at, in the live payload and
    // in history replay alike. Only clear a set published by an EARLIER run — a
    // LATER run's set is the one the user is looking at.
    if (turnRunId != null && row.run_id != null && row.run_id > turnRunId) {
      return;
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
        // Stamped with the CLEARING turn's run id so persistSuggestion's
        // ordering guard can see "a later run already cleared this" — without
        // it a delayed persist could resurrect chips over the clear.
        runId: turnRunId,
        metadata: { conversationId, cleared: true },
        authorName: "system",
      },
      { sql: tx }
    );
  });
}
