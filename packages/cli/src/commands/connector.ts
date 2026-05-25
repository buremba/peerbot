import {
  printSelfCheckResult,
  runConnectorRuntimeSelfCheck,
} from "@lobu/connector-worker/self-check";
import {
  type ConnectorRunOptions,
  connectorRun,
} from "./_lib/connector-run-cmd.js";

export async function connectorRunCommand(
  connectorKey: string | undefined,
  options: ConnectorRunOptions
): Promise<void> {
  await connectorRun(options, connectorKey);
}

/**
 * `lobu connector runtime-self-check` — the CLI side of the connector-runtime
 * parity smoke gate. STATIC-imports the SAME `runConnectorRuntimeSelfCheck`
 * the worker image runs (`@lobu/connector-worker/self-check`); the parity
 * invariant is that both entrypoints call this one function over the same
 * compile + default `SubprocessExecutor` path. Internal/CI-only — not user
 * facing (no auth, no network), so it's registered hidden in index.ts.
 */
export async function connectorRuntimeSelfCheckCommand(options: {
  json?: boolean;
}): Promise<void> {
  const result = await runConnectorRuntimeSelfCheck({ surface: "cli" });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printSelfCheckResult(result);
  }
  process.exitCode = result.ok ? 0 : 1;
}
