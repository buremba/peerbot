import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";

interface StatusResponse {
  agents: Array<{
    agentId: string;
    name: string;
    providers: string[];
    model: string;
  }>;
  connections: Array<{
    id: string;
    platform: string;
    status: string;
    templateAgentId: string | null;
    botUsername: string | null;
  }>;
  sandboxes: Array<{
    agentId: string;
    name: string;
    parentConnectionId: string | null;
    lastUsedAt: number | null;
  }>;
}

export async function statusCommand(cwd: string): Promise<void> {
  const { gatewayUrl, adminPassword } = await resolveConfig(cwd);

  let status: StatusResponse;
  try {
    const res = await fetch(`${gatewayUrl}/internal/status`, {
      headers: { Authorization: `Bearer ${adminPassword}` },
    });
    if (!res.ok) {
      if (res.status === 401) {
        console.log(
          chalk.red("\n  Unauthorized. Check ADMIN_PASSWORD in .env.\n")
        );
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    status = (await res.json()) as StatusResponse;
  } catch {
    console.log(chalk.yellow("\n  Gateway not reachable."));
    console.log(chalk.dim("  Start with `lobu run` to run your agents.\n"));
    return;
  }

  // Agents
  if (status.agents.length > 0) {
    console.log(chalk.bold.cyan("\n  Agents"));
    for (const a of status.agents) {
      const providers =
        a.providers.length > 0 ? a.providers.join(", ") : "none";
      console.log(
        `  ${chalk.green("●")} ${chalk.bold(a.name)} ${chalk.dim(`(${a.agentId})`)}  ${chalk.dim(`model:${a.model}  providers:${providers}`)}`
      );
    }
  } else {
    console.log(chalk.yellow("\n  No agents configured."));
  }

  // Connections
  if (status.connections.length > 0) {
    console.log(chalk.bold.cyan("\n  Connections"));
    for (const conn of status.connections) {
      const icon =
        conn.status === "connected" ? chalk.green("●") : chalk.red("●");
      const bot = conn.botUsername
        ? `@${conn.botUsername}`
        : conn.id.slice(0, 8);
      const agent = conn.templateAgentId
        ? chalk.dim(` → ${conn.templateAgentId}`)
        : "";
      console.log(
        `  ${icon} ${chalk.bold(conn.platform)} ${bot}${agent} ${chalk.dim(conn.status)}`
      );
    }
  }

  // Sandboxes
  if (status.sandboxes.length > 0) {
    console.log(chalk.bold.cyan("\n  Sandboxes"));
    for (const s of status.sandboxes) {
      const lastUsed = s.lastUsedAt
        ? chalk.dim(timeAgo(s.lastUsedAt))
        : chalk.dim("never");
      console.log(`  ${chalk.dim("○")} ${s.agentId} ${lastUsed}`);
    }
  }

  console.log();
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function resolveConfig(
  cwd: string
): Promise<{ gatewayUrl: string; adminPassword: string }> {
  let gatewayPort = "8080";
  let adminPassword = "";

  try {
    const envContent = await readFile(join(cwd, ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
      if (!match) continue;
      const key = match[1];
      let val = match[2] || "";
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key === "GATEWAY_PORT" && val) gatewayPort = val;
      if (key === "ADMIN_PASSWORD" && val) adminPassword = val;
    }
  } catch {
    // No .env file
  }

  if (!adminPassword) {
    adminPassword = process.env.ADMIN_PASSWORD || "";
  }

  return {
    gatewayUrl: `http://localhost:${gatewayPort}`,
    adminPassword,
  };
}
