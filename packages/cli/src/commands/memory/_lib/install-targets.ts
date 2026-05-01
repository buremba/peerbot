import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openInBrowser } from "./browser.js";
import { checkMemoryHealth, configureMemoryPlugin } from "./openclaw-cmd.js";

interface ConfigureResult {
  status: "configured" | "handoff" | "manual" | "failed";
  message: string;
}

interface InstallTarget {
  id: string;
  name: string;
  mode: "auto" | "handoff" | "manual";
  configure: (mcpUrl: string) => Promise<ConfigureResult>;
  manualInstructions?: (mcpUrl: string) => string;
}

function runCommand(cmd: string, args: string[], timeoutMs = 30_000): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildCursorInstallLink(mcpUrl: string): string {
  const config = Buffer.from(JSON.stringify({ url: mcpUrl })).toString(
    "base64"
  );
  const params = new URLSearchParams({ name: "lobu", config });
  return `https://cursor.com/en-US/install-mcp?${params.toString()}`;
}

function getCursorMcpConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function upsertCursorMcpServer(
  mcpUrl: string
): "added" | "updated" | "unchanged" {
  const path = getCursorMcpConfigPath();
  mkdirSync(dirname(path), { recursive: true });

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw) config = JSON.parse(raw) as Record<string, unknown>;
  }

  const existingMcpServers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const currentServers = { ...existingMcpServers } as Record<string, unknown>;
  const currentLobu = currentServers.lobu;
  const nextLobu = { url: mcpUrl };

  const wasConfigured =
    currentLobu &&
    typeof currentLobu === "object" &&
    "url" in currentLobu &&
    (currentLobu as { url?: unknown }).url === mcpUrl;

  currentServers.lobu = nextLobu;
  config.mcpServers = currentServers;

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  if (wasConfigured) return "unchanged";
  return currentLobu ? "updated" : "added";
}

export const INSTALL_TARGETS: InstallTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    mode: "auto",
    async configure(mcpUrl) {
      try {
        runCommand("claude", [
          "mcp",
          "add",
          "--transport",
          "http",
          "lobu",
          mcpUrl,
        ]);
        return { status: "configured", message: "MCP server added" };
      } catch (e) {
        return { status: "failed", message: (e as Error).message };
      }
    },
  },
  {
    id: "codex",
    name: "Codex",
    mode: "auto",
    async configure(mcpUrl) {
      try {
        runCommand("codex", ["mcp", "add", "lobu", "--url", mcpUrl]);
        return { status: "configured", message: "MCP server added" };
      } catch (e) {
        return { status: "failed", message: (e as Error).message };
      }
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    mode: "auto",
    async configure(mcpUrl) {
      try {
        runCommand("gemini", [
          "mcp",
          "add",
          "--transport",
          "http",
          "lobu",
          mcpUrl,
        ]);
        return { status: "configured", message: "MCP server added" };
      } catch (e) {
        return { status: "failed", message: (e as Error).message };
      }
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    mode: "auto",
    async configure(mcpUrl) {
      try {
        runCommand("openclaw", ["plugins", "install", "@lobu/openclaw-plugin"]);
      } catch (e) {
        return {
          status: "failed",
          message: `Plugin install failed: ${(e as Error).message}`,
        };
      }
      try {
        configureMemoryPlugin({ url: mcpUrl });
      } catch (e) {
        return {
          status: "failed",
          message: `Configure failed: ${(e as Error).message}`,
        };
      }
      try {
        await checkMemoryHealth({ url: mcpUrl });
        return {
          status: "configured",
          message: "Plugin installed and verified",
        };
      } catch (e) {
        return {
          status: "failed",
          message: `Health check failed: ${(e as Error).message}`,
        };
      }
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    mode: "auto",
    async configure(mcpUrl) {
      try {
        const action = upsertCursorMcpServer(mcpUrl);
        if (action === "unchanged") {
          return {
            status: "configured",
            message: "MCP server already configured in Cursor",
          };
        }
        return {
          status: "configured",
          message:
            action === "added"
              ? "MCP server added to Cursor config"
              : "MCP server updated in Cursor config",
        };
      } catch (error) {
        const link = buildCursorInstallLink(mcpUrl);
        const opened = openInBrowser(link);
        if (opened) {
          return {
            status: "handoff",
            message: `Could not update ~/.cursor/mcp.json automatically (${(error as Error).message}); opened Cursor install link`,
          };
        }
        return {
          status: "failed",
          message: `Cursor config update failed: ${(error as Error).message}`,
        };
      }
    },
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    mode: "manual",
    async configure() {
      return { status: "manual", message: "Finish setup in ChatGPT settings" };
    },
    manualInstructions(mcpUrl) {
      return `Settings → Integrations → Model Context Protocol → Add Server\nName: Lobu\nURL: ${mcpUrl}`;
    },
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    mode: "manual",
    async configure() {
      return { status: "manual", message: "Finish setup in Claude settings" };
    },
    manualInstructions(mcpUrl) {
      return `Settings → Connectors → Add Custom Connector\nURL: ${mcpUrl}\nEnable the connector so it shows up in Claude search.`;
    },
  },
];

export function getInstallTarget(id: string): InstallTarget | undefined {
  return INSTALL_TARGETS.find((t) => t.id === id);
}
