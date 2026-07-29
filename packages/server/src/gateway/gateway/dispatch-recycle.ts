/**
 * Claim-side recycle gate — runs at the dispatch chokepoint, on the worker's
 * OWNER pod, before a claimed `thread_message_*` job is delivered over SSE.
 *
 * Why here and not at enqueue: a worker's queue is registered ONLY by the pod
 * it SSE-connects to, and `WorkerJobRouter.handleJob` delivers only via that
 * pod's local connection registry. Dispatch is therefore already single-pod,
 * so checking staleness here needs no cross-replica coordination at all — the
 * pod that recorded the deployment's lease expiry and tooling fingerprint at
 * create time is always the pod holding the claimed job. An enqueue-side
 * recycle (any replica) manufactures a teardown-vs-dispatch race that then
 * needs advisory locks and hold/requeue machinery to defend; this gate makes
 * that machinery unnecessary.
 *
 * Contract with the queue (verified against `RunsQueue.runHandler`): a
 * handler that RETURNS marks the job completed — for this lane that happens on
 * the worker's delivery receipt, i.e. ack-on-delivery, not on turn completion
 * — and a handler that THROWS schedules a retry (`attempts + 1 <
 * max_attempts`, delay = the job's `retry_delay_seconds` or exponential
 * backoff). Throwing is therefore the queue-native way to keep a claimed job
 * undelivered, and it is the ONLY deferral mechanism used here: no custom
 * requeue, no singleton keys, no holds.
 *
 * WHAT THIS GATE PROMISES, precisely: a stale worker is rebuilt before it
 * serves a message that finds it QUIET. It does not promise that no message ever
 * reaches stale credentials — a message arriving while a turn is running is
 * delivered as-is (see step 4), because deciding otherwise needs worker-local
 * knowledge the gateway does not have. That case is left at its pre-gate
 * behaviour rather than guarded by a guess; eliminating it needs
 * worker-confirmed delivery disposition, which belongs to the turn-lifecycle
 * consolidation, not here.
 *
 * FAIL CLOSED: nothing in this module catches-and-delivers. Any error on the
 * staleness path propagates, the job is not delivered to the stale worker, and
 * the queue retries until it either delivers to a fresh worker or fails
 * visibly. The only caught errors come from the recycle itself, and each
 * failure mode is classified to a distinct outcome — collapsing them is the
 * defect this module has been bitten by more than once:
 *   - `ConversationOwnedElsewhereError` (another replica won the conversation
 *     lock the teardown released) → DEFER. It is a handoff, not a fault; the
 *     winner is bringing the worker up under the same name and its pod will
 *     deliver this job.
 *   - any other rebuild failure → TERMINAL. Fail the turn through the marker
 *     election (the same one the enqueue path uses for create failures) and
 *     complete the held job — re-throwing there would strand the job on a
 *     queue whose consumer the teardown just paused, then deliver it as a
 *     zombie after a later rebuild.
 *   - a terminalize that cannot confirm its own outcome → PROPAGATE the
 *     original error; the queue retries and the sweep stays the backstop.
 */

import {
  AgentErrorCode,
  ConversationOwnedElsewhereError,
  createLogger,
  getErrorMessage,
  type MessagePayload,
} from "@lobu/core";
import { generateDeploymentName } from "../orchestration/deployment-manager.js";
import {
  failTurnIfPending,
  hasLiveTurnForDeployment,
  hasOlderQueuedTurn,
} from "../orchestration/turn-liveness.js";

const logger = createLogger("dispatch-recycle");

/**
 * The slice of the DeploymentManager the gate needs. Everything is pod-local
 * state about workers THIS pod spawned — correct precisely because dispatch is
 * single-pod (see module doc).
 */
export interface DispatchRecycler {
  /** Enqueue-time stamp differs from what the deployment was built with —
   *  a pod-local SIGNAL only; confirmed by {@link hasToolingDrifted}. */
  hasToolingStampMismatch(deploymentName: string, fingerprint: string): boolean;
  /** DB-truth confirmation of a stamp mismatch: the org's CURRENT declaration
   *  digest differs from the deployment's born fingerprint. Chronology proxies
   *  (runs.id) cannot order observations — message claims process out of id
   *  order across replicas — so the truth is re-read instead. Throws on
   *  resolution failure (fail closed). */
  hasToolingDrifted(
    deploymentName: string,
    payload: MessagePayload
  ): Promise<boolean>;
  /** Lease expiry (with the recycle margin and min-age floor applied). */
  hasExpiringLease(deploymentName: string): boolean;
  /** Tear down and rebuild under the SAME name. Throws on failure. */
  recycleWorkerDeployment(
    deploymentName: string,
    payload: MessagePayload
  ): Promise<void>;
}

/**
 * Thrown to make the queue retry a claimed job without delivering it. Every
 * reason is an expected state, not a fault — the error type exists so tests and
 * log triage can tell a deliberate deferral from a genuine failure.
 */
export class StaleWorkerError extends Error {
  /** Queue deferral contract (`isDeferralError`): reschedule WITHOUT consuming
   *  an attempt. Every reason here is a wait with an external termination
   *  bound — head-of-line progress, a one-shot recycle, or another replica's
   *  rebuild — not a failure, and burning the attempt budget on it would
   *  strand a legitimate turn as a failed, never-delivered row. */
  readonly deferral = true;

  constructor(
    message: string,
    readonly reason: "recycled" | "older-turn-pending" | "ownership-handoff"
  ) {
    super(message);
    this.name = "StaleWorkerError";
  }
}

/** Injectable liveness probe (tests); production uses the Postgres probe. */
export type LiveTurnProbe = typeof hasLiveTurnForDeployment;
/** Injectable terminalizer (tests); production uses the marker election. */
export type TurnTerminalizer = typeof failTurnIfPending;
/** Injectable FIFO-fence probe (tests); production uses the Postgres probe. */
export type OlderTurnProbe = typeof hasOlderQueuedTurn;

/** The caller may deliver, or must complete the job WITHOUT delivering. */
export type DispatchDecision = "deliver" | "drop";

/**
 * Decide whether `deploymentName` may serve this job, recycling it first if it
 * is stale and quiet. Returns normally exactly when the caller may deliver.
 *
 * 1. No recycler wired, payload not fingerprint-bearing, or the job is not a
 *    conversation-deployment dispatch (`api-*` family, exec lanes) → deliver
 *    as today.
 * 2. FIFO fence: a sibling job that outranks this one in claim order is still
 *    pending → throw. A deferral retry pushes the deferred job's `run_at`
 *    forward, so after a recycle the head turn would otherwise re-enter the
 *    queue BEHIND a younger sibling and two user messages would reach the
 *    fresh worker reversed. The fence also means only the true head-of-line
 *    job ever consults staleness or triggers a recycle. The top-ranked job is
 *    never fenced, so the lane always makes progress.
 * 3. Fresh (no stamp mismatch or the mismatch is merely an outdated stamp —
 *    the org's CURRENT declaration digest still matches what the deployment
 *    was built with — and the lease is not expiring) → deliver. The DB-truth
 *    re-read replaces any runs.id chronology: message claims process out of
 *    id order across replicas, so a lower runId can carry a newer observation.
 * 4. Stale + a turn is live on the worker → DELIVER, unrecycled. The gate never
 *    interrupts or withholds from a running turn: it cannot know whether the
 *    worker will steer this message into that turn, cancel it, or queue it as
 *    new work, because those preconditions are worker-local. Delivering leaves
 *    exactly the pre-gate behaviour for this case; withholding would silently
 *    break steering and `/cancel`. The probe counts only DELIVERED turns
 *    (completed `thread_message` row = delivery receipt), so armed-but-
 *    undelivered turns — including THIS one — never count as live.
 * 5. Stale + quiet → tear down and rebuild under the same name, then throw:
 *    the fresh worker has not SSE-attached inside this handler invocation, so
 *    delivery happens on the retry (the queue is paused until the new worker
 *    connects, so the retry does not burn attempts against a half-booted
 *    worker).
 * 6. Recycle FAILED → classified, never collapsed (see the module doc): a
 *    cross-pod ownership handoff defers, any other rebuild failure terminalizes
 *    the turn and returns "drop", and anything the terminalize itself cannot
 *    confirm propagates. Every other error on the path propagates too (fail
 *    closed; never deliver to the stale worker).
 */
export async function gateDispatchOnStaleness(args: {
  deploymentName: string;
  /** The claimed `runs` row id, for the FIFO fence. `RunsQueue` job ids are
   *  always the numeric row id; a non-numeric id (harness fakes, legacy lanes)
   *  has no row to rank against, so the fence is skipped, never guessed. */
  jobRunId?: number;
  jobData: unknown;
  recycler: DispatchRecycler;
  probeLiveTurn?: LiveTurnProbe;
  terminalizeTurn?: TurnTerminalizer;
  probeOlderTurn?: OlderTurnProbe;
}): Promise<DispatchDecision> {
  const { deploymentName, recycler } = args;
  const probeLiveTurn = args.probeLiveTurn ?? hasLiveTurnForDeployment;
  const terminalizeTurn = args.terminalizeTurn ?? failTurnIfPending;
  const probeOlderTurn = args.probeOlderTurn ?? hasOlderQueuedTurn;

  const payload = asDispatchPayload(args.jobData);
  if (!payload) return "deliver";
  // Scope: the gate applies only to conversation deployments, whose queue name
  // is derived from the payload identity. The `api-${agentId}` family and any
  // legacy lane whose payload does not derive this deployment's name are out
  // of scope — recycling them from a conversation payload would delete one
  // deployment and recreate another. Deliver as before this gate existed.
  if (generateDeploymentName(payload) !== deploymentName) return "deliver";

  // FIFO fence (step 2 above): defer to any sibling that outranks this job in
  // claim order — it is only behind us because a deferral retry pushed its
  // `run_at` forward, and delivering now would reorder the conversation.
  if (
    typeof args.jobRunId === "number" &&
    Number.isFinite(args.jobRunId) &&
    (await probeOlderTurn(args.jobRunId))
  ) {
    throw new StaleWorkerError(
      `An earlier turn for ${deploymentName} is still queued — deferring delivery to preserve message order`,
      "older-turn-pending"
    );
  }

  const fingerprint =
    typeof payload.toolingFingerprint === "string" &&
    payload.toolingFingerprint.length > 0
      ? payload.toolingFingerprint
      : null;
  const stampMismatch =
    fingerprint != null &&
    recycler.hasToolingStampMismatch(deploymentName, fingerprint);
  const leaseExpiring = recycler.hasExpiringLease(deploymentName);
  if (!stampMismatch && !leaseExpiring) return "deliver";

  // A mismatching stamp may simply predate the deployment's (re)build (an old
  // queued job after a recycle). Confirm against DB truth before acting —
  // current == born means outdated stamp, not staleness. Errors propagate
  // (fail closed): the queue retries rather than delivering on unknown state.
  const toolingChanged =
    stampMismatch && (await recycler.hasToolingDrifted(deploymentName, payload));
  if (!toolingChanged && !leaseExpiring) return "deliver";

  // Stale, but the worker is mid-turn. The gate gets out of the way and
  // delivers: recycling would SIGTERM a running turn and cost the user a reply,
  // and withholding the message is not a safe alternative either, because the
  // gateway cannot know what the worker will DO with it. The worker steers a
  // follow-up into the live turn and aborts on an explicit cancel — both act on
  // the turn already executing, and both need preconditions only the worker
  // holds (its current worker handle, whether the batcher is still processing,
  // and whether the posting user owns the live turn; a shared channel thread is
  // served by ONE worker, so a second participant's message routinely fails that
  // last check). Deciding from the payload alone therefore either withholds a
  // steer the worker was waiting for or promises a protection it cannot keep.
  //
  // What this costs: a message that arrives mid-turn may start its own turn on
  // credentials inside the recycle margin. That is exactly the pre-gate
  // behaviour — no regression, just an unfixed case — and the recycle is not
  // lost, it happens on the first claim that finds the worker quiet. A
  // conversation that is NEVER quiet at claim time is never recycled; closing
  // that needs worker-confirmed disposition, which is the consolidation's job.
  // Undelivered queued turns (this job included) never count as live: they are
  // protected by this same gate, not by the worker.
  if (await probeLiveTurn(deploymentName)) {
    logger.info(
      {
        deploymentName,
        messageId: payload.messageId,
        tooling_changed: toolingChanged,
        lease_expiring: leaseExpiring,
      },
      "Worker is stale but mid-turn — delivering without recycling; the worker owns what happens to a live turn"
    );
    return "deliver";
  }

  logger.info(
    {
      deploymentName,
      tooling_changed: toolingChanged,
      lease_expiring: leaseExpiring,
    },
    toolingChanged
      ? "Connector tooling changed — recycling worker before delivery"
      : "Connector lease expiring — recycling worker before delivery"
  );
  try {
    await recycler.recycleWorkerDeployment(deploymentName, payload);
  } catch (error) {
    // This catch spans BOTH a teardown and a rebuild, so classify before
    // acting — the failure modes reachable here do not share an outcome.
    //
    // `ConversationOwnedElsewhereError` is not a failure at all: it is the
    // cross-pod handoff signal. The teardown released this conversation's
    // advisory lock, another replica won it, and that replica is bringing up
    // the worker under the SAME name — the fresh worker will register its
    // queue consumer on THAT pod. Terminalizing here would surface a spurious
    // WORKER_STARTUP_FAILED to the user and race the winner's reply to
    // discharge the shared turn marker, which is exactly what this typed error
    // exists to prevent (see its doc in `@lobu/core`). Defer instead: the job
    // stays durable and undelivered, and the new owner's consumer delivers it.
    // Termination is bounded — the winner holds the lock only for its worker
    // subprocess lifetime, and if that worker dies the lock releases and the
    // retry re-runs this gate against a deployment whose pod-local tooling
    // state the teardown already cleared.
    if (error instanceof ConversationOwnedElsewhereError) {
      logger.info(
        { deploymentName },
        "Conversation claimed by another replica mid-recycle — deferring delivery to the new owner"
      );
      throw new StaleWorkerError(
        `Deployment ${deploymentName} was rebuilt by another replica — delivery retries under its new owner`,
        "ownership-handoff"
      );
    }
    logger.error(
      { deploymentName, error: getErrorMessage(error) },
      "Deployment recycle failed — terminalizing the held turn"
    );
    // The teardown may have succeeded before the rebuild failed, in which case
    // the SSE disconnect paused this queue: a re-thrown job would sit
    // unclaimable until the sweep deadline, then be delivered as a zombie once
    // a later message rebuilds the worker. Instead, fail the turn NOW through
    // the same election the enqueue path uses for create failures, and
    // complete the job we are holding — no pending job, no zombie. If even the
    // terminalize fails, re-throw the original error: the queue retries and
    // the sweep remains the backstop (fail closed, never deliver).
    try {
      // The election returns false ONLY when it lost — the marker was already
      // gone, and a marker is deleted exclusively by the transaction that
      // emits that turn's terminal event — so false is a VERIFIED terminal
      // turn and completing the job is still correct. An outcome it cannot
      // confirm (a DB failure) throws instead, and is handled below.
      await terminalizeTurn(
        deploymentName,
        payload.messageId,
        AgentErrorCode.WORKER_STARTUP_FAILED
      );
    } catch (terminalizeError) {
      logger.error(
        { deploymentName, error: getErrorMessage(terminalizeError) },
        "Failed to terminalize the turn after a recycle failure — job stays undelivered and will retry"
      );
      throw error;
    }
    return "drop";
  }
  throw new StaleWorkerError(
    `Deployment ${deploymentName} was recycled — delivery retries on the fresh worker`,
    "recycled"
  );
}

/**
 * Narrow a queue job's data to the payload shape the gate needs. Anything that
 * cannot derive a deployment identity is not a conversation dispatch and the
 * gate does not apply.
 */
function asDispatchPayload(jobData: unknown): MessagePayload | null {
  if (typeof jobData !== "object" || jobData === null) return null;
  const p = jobData as MessagePayload;
  if (
    typeof p.userId !== "string" ||
    typeof p.conversationId !== "string" ||
    typeof p.agentId !== "string" ||
    typeof p.organizationId !== "string"
  ) {
    return null;
  }
  return p;
}
