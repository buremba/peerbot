/**
 * @owletto/worker
 *
 * Self-hosted worker for content intelligence.
 * Includes subprocess executor and embedding generation.
 *
 * Usage:
 *   connector-worker daemon --api-url https://api.example.com
 */

export type {
  CompleteRequest,
  ContentItem,
  DaemonConfig,
  ExecutorConfig,
  PollResponse,
  StreamBatch,
  WorkerCapabilities,
} from './daemon/index.js';
// Worker Daemon
export { executeRun, startDaemon, WorkerClient, WorkerDaemon } from './daemon/index.js';

// Types
export type { Env } from './types.js';
