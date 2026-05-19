/**
 * Embedded connector-worker daemon.
 *
 * In embedded mode (`lobu run` / `bun run dev`), the gateway and the
 * connector-worker run in the same Node process. Previously only the
 * gateway booted, which meant `runs(run_type='sync')` rows sat in
 * `pending` forever — nothing called `/api/workers/poll`. `manage_feeds`
 * with `trigger_feed` would happily enqueue a run; no events ever
 * landed.
 *
 * This module spins up the existing `WorkerDaemon` in-process, pointed
 * at the local gateway (`http://127.0.0.1:${PORT}`). The atomic claim
 * already lives in `worker-api.ts::pollWorkerJob` (`FOR UPDATE OF r SKIP
 * LOCKED LIMIT 1` + `claimed_by = worker_id`), so an embedded daemon and
 * any external fleet worker co-exist without double-execution.
 *
 * Opt-out: set `LOBU_DISABLE_EMBEDDED_WORKER=1` (prod deployments with a
 * separate connector-worker pod).
 */

import { hostname } from 'node:os';
import { WorkerDaemon } from '../../../connector-worker/src/daemon/worker';
import { buildConnectorWorkerEnv } from '../../../connector-worker/src/env';
import type { Env } from '../index';
import logger from '../utils/logger';

const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface EmbeddedConnectorWorkerHandle {
  /** Stop polling. In-flight jobs continue to completion (or `wait()`). */
  stop(): void;
  /** Wait for any in-flight jobs to drain after `stop()`. */
  wait(timeoutMs?: number): Promise<boolean>;
}

/**
 * Start the embedded connector-worker. Returns a handle the server's
 * shutdown path can use to drain in-flight runs.
 *
 * Must be called AFTER the HTTP server is listening — `WorkerDaemon.start()`
 * does a `GET /api/health` check up-front, which will fail if the listener
 * isn't ready yet.
 */
export function startEmbeddedConnectorWorker(
  serverEnv: Env,
  apiUrl: string
): EmbeddedConnectorWorkerHandle | null {
  if (process.env.LOBU_DISABLE_EMBEDDED_WORKER === '1') {
    logger.info('[embedded-worker] disabled via LOBU_DISABLE_EMBEDDED_WORKER=1');
    return null;
  }

  const workerId = `embedded:${hostname() || 'localhost'}:${process.pid}`;
  // Connector subprocesses inherit `context.env` from the WorkerDaemon's
  // `env` arg (`SubprocessExecutor.fork` spreads it onto `pickSystemEnv`).
  // Passing the gateway's full env would leak ENCRYPTION_KEY,
  // BETTER_AUTH_SECRET, DATABASE_URL, and provider secrets into every
  // connector run. Re-use the same whitelist the standalone connector-worker
  // CLI applies in `packages/connector-worker/src/bin.ts::buildConnectorWorkerEnv`.
  const connectorEnv = buildConnectorWorkerEnv();
  const daemon = new WorkerDaemon(
    {
      apiUrl,
      workerId,
      workerApiToken: serverEnv.WORKER_API_TOKEN,
      capabilities: { browser: false },
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      maxConcurrentJobs: 1,
    },
    connectorEnv
  );

  // Fire-and-forget. `WorkerDaemon.start()` does a one-shot
  // `GET /api/health` check up front and throws on failure — if that
  // throws, the .catch logs once and the worker is dead until process
  // restart (no exponential-retry built into the daemon). Future
  // hardening could re-spawn on startup failure, but the listen-callback
  // ordering in start-local.ts / server.ts already makes this path
  // succeed in practice.
  void daemon
    .start()
    .then(() => logger.info({ workerId }, '[embedded-worker] stopped cleanly'))
    .catch((err) => {
      logger.error(
        { err, workerId },
        '[embedded-worker] failed to start or crashed mid-loop; runs(run_type=sync) will not drain until restart'
      );
    });

  logger.info({ workerId, apiUrl }, '[embedded-worker] started');

  return {
    stop: () => daemon.stop(),
    wait: (timeoutMs?: number) => daemon.waitForActiveJobs(timeoutMs),
  };
}
