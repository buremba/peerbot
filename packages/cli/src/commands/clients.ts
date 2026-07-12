/**
 * Connected-client commands over `/api/<org>/clients` — the org's MCP OAuth
 * clients plus messaging identities. Revoke kills an MCP client's tokens and
 * live sessions; messaging clients have no revoke (they are platform users).
 */

import chalk from "chalk";
import { resolveApiClient } from "../internal/index.js";
import { printJson } from "../internal/output.js";
import type { CloudCommandOptions } from "./_lib/cloud-options.js";

interface ClientRecord {
  id: string;
  kind: "mcp" | "messaging";
  title: string | null;
  identifier: string | null;
  platform: string | null;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  status: string;
  authState: string;
  lastSeenAt: number | null;
  firstParty: boolean;
}

export async function clientsListCommand(
  options: CloudCommandOptions & { agent?: string } = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const query = options.agent
    ? `?agentId=${encodeURIComponent(options.agent)}`
    : "";
  const { clients } = await client.get<{ clients: ClientRecord[] }>(
    `/api/${orgSlug}/clients${query}`
  );

  if (options.json) {
    printJson(clients);
    return;
  }

  if (clients.length === 0) {
    console.log(chalk.dim(`\n  No connected clients in org ${orgSlug}.\n`));
    return;
  }

  console.log(chalk.bold(`\n  Connected clients in ${orgSlug}`));
  for (const record of clients) {
    const dot =
      record.status === "connected" || record.status === "linked"
        ? chalk.green("●")
        : chalk.dim("○");
    const title = record.title ?? record.identifier ?? record.id;
    const platform = record.platform ? chalk.dim(` ${record.platform}`) : "";
    const agent = record.assignedAgentName
      ? chalk.dim(` → ${record.assignedAgentName}`)
      : "";
    const firstParty = record.firstParty ? chalk.dim(" [lobu]") : "";
    const lastSeen = record.lastSeenAt
      ? chalk.dim(`  last seen ${new Date(record.lastSeenAt).toISOString()}`)
      : "";
    console.log(
      `  ${dot} ${chalk.bold(title)} ${chalk.dim(`(${record.kind})`)}${platform}${agent}${firstParty}${lastSeen}`
    );
    if (record.kind === "mcp") {
      console.log(chalk.dim(`    id: ${record.id}`));
    }
  }
  console.log(
    chalk.dim("\n  Revoke an MCP client: lobu clients revoke <id> --yes\n")
  );
}

export async function clientsRevokeCommand(
  clientId: string,
  options: CloudCommandOptions & { yes?: boolean } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to revoke without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  await client.delete(
    `/api/${orgSlug}/clients/mcp/${encodeURIComponent(clientId)}`
  );
  console.log(chalk.green(`\n  Revoked MCP client ${clientId}.\n`));
}
