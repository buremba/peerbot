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
