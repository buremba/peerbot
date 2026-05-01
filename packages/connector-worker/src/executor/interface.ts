import type { Checkpoint, Content, FeedOptions, SessionState } from '@lobu/connector-sdk';

/**
 * Result shape returned by the subprocess executor.
 * Mirrors the legacy SyncResult from the SDK (contents + checkpoint).
 */
export interface FeedSyncResult {
  contents: Content[];
  checkpoint: Checkpoint | null;
  metadata?: Record<string, any>;
  auth_update?: Record<string, any>;
  /** Set when the subprocess completed an authenticate() run. */
  auth_result?: {
    credentials: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Context passed to the executor for a single sync job
 */
export interface SyncContext {
  options: FeedOptions;
  checkpoint: Checkpoint | null;
  env: Record<string, string | undefined>;
  sessionState?: SessionState | null;
  apiType: 'api' | 'browser';
}

export interface ExecutionHooks {
  onContentChunk?: (items: Content[]) => Promise<void> | void;
  onCheckpointUpdate?: (checkpoint: Checkpoint | null) => Promise<void> | void;
  collectContents?: boolean;
  /** Auth runs: connector emits an artifact (QR/redirect/prompt/status). */
  onAuthArtifact?: (artifact: Record<string, unknown>) => Promise<void> | void;
  /** Auth runs: connector pauses until a named signal arrives. */
  onAwaitAuthSignal?: (
    name: string,
    options?: { timeoutMs?: number }
  ) => Promise<Record<string, unknown>>;
}

/**
 * Pluggable executor interface
 * Allows swapping between subprocess execution, direct execution, etc.
 */
export interface SyncExecutor {
  execute(
    compiledCode: string,
    context: SyncContext,
    hooks?: ExecutionHooks
  ): Promise<FeedSyncResult>;
}
