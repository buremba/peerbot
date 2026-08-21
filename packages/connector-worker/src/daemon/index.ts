/**
 * Daemon Module
 *
 * Exports worker daemon, client, and executor.
 */

export type {
  CompleteRequest,
  ContentItem,
  PollResponse,
  StreamBatch,
  WorkerCapabilities,
} from './client.js';
export { WorkerClient } from './client.js';
export type { ExecutorConfig } from './executor.js';
export { executeRun } from './executor.js';
export type { DaemonConfig } from './worker.js';
export { startDaemon, WorkerDaemon } from './worker.js';
export { startDaemonCommand, type DaemonStartOptions } from './start.js';
export { executeClaimedAutomationRun, UnexecutableRunError } from './execute-run.js';
export {
  attachClaudeAutomation,
  DEFAULT_CLAUDE_ATTACHMENTS_FILE,
  detachClaudeAutomation,
  getClaudeAutomationAttachment,
  listClaudeAutomationAttachments,
  type ClaudeAutomationAttachment,
} from './claude-attachments.js';
export {
  DEFAULT_CLAUDE_SESSIONS_DIR,
  resolveClaudeSession,
  type ClaudeSessionResolverOptions,
  type ResolvedClaudeSession,
} from './claude-session.js';
