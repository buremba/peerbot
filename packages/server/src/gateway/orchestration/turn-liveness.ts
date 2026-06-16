/**
 * Turn liveness — surfaces a terminal error to the client when a worker fails
 * to produce a reply (crash, hang, or pod death), so the SSE/CLI never hangs
 * forever and never receives a silent `complete`.
 *
 * ## The obligation, as a durable election record
 *
 * Every dispatched turn owes the client exactly one terminal event for its
 * `messageId`. Between delivery-receipt (when the `thread_message` run already
 * completes) and the worker's reply there is otherwise NO durable record that
 * the turn is still owed an answer — that gap is what lets a dead worker hang
 * the stream. We close it by writing a **passive marker row** into `public.runs`
 * on a queue with NO consumer (`internal:turn_timeout`): it is never claimed as
 * a job, so the RunsQueue status machinery never touches it. The marker's
 * EXISTENCE is the obligation; deleting it (`DELETE … RETURNING`) is a
 * first-writer-wins election — a row can be deleted exactly once, and the
 * deleter emits the terminal `error` in the SAME transaction, so the emit is
 * atomic and crash-safe (the marker survives a mid-emit crash and a later sweep
 * retries).
 *
 * ## Detection (two paths, one emit)
 *  - Fast path (instant): the owning pod observes `child.once("exit"/"error")`
 *    and calls {@link failTurnsForDeployment}. Covers the common case (bad
 *    provider key, OOM, `exit 1`).
 *  - Backstop (deadline): {@link sweepExpiredTurns} runs periodically on every
 *    replica and fails markers whose deadline has lapsed. Covers a hung worker
 *    (alive, never replies) and a worker-pod death (the marker outlives the pod
 *    and another replica sweeps it). The deadline is pushed forward by the
 *    worker's 20s heartbeat ({@link extendTurnDeadlines}), so a live-but-slow
 *    worker is never falsely failed, while a silent one lapses.
 *
 * ## Multi-replica
 * Arming/extending/discharging all happen on the worker's owning pod (worker
 * child, dispatch, and `handleWorkerResponse` are co-located there). The marker
 * + emit live in shared Postgres, so any replica can sweep, and the emitted
 * `thread_response{error}` is owner-gated in `routeToRenderer` to reach the pod
 * that holds the client's SSE.
 */

import { createLogger } from "@lobu/core";
import { intervals } from "../../config/intervals.js";
import { getDb, type DbClient } from "../../db/client.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";
import { TERMINAL_DELIVERY_SEND_OPTS } from "../infrastructure/queue/index.js";

const logger = createLogger("turn-liveness");

/** Queue name for the passive marker rows. Has NO registered consumer — the
 *  rows are never claimed as jobs; they are swept directly by this module. The
 *  `internal:` prefix maps to run_type `internal` (classifyQueue), keeping them
 *  out of the chat_message lane's stats/sweeps. */
const TURN_TIMEOUT_QUEUE = "internal:turn_timeout";

/** thread_response NOTIFY channel — must match RunsQueue's `runs_lobu:<queue>`
 *  so the UnifiedThreadResponseConsumer wakes immediately on an emitted error. */
const THREAD_RESPONSE_CHANNEL = "runs_lobu:thread_response";

// Default turn deadline and sweep cadence live in config/intervals.ts
// (`turnDefaultDeadlineMs` / `turnLivenessSweepIntervalMs`), env-overridable.

/** Routing needed to build the terminal `thread_response{error}` for a turn,
 *  stored as the marker's `action_input`. */
export interface TurnRouting {
  messageId: string;
  channelId?: string;
  conversationId?: string;
  userId?: string;
  platform?: string;
  platformMetadata?: Record<string, unknown>;
  deploymentName: string;
  organizationId?: string;
}

/**
 * Narrow a JSONB `action_input` read back from Postgres (typed `unknown` at the
 * DB boundary) to {@link TurnRouting}. `armTurnTimeout` is the only writer of
 * these rows, but the value is still `unknown` on the way out — validate rather
 * than blind-cast so a malformed row is skipped, never used to build a
 * `thread_response` with `undefined` fields. `messageId` is the load-bearing
 * field (discharge key + `processedMessageIds`), so it gates the narrow.
 */
function asTurnRouting(value: unknown): TurnRouting | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.messageId !== "string" || v.messageId.length === 0) return null;
  if (typeof v.deploymentName !== "string") return null;
  return v as unknown as TurnRouting;
}

/**
 * Build the marker's globally-unique key. `messageId` alone is NOT global —
 * platform message IDs (e.g. Telegram) are per-chat and API callers can supply
 * their own — so two concurrent turns in different conversations could collide
 * (one suppresses the other's marker, or a discharge hits the wrong turn).
 * `deploymentName` is unique per conversation, so `deploymentName:messageId` is
 * globally unique.
 */
function turnMarkerKey(deploymentName: string, messageId: string): string {
  return `${deploymentName}:${messageId}`;
}

/**
 * Arm the turn-liveness marker at dispatch. Idempotent per (deployment,
 * messageId) via the partial-unique `idempotency_key`, so a re-dispatched
 * message doesn't double-arm.
 *
 * **Fail-closed:** throws if the marker can't be persisted. The marker is the
 * ONLY durable record that this turn owes the client a terminal event — if it's
 * missing, a later worker crash/hang falls back to the silent hang this module
 * exists to prevent. The caller arms before enqueueing to the worker, so a
 * throw aborts dispatch and the `messages` run retries the whole turn (the arm
 * is idempotent), rather than dispatching an unprotected turn.
 */
export async function armTurnTimeout(
  queue: IMessageQueue,
  routing: TurnRouting,
  deadlineMs: number = intervals.turnDefaultDeadlineMs
): Promise<void> {
  await queue.createQueue(TURN_TIMEOUT_QUEUE);
  await queue.send(TURN_TIMEOUT_QUEUE, routing, {
    delayMs: deadlineMs,
    singletonKey: turnMarkerKey(routing.deploymentName, routing.messageId),
  });
}

/**
 * Push the deadline forward for all in-flight turns of a deployment. Called on
 * the worker's heartbeat ACK — a worker-driven liveness signal, so a live but
 * slow worker keeps its markers fresh while a silent one lapses.
 */
export async function extendTurnDeadlines(
  deploymentName: string,
  deadlineMs: number = intervals.turnDefaultDeadlineMs
): Promise<void> {
  try {
    const sql = getDb();
    const deadlineSec = Math.ceil(deadlineMs / 1000);
    // status + run_type match the partial predicate of `runs_lobu_claim_idx`
    // (WHERE status='pending' AND run_type IN (…)) and its leading column, so
    // this uses the index (run_type, queue_name, …) rather than scanning runs.
    await sql`
      UPDATE public.runs
      SET run_at = now() + (${deadlineSec}::int * interval '1 second')
      WHERE status = 'pending'
        AND run_type = 'internal'
        AND queue_name = ${TURN_TIMEOUT_QUEUE}
        AND action_input->>'deploymentName' = ${deploymentName}
    `;
  } catch (err) {
    // Non-throwing by design (a heartbeat ACK must never fail the worker),
    // but loud: if extends keep failing, the markers' deadlines lapse and the
    // sweep emits a terminal error for a turn whose worker is still alive.
    // Log everything needed to tie a later spurious "worker stopped
    // responding" back to this failure.
    logger.error(
      {
        deploymentName,
        deadlineMs,
        queue: TURN_TIMEOUT_QUEUE,
        err: err instanceof Error ? err.message : String(err),
      },
      "Failed to extend turn-timeout deadline — in-flight turns for this deployment may be falsely failed by the sweep if extends keep failing"
    );
  }
}

/**
 * Is the SPECIFIC turn `(deploymentName, messageId)` still in-flight?
 *
 * The `internal:turn_timeout` marker (a pending `public.runs` row, armed at
 * dispatch keyed on `deploymentName:messageId`) is the authoritative cross-pod
 * record that a turn is live: every terminalization path deletes it
 * transactionally (first-writer-wins), and the worker's 20s heartbeat pushes its
 * `run_at` deadline forward while the turn legitimately runs long — so any
 * replica reads the true state from shared `public.runs`.
 *
 * This is the liveness gate for worker-token refresh. The marker and the per-run
 * token are minted in the same dispatch (MessageConsumer.handleMessage) with the
 * same `messageId`, so a token refreshes only while ITS OWN turn is live — not
 * merely any turn on the deployment. Once the turn terminalizes the marker is
 * gone and refresh is denied: that deletion IS the revocation path, bounding the
 * leak window to how long the turn actually runs rather than an unbounded refresh
 * chain. It is deliberately NOT gated on the dispatching `runs.id` the token was
 * minted for — that `messages`-queue run completes the moment `handleMessage`
 * enqueues, long before the turn finishes.
 *
 * The `run_at > now()` predicate (not a bare `status = 'pending'`) excludes a
 * marker whose deadline has lapsed but which the periodic sweep hasn't deleted
 * yet — otherwise a hung/dead worker's turn would keep authorizing refreshes in
 * that gap, widening the leak past the deadline the heartbeat was meant to hold.
 */
export async function hasLiveTurnForMessage(
  deploymentName: string,
  messageId: string
): Promise<boolean> {
  const sql = getDb();
  // status + run_type + queue_name match the partial predicate / leading column
  // of `runs_lobu_claim_idx`, so this is an index probe, not a scan of the
  // 30-day `runs` retention. `run_at > now()` excludes lapsed-but-unswept
  // markers (see the deadline-predicate note above).
  const rows = await sql<{ ok: number }>`
    SELECT 1 AS ok FROM public.runs
    WHERE status = 'pending'
      AND run_type = 'internal'
      AND queue_name = ${TURN_TIMEOUT_QUEUE}
      AND action_input->>'deploymentName' = ${deploymentName}
      AND action_input->>'messageId' = ${messageId}
      AND run_at > now()
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Fast path: fail every in-flight turn of a deployment whose worker has just
 * died unexpectedly. Atomic per the `DELETE … RETURNING` election — only this
 * caller gets the rows, and the terminal error is enqueued in the same
 * transaction.
 *
 * @returns the number of turns failed (0 if the worker already replied / was a
 *          deliberate stop with nothing in flight).
 */
export async function failTurnsForDeployment(
  deploymentName: string,
  reason: string
): Promise<number> {
  try {
    const sql = getDb();
    const failed = await sql.begin(async (tx: DbClient) => {
      const rows = await tx<{ action_input: unknown }>`
        DELETE FROM public.runs
        WHERE status = 'pending'
          AND run_type = 'internal'
          AND queue_name = ${TURN_TIMEOUT_QUEUE}
          AND action_input->>'deploymentName' = ${deploymentName}
        RETURNING action_input
      `;
      let emitted = 0;
      for (const row of rows) {
        const routing = asTurnRouting(row.action_input);
        if (!routing) {
          // Unreachable for markers we write (arm always supplies messageId +
          // deploymentName). A row that fails this validation lacks the fields
          // needed to route a terminal event, so it's undeliverable — deleting
          // it (vs leaving it) is correct; leaving it would re-loop the sweep
          // forever. Logged at error so a real schema drift is noticed.
          logger.error("Dropping unroutable turn-timeout marker (fast path)");
          continue;
        }
        await enqueueTerminalError(tx, routing, reason);
        emitted += 1;
      }
      return emitted;
    });
    if (failed > 0) {
      await notifyThreadResponse();
      logger.info(
        { deploymentName, failed },
        "Worker died unexpectedly — emitted terminal error for in-flight turn(s)"
      );
    }
    return failed;
  } catch (err) {
    logger.error(
      { deploymentName, err: String(err) },
      "Failed to fail turns for dead deployment"
    );
    return 0;
  }
}

/**
 * Deadline backstop: fail markers whose deadline has lapsed. Runs on every
 * replica; `FOR UPDATE SKIP LOCKED` + `DELETE … RETURNING` make it exactly-once
 * across replicas. Covers a hung worker and a worker-pod death (the marker
 * outlives the pod that armed it).
 */
export async function sweepExpiredTurns(
  reason = "The worker handling your request stopped responding before it could reply. Please retry in a moment."
): Promise<number> {
  try {
    const sql = getDb();
    const failed = await sql.begin(async (tx: DbClient) => {
      const rows = await tx.unsafe<{ action_input: unknown }>(
        // status + run_type match the partial predicate and leading column of
        // `runs_lobu_claim_idx`, so the inner SELECT is an index range scan
        // (run_type, queue_name, …, run_at) — not a full scan of `runs` (which
        // retains 30 days of completed rows).
        `DELETE FROM public.runs
         WHERE id IN (
           SELECT id FROM public.runs
           WHERE status = 'pending'
             AND run_type = 'internal'
             AND queue_name = 'internal:turn_timeout'
             AND run_at < now()
           FOR UPDATE SKIP LOCKED
           LIMIT 200
         )
         RETURNING action_input`
      );
      let emitted = 0;
      for (const row of rows) {
        const routing = asTurnRouting(row.action_input);
        if (!routing) {
          // See the fast-path note: unroutable (missing messageId/deployment),
          // so undeliverable — deleting clears it; keeping would re-loop forever.
          logger.error("Dropping unroutable turn-timeout marker (sweep)");
          continue;
        }
        await enqueueTerminalError(tx, routing, reason);
        emitted += 1;
      }
      return emitted;
    });
    if (failed > 0) {
      await notifyThreadResponse();
      logger.warn(
        { failed },
        "Turn-liveness sweep failed lapsed turn(s) (hung worker or pod death)"
      );
    }
    return failed;
  } catch (err) {
    logger.warn({ err: String(err) }, "Turn-liveness sweep failed");
    return 0;
  }
}

/**
 * Insert one terminal `thread_response` row in the caller's transaction.
 * Mirrors RunsQueue.send's row shape for `thread_response` (run_type
 * chat_message), with the elevated retry budget terminal rows need to survive
 * the owner-gate re-queue (see TERMINAL_DELIVERY_SEND_OPTS). The caller does the
 * `pg_notify` after the transaction commits.
 */
async function insertThreadResponseRow(
  tx: DbClient,
  payload: unknown,
  organizationId: string | null
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO public.runs (
       run_type, queue_name, action_input, status, run_at,
       max_attempts, attempts, priority, retry_delay_seconds, organization_id
     ) VALUES (
       'chat_message', 'thread_response', $1, 'pending', now(),
       $2, 0, 0, $3, $4
     )`,
    [
      tx.json(payload),
      TERMINAL_DELIVERY_SEND_OPTS.retryLimit ?? 30,
      TERMINAL_DELIVERY_SEND_OPTS.retryDelay ?? 1,
      organizationId,
    ]
  );
}

/** Build the terminal `thread_response{error}` payload for a turn. `platform`
 *  always carries an explicit value (defaults to "api") — gateway routing and
 *  platform isolation require it; never emit `platform: undefined`. */
function buildTerminalErrorPayload(routing: TurnRouting, reason: string) {
  return {
    messageId: routing.messageId,
    channelId: routing.channelId,
    conversationId: routing.conversationId,
    userId: routing.userId,
    teamId: routing.platform ?? "api",
    platform: routing.platform ?? "api",
    platformMetadata: routing.platformMetadata,
    error: reason,
    processedMessageIds: [routing.messageId],
    timestamp: Date.now(),
  };
}

/** Insert a terminal `thread_response{error}` for a turn, in the caller's tx. */
async function enqueueTerminalError(
  tx: DbClient,
  routing: TurnRouting,
  reason: string
): Promise<void> {
  await insertThreadResponseRow(
    tx,
    buildTerminalErrorPayload(routing, reason),
    routing.organizationId ?? null
  );
}

/**
 * Election-gated terminal error for a SINGLE turn, used by pre-spawn deployment
 * failures (`trackFailedDeployment`). Atomically deletes the marker for
 * (deploymentName, messageId) and — only if it won the delete (the turn wasn't
 * already answered by a worker that raced) — emits the terminal error in the
 * same transaction. Returns whether it emitted.
 *
 * This is the first-writer-wins guarantee for the startup-failure path: if a
 * still-attached worker already produced a terminal reply (which discharged the
 * marker), this no-ops instead of double-signalling the client.
 */
export async function failTurnIfPending(
  deploymentName: string,
  messageId: string,
  reason: string
): Promise<boolean> {
  const key = turnMarkerKey(deploymentName, messageId);
  try {
    const sql = getDb();
    const emitted = await sql.begin(async (tx: DbClient) => {
      const rows = await tx<{ action_input: unknown }>`
        DELETE FROM public.runs
        WHERE idempotency_key = ${key}
          AND status = 'pending'
          AND queue_name = ${TURN_TIMEOUT_QUEUE}
        RETURNING action_input
      `;
      const routing = rows[0] ? asTurnRouting(rows[0].action_input) : null;
      if (!routing) return false;
      await enqueueTerminalError(tx, routing, reason);
      return true;
    });
    if (emitted) await notifyThreadResponse();
    return emitted;
  } catch (err) {
    logger.error(
      { key, err: String(err) },
      "Failed to fail pending turn (startup-failure path)"
    );
    return false;
  }
}

/**
 * Atomically commit a worker's TERMINAL reply (success completion or explicit
 * error) and discharge its marker(s) in ONE transaction. Two guarantees:
 *
 *  - **Atomic** — reply insert + marker delete commit together, so a crash
 *    can't leave a surviving marker that the sweep would turn into a duplicate.
 *  - **First-writer-wins** — the reply is inserted ONLY if this transaction
 *    actually deleted a pending marker. If the sweep or fast path already
 *    terminalized the turn (deleted the marker + emitted an error), a late
 *    worker reply deletes 0 markers and is dropped instead of double-signalling.
 *
 * @returns whether the reply was emitted (false = turn already terminalized).
 */
export async function commitTerminalReply(
  deploymentName: string,
  messageIds: string[],
  replyPayload: unknown,
  organizationId: string | null
): Promise<boolean> {
  const sql = getDb();
  const emitted = await sql.begin(async (tx: DbClient) => {
    let deleted = 0;
    for (const messageId of messageIds) {
      const rows = await tx<{ id: string }>`
        DELETE FROM public.runs
        WHERE idempotency_key = ${turnMarkerKey(deploymentName, messageId)}
          AND status = 'pending'
          AND queue_name = ${TURN_TIMEOUT_QUEUE}
        RETURNING id
      `;
      deleted += rows.length;
    }
    if (deleted === 0) return false; // already terminalized — drop the late reply
    await insertThreadResponseRow(tx, replyPayload, organizationId);
    return true;
  });
  if (emitted) await notifyThreadResponse();
  return emitted;
}

/** Wake thread_response consumers immediately after committing an emit. */
async function notifyThreadResponse(): Promise<void> {
  try {
    const sql = getDb();
    await sql`SELECT pg_notify(${THREAD_RESPONSE_CHANNEL}, 'thread_response')`;
  } catch {
    // Non-fatal: consumers poll on their own interval and will pick it up.
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

/** Start the periodic deadline backstop sweep. Idempotent. */
export function startTurnTimeoutSweep(): void {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    try {
      await sweepExpiredTurns();
    } finally {
      sweepInFlight = false;
    }
  };
  void tick();
  sweepTimer = setInterval(tick, intervals.turnLivenessSweepIntervalMs);
  sweepTimer.unref?.();
}

/** Stop the periodic sweep (graceful shutdown / tests). */
export function stopTurnTimeoutSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
