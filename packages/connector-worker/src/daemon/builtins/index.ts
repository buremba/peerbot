import { ShellInputError, type ShellRunOutput, runShellBuiltin } from './os-shell.js';

export type DaemonBuiltinErrorCode =
  | 'invalid_operation_input'
  | 'operation_backend_unavailable'
  | 'operation_execution_failed';

export type DaemonBuiltinResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: DaemonBuiltinErrorCode; error: string; output?: Record<string, unknown> };

function describeShellFailure(output: ShellRunOutput): string {
  if (output.timed_out) {
    return `Shell command timed out after ${output.duration_ms}ms`;
  }
  if (output.process_error) {
    const code = output.process_error_code
      ? ` (${output.process_error_code})`
      : '';
    const prefix =
      output.process_stage === 'supervisor_spawn'
        ? 'Shell supervisor failed to start'
        : output.process_stage === 'target_spawn'
          ? 'Shell command failed to start'
          : output.process_stage === 'supervisor_exit'
            ? 'Shell supervisor exited before reporting the command outcome'
            : output.process_stage === 'shutdown'
              ? 'Shell command was aborted during daemon shutdown'
              : 'Shell execution failed';
    return `${prefix}${code}: ${output.process_error}`;
  }
  if (output.exit_signal) {
    return `Shell command terminated by ${output.exit_signal}`;
  }
  return `Shell command exited with code ${output.exit_code}`;
}

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
        error: describeShellFailure(output),
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
