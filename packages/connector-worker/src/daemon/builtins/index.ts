import { runShellBuiltin } from './os-shell.js';

export type DaemonBuiltinErrorCode =
  | 'invalid_operation_input'
  | 'operation_backend_unavailable'
  | 'operation_execution_failed';

export type DaemonBuiltinResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; code: DaemonBuiltinErrorCode; error: string };

export async function executeDaemonBuiltin(params: {
  connectorKey: string;
  actionKey: string;
  input: Record<string, unknown>;
}): Promise<DaemonBuiltinResult> {
  if (params.connectorKey !== 'os.shell' || params.actionKey !== 'run') {
    return {
      ok: false,
      code: 'operation_backend_unavailable',
      error: `No daemon built-in is registered for '${params.connectorKey}/${params.actionKey}'`,
    };
  }

  try {
    const output = await runShellBuiltin(params.input);
    if (!output.success) {
      return {
        ok: false,
        code: 'operation_execution_failed',
        error: output.timed_out
          ? `Shell command timed out after ${output.duration_ms}ms`
          : `Shell command exited with code ${output.exit_code}`,
      };
    }
    return { ok: true, output: { ...output } };
  } catch (error) {
    return {
      ok: false,
      code: 'invalid_operation_input',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
