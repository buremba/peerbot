/**
 * @owletto/worker
 *
 * Self-hosted worker for content intelligence.
 * Includes subprocess executor and embedding generation.
 *
 * When launched with DEPLOYMENT_MODE=embedded (by the Lobu orchestrator),
 * bootstraps a Lobu worker that connects to the gateway via SSE.
 *
 * Usage:
 *   owletto-worker daemon --api-url https://api.example.com
 */

export type {
  CompleteRequest,
  ContentItem,
  DaemonConfig,
  ExecutorConfig,
  PollResponse,
  StreamBatch,
  WorkerCapabilities,
} from './daemon';
// Worker Daemon
export { executeRun, startDaemon, WorkerClient, WorkerDaemon } from './daemon';

// Types
export type { Env } from './types';

// ---------- Lobu embedded worker bootstrap ----------
// The orchestrator spawns this file as a subprocess with DEPLOYMENT_MODE=embedded.
// Fix DISPATCHER_URL (orchestrator sets port 8080, but our gateway runs on the app port)
// then delegate to @lobu/worker which handles the full SSE lifecycle, AI provider calls, etc.

if (process.env.DEPLOYMENT_MODE === 'embedded') {
  const appPort = process.env.PORT || '8787';
  process.env.DISPATCHER_URL = `http://localhost:${appPort}/lobu`;

  import('@lobu/worker').catch((err) => {
    console.error('[lobu-worker] Failed to load @lobu/worker:', err.message);
    process.exit(1);
  });
}
