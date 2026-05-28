import type { AuthResult, EventEnvelope, SyncCredentials } from '@lobu/connector-sdk';

/**
 * Executor mode discriminator. The executor speaks the same V1 SDK shapes
 * the connector code expects: `SyncContext` / `ActionContext` / `AuthContext`
 * in, `SyncResult` / `ActionResult` / `AuthResult` out, no envelope.
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
 * mirrors the SDK's `ActionResult` / `AuthResult` directly. Sync is
 * streaming-only: events leave via `hooks.onEventChunk`, never collected
 * onto the result — callers that need a list build it themselves in the
 * hook (see e.g. `packages/cli/src/commands/_lib/connector-run-cmd.ts`).
 */
export type ExecutorResult =
  | {
      mode: 'sync';
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
  /**
   * Sync runs: connector code invoked
   * `ctx.sessionState.chrome_dispatcher.dispatch(actionKey, actionInput)`.
   * The host (connector-worker daemon) forwards the call to the gateway
   * (POST /api/workers/dispatch-chrome-action), which inserts a chrome
   * connector action run, waits for the paired Owletto extension to claim
   * and complete it, and returns the observation. Implementations MUST
   * reject when no extension is reachable.
   */
  onChromeDispatch?: (
    actionKey: string,
    actionInput: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

/** Per-run execution options independent of the job payload. */
export interface ExecutionOptions {
  /**
   * Native system packages (nixpkgs attribute refs) the connector declared in
   * its `runtime.nix.packages`. When non-empty, the embedded executor wraps the
   * child process in `nix-shell -p <packages>` so the tools are on PATH.
   */
  nixPackages?: string[];
}

/**
 * Pluggable executor interface. The only implementation today is
 * `SubprocessExecutor`; the seam stays around so tests can stub it.
 */
export interface SyncExecutor {
  execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks,
    options?: ExecutionOptions
  ): Promise<ExecutorResult>;
}
