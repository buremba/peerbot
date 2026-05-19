import type { AuthResult, EventEnvelope, SyncCredentials } from '@lobu/connector-sdk';

/**
 * Executor mode discriminator. The executor speaks the same V1 SDK shapes
 * the connector code expects — no more magic `__action_key` / `__feed_key` /
 * `__auth_mode` packing.
 */
export type ExecutorJob =
  | {
      mode: 'sync';
      feedKey?: string | null;
      config: Record<string, unknown>;
      checkpoint: Record<string, unknown> | null;
      entityIds: number[];
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      mode: 'action';
      actionKey: string;
      actionInput: Record<string, unknown>;
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      mode: 'authenticate';
      config: Record<string, unknown>;
      previousCredentials: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    };

/**
 * Result shape returned by the executor. One discriminated union per mode
 * mirrors the SDK's `SyncResult` / `ActionResult` / `AuthResult` directly.
 */
export type ExecutorResult =
  | {
      mode: 'sync';
      events: EventEnvelope[];
      checkpoint: Record<string, unknown> | null;
      auth_update?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
    }
  | {
      mode: 'action';
      output: Record<string, unknown>;
    }
  | {
      mode: 'authenticate';
      auth: AuthResult;
    };

export interface ExecutionHooks {
  /** Sync runs: connector streamed a chunk of events (and we should persist them). */
  onEventChunk?: (events: EventEnvelope[]) => Promise<void> | void;
  /** Sync runs: connector pushed an incremental checkpoint update. */
  onCheckpointUpdate?: (checkpoint: Record<string, unknown> | null) => Promise<void> | void;
  /** Auth runs: connector emitted an artifact (QR/redirect/prompt/status). */
  onAuthArtifact?: (artifact: Record<string, unknown>) => Promise<void> | void;
  /** Auth runs: connector paused until a named signal arrives. */
  onAwaitAuthSignal?: (
    name: string,
    options?: { timeoutMs?: number }
  ) => Promise<Record<string, unknown>>;
}

/**
 * Pluggable executor interface. The only implementation today is
 * `SubprocessExecutor`; the seam stays around so tests can stub it.
 */
export interface SyncExecutor {
  execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks
  ): Promise<ExecutorResult>;
}
