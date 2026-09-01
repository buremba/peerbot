import { ShellInputError, runShellBuiltin } from './os-shell.js';

export type DaemonBuiltinErrorCode =
  | 'invalid_operation_input'
  | 'operation_backend_unavailable'
  | 'operation_execution_failed';

export type DaemonBuiltinResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: DaemonBuiltinErrorCode; error: string; output?: Record<string, unknown> };

export async function executeDaemonBuiltin(params: {
  connectorKey: string;
  actionKey: string;
  input: Record<string, unknown>;
  shutdownSignal?: AbortSignal;
}): Promise<DaemonBuiltinResult> {
  if (params.connectorKey !== 'os.shell' || params.actionKey !== 'run') {
    return {
      ok: false,
      code: 'operation_backend_unavailable',
      error: `No daemon built-in is registered for '${params.connectorKey}/${params.actionKey}'`,
    };
  }

  try {
    const output = await runShellBuiltin(params.input, params.shutdownSignal);
    if (!output.success) {
      return {
        ok: false,
        code: 'operation_execution_failed',
        error: output.timed_out
          ? `Shell command timed out after ${output.duration_ms}ms`
          : `Shell command exited with code ${output.exit_code}`,
        output: { ...output },
      };
    }
    return { ok: true, output: { ...output } };
  } catch (error) {
    // Only the builtin's own argument checks are input faults. Anything else
    // reaching here -- a spawn failure, an ENOTDIR on a cwd that turned out to
    // be a file -- is an execution fault, and reporting it as bad input would
    // send the caller off to fix a payload that was fine.
    return {
      ok: false,
      code: error instanceof ShellInputError ? 'invalid_operation_input' : 'operation_execution_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
