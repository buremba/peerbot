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
 * FAIL CLOSED: nothing in this module catches-and-delivers. Any error on the
 * staleness/recycle path propagates, the job is not delivered to the stale
 * worker, and the queue retries until it either delivers to a fresh worker or
 * fails visibly.
 */

import { createLogger, getErrorMessage, type MessagePayload } from "@lobu/core";
import { generateDeploymentName } from "../orchestration/deployment-manager.js";
import { hasLiveTurnForDeployment } from "../orchestration/turn-liveness.js";

const logger = createLogger("dispatch-recycle");

/**
 * The slice of the DeploymentManager the gate needs. Everything is pod-local
 * state about workers THIS pod spawned — correct precisely because dispatch is
 * single-pod (see module doc).
 */
export interface DispatchRecycler {
  /** Fingerprint mismatch vs. what the deployment was built with. */
  hasToolingChanged(
    deploymentName: string,
    fingerprint: string,
    observedAtRunId?: number
  ): boolean;
  /** Lease expiry (with the recycle margin and min-age floor applied). */
  hasExpiringLease(deploymentName: string): boolean;
  /** Tear down and rebuild under the SAME name. Throws on failure. */
  recycleWorkerDeployment(
    deploymentName: string,
    payload: MessagePayload
  ): Promise<void>;
}

/**
 * Thrown to make the queue retry a claimed job without delivering it. Both
 * cases are expected states, not faults — the error type exists so tests and
 * log triage can tell a deliberate deferral from a genuine failure.
 */
export class StaleWorkerError extends Error {
  constructor(
    message: string,
    readonly reason: "prior-turn-live" | "recycled"
  ) {
    super(message);
    this.name = "StaleWorkerError";
  }
}

/** Injectable liveness probe (tests); production uses the Postgres probe. */
export type LiveTurnProbe = typeof hasLiveTurnForDeployment;

/**
 * Decide whether `deploymentName` may serve this job, recycling it first if it
 * is stale and quiet. Returns normally exactly when the caller may deliver.
 *
 * 1. No recycler wired, payload not fingerprint-bearing, or the job is not a
 *    conversation-deployment dispatch (`api-*` family, exec lanes) → deliver
 *    as today.
 * 2. Fresh (fingerprint matches or unknown, lease not expiring) → deliver.
 * 3. Stale + a PRIOR turn is live on the worker → throw; the queue retries and
 *    the gate re-evaluates on the next claim. The probe counts only DELIVERED
 *    turns (completed `thread_message` row = delivery receipt), so armed-but-
 *    undelivered turns — including THIS one — never block: counting them would
 *    let two queued turns defer each other forever.
 * 4. Stale + quiet → tear down and rebuild under the same name, then throw:
 *    the fresh worker has not SSE-attached inside this handler invocation, so
 *    delivery happens on the retry (the queue is paused until the new worker
 *    connects, so the retry does not burn attempts against a half-booted
 *    worker).
 * 5. Any error → propagate (fail closed; never deliver to the stale worker).
 */
export async function gateDispatchOnStaleness(args: {
  deploymentName: string;
  jobData: unknown;
  recycler: DispatchRecycler;
  probeLiveTurn?: LiveTurnProbe;
}): Promise<void> {
  const { deploymentName, recycler } = args;
  const probeLiveTurn = args.probeLiveTurn ?? hasLiveTurnForDeployment;

  const payload = asDispatchPayload(args.jobData);
  if (!payload) return;
  // Scope: the gate applies only to conversation deployments, whose queue name
  // is derived from the payload identity. The `api-${agentId}` family and any
  // legacy lane whose payload does not derive this deployment's name are out
  // of scope — recycling them from a conversation payload would delete one
  // deployment and recreate another. Deliver as before this gate existed.
  if (generateDeploymentName(payload) !== deploymentName) return;

  const fingerprint =
    typeof payload.toolingFingerprint === "string" &&
    payload.toolingFingerprint.length > 0
      ? payload.toolingFingerprint
      : null;
  const toolingChanged =
    fingerprint != null &&
    recycler.hasToolingChanged(
      deploymentName,
      fingerprint,
      typeof payload.runId === "number" ? payload.runId : undefined
    );
  const leaseExpiring = recycler.hasExpiringLease(deploymentName);
  if (!toolingChanged && !leaseExpiring) return;

  // Stale. Never interrupt a turn the worker is already running — a SIGTERM
  // there costs the user a reply. Undelivered queued turns (this job included)
  // are excluded: they are protected by this same gate, not by the worker.
  if (await probeLiveTurn(deploymentName)) {
    throw new StaleWorkerError(
      `Deployment ${deploymentName} is stale (${
        toolingChanged ? "tooling changed" : "lease expiring"
      }) but a prior turn is still running — deferring delivery`,
      "prior-turn-live"
    );
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
    // Re-throw (fail closed) — logged here because the queue's retry machinery
    // only records the message, and "which recycle step died" is the first
    // triage question.
    logger.error(
      { deploymentName, error: getErrorMessage(error) },
      "Deployment recycle failed — job stays undelivered and will retry"
    );
    throw error;
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
