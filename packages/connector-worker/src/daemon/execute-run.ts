/**
 * One-shot execution of an ALREADY-CLAIMED device Automation run.
 *
 * The daemon's poll loop claims and executes in one process. A native bridge
 * cannot: the Owletto Mac app has to keep its own poll loop for the platform
 * connectors only it can serve (HealthKit, Photos, Screen Time, computer use),
 * and a poll claims whatever the server hands back — including automation runs
 * pinned to that device. Splitting the claim across two pollers on one device
 * row is what this avoids: the bridge stays the single claimer and hands the
 * verbatim poll envelope here, so `executeAutomationRun` remains the single
 * implementation of prompt building, MCP wiring, subprocess supervision, exit
 * reporting and the finalize/resume loop.
 *
 * Ownership contract, which the caller depends on:
 *   - returns normally → this call owns the run's outcome. It either delivered
 *     an exit report to `/complete-automation`, or deliberately left the run
 *     claimed for the server's heartbeat sweep (`dispatchAutomationResumeLoop`
 *     does this when the report is undeliverable). The caller must NOT report.
 *   - throws → nothing was reported and the run is untouched on the server. The
 *     caller still owns it and must report the failure itself, or the run sits
 *     `running` until the sweeper reclaims it.
 */

import type { AgentKind } from '@lobu/core/contracts/worker/device-automation';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun } from './automation.js';
import { WorkerClient } from './client.js';
import { log, setDebug } from './log.js';

export interface ExecuteClaimedRunOptions {
  /** Gateway base URL, e.g. `https://app.lobu.ai`. */
  apiUrl: string;
  /**
   * The worker id that CLAIMED this run. `/complete-automation` authorizes on
   * `runs.claimed_by` (`authorizeRunForWorker`), so a worker id that did not
   * claim it is refused with a 403 — which the arm classifies as non-retriable
   * and reports as an undelivered exit report, NOT as a run failure. The run
   * then sits `running` until the heartbeat sweep reclaims it, and this call
   * still returns without an error. So a wrong value here is lost silently:
   * pass the claiming poller's own id, never a fresh one.
   */
  workerId: string;
  /** Bearer the claiming poller authenticated with. */
  authToken: string;
  /** Verbatim `/api/workers/poll` response body for the claimed run. */
  job: unknown;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Agent to use when the Automation names no `agent_kind`. A native bridge
   * passes the machine's own default here (the Mac app's menubar pick).
   */
  defaultAgentKind?: AgentKind;
  /** Explicit per-agent binary paths (else PATH lookup). Test injection seam. */
  binaryOverrides?: Partial<Record<AgentKind, string>>;
  /** Root for isolated task/run directories. Defaults to ~/lobu-workspaces. */
  workspaceRoot?: string;
  debug?: boolean;
}

/**
 * A refusal raised BEFORE any server contact, so the caller knows its run is
 * still unreported. Carries `exitCode` so the CLI surfaces it as a non-zero
 * exit — the signal a native bridge keys its own fallback report off.
 */
export class UnexecutableRunError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = 'UnexecutableRunError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the envelope only as far as the arm's own error reporting cannot.
 *
 * `executeAutomationRun` already reports a missing `payload` through
 * `/complete-automation`, so that stays its job — routing it here would create
 * a second, divergent copy of the same failure text. What it CANNOT report is a
 * missing `run_id` (there is no run to post against) or a non-automation run
 * (it would build an agent prompt out of a connector sync job), so both are
 * refusals here.
 */
function assertAutomationEnvelope(job: unknown): PollResponse {
  if (!isRecord(job)) {
    throw new UnexecutableRunError(
      'expected a JSON object: the verbatim /api/workers/poll response body for the claimed run'
    );
  }
  if (job.run_type !== 'automation') {
    throw new UnexecutableRunError(
      `run_type must be 'automation' (got ${JSON.stringify(job.run_type ?? null)}); ` +
        'connector sync, action and auth runs are executed by the claiming worker, not here'
    );
  }
  const runId = job.run_id;
  if (typeof runId !== 'number' || !Number.isFinite(runId) || runId <= 0) {
    throw new UnexecutableRunError(
      `run_id must be a positive number (got ${JSON.stringify(runId ?? null)})`
    );
  }
  return job as unknown as PollResponse;
}

/**
 * Execute one already-claimed automation run and report its outcome.
 *
 * Deliberately does NOT require the durable `owl_pat_` token `startDaemonCommand`
 * insists on. That check exists because a daemon runs for weeks off one
 * snapshotted bearer, so a 24h OAuth session token would leave it polling 401
 * forever. This call lives and dies inside a single run (600s by default) using
 * the bearer its caller just polled with successfully, so the same rule would
 * only reject working credentials.
 */
export async function executeClaimedAutomationRun(
  opts: ExecuteClaimedRunOptions
): Promise<{ itemsCollected: number; error?: string }> {
  setDebug(opts.debug === true);

  const apiUrl = opts.apiUrl.trim();
  if (!apiUrl) throw new UnexecutableRunError('apiUrl is required');
  const workerId = opts.workerId.trim();
  if (!workerId) {
    throw new UnexecutableRunError(
      'workerId is required: it must be the id of the worker that claimed this run'
    );
  }
  const authToken = opts.authToken.trim();
  if (!authToken) {
    throw new UnexecutableRunError(
      'an auth token is required to post the run outcome to /complete-automation'
    );
  }

  const job = assertAutomationEnvelope(opts.job);

  // No capabilities and no platform: this client never polls, so it never
  // registers a device row. It only heartbeats and posts the exit report, both
  // of which authorize on (token, worker_id) against the existing claim.
  const client = new WorkerClient({
    apiUrl,
    workerId,
    authToken,
    capabilities: {},
  });

  log.info(`[execute-run] Executing claimed automation run ${job.run_id}`);
  return executeAutomationRun(client, job, {
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.heartbeatIntervalMs != null
      ? { heartbeatIntervalMs: opts.heartbeatIntervalMs }
      : {}),
    ...(opts.defaultAgentKind ? { defaultAgentKind: opts.defaultAgentKind } : {}),
    ...(opts.binaryOverrides ? { binaryOverrides: opts.binaryOverrides } : {}),
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
  });
}
