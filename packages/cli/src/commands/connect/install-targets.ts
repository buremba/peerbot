import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOBU_MCP_URL } from "../../internal/context.js";

const MARKETPLACE_SOURCE = "lobu-ai/lobu";
// Claude Code clones the marketplace source in full, which for this monorepo is
// ~62MB of checkout to reach two small plugin directories. Restricting it to the
// marketplace and plugin roots brings the same install down to ~2MB.
const MARKETPLACE_SPARSE_PATHS = [".claude-plugin", "claude-plugin"];
const __dirname = dirname(fileURLToPath(import.meta.url));

interface CommandStep {
  command: string;
  args: string[];
  allowAlreadyPresent?: boolean;
}

export interface ConnectPlan {
  id: ConnectTargetId;
  name: string;
  mode: "automatic" | "manual";
  commands: CommandStep[];
  endpoint?: string;
  serverName?: string;
  configUrlKey?: "serverUrl" | "url";
  skillDirectory?: string;
  instructions?: string;
}

export interface ConfigureResult {
  status: "configured" | "handoff" | "manual" | "failed";
  message: string;
  instructions?: string;
}

function isDefaultHostedEndpoint(mcpUrl: string): boolean {
  return mcpUrl.replace(/\/$/, "") === DEFAULT_LOBU_MCP_URL;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function serverNameForEndpoint(mcpUrl: string): string {
  try {
    const pathSegments = new URL(mcpUrl).pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const workspace = pathSegments.at(-1);
    if (workspace && workspace !== "mcp") {
      const slug = workspace
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
      if (slug) return `lobu-${slug}`;
    }
  } catch {
    // The command validates the endpoint separately; keep setup actionable here.
  }
  return "lobu";
}

function formatCommand(step: CommandStep): string {
  return [step.command, ...step.args].map(shellQuote).join(" ");
}

function bundledSkillPath(): string {
  return join(
    __dirname,
    "..",
    "..",
    "bundled-skills",
    "lobu-connect",
    "SKILL.md"
  );
}

function installBundledSkill(
  targetDirectory: string
): "installed" | "current" | "updated" {
  const source = bundledSkillPath();
  if (!existsSync(source)) {
    throw new Error(
      `Bundled Lobu skill is missing at ${source}. Reinstall @lobu/cli and try again.`
    );
  }

  const destination = join(targetDirectory, "SKILL.md");
  const content = readFileSync(source, "utf8");
  if (existsSync(destination)) {
    const existing = readFileSync(destination, "utf8");
    if (existing === content) return "current";

    let backup = `${destination}.pre-lobu-connect`;
    let index = 2;
    while (existsSync(backup)) {
      backup = `${destination}.pre-lobu-connect-${index}`;
      index += 1;
    }
    writeFileSync(backup, existing, { encoding: "utf8", flag: "wx" });
    writeFileSync(destination, content, "utf8");
    return "updated";
  }

  mkdirSync(targetDirectory, { recursive: true });
  writeFileSync(destination, content, "utf8");
  return "installed";
}

function describeSkillState(
  state: "installed" | "current" | "updated"
): string {
  switch (state) {
    case "current":
      return "already current";
    case "updated":
      return "updated (previous copy backed up next to it)";
    case "installed":
      return "installed";
  }
}

function cursorConfigPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

function antigravityConfigPath(): string {
  return join(homedir(), ".gemini", "config", "mcp_config.json");
}

// Same resolution `opencode-plugin.ts` uses for the plugin directory, so a
// machine with XDG_CONFIG_HOME set gets both under the one config root.
function opencodeSkillPath(): string {
  const configRoot =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configRoot, "opencode", "skills", "lobu");
}

export function upsertMcpServer(
  path: string,
  serverName: string,
  mcpUrl: string,
  urlKey: "serverUrl" | "url"
): "added" | "updated" | "unchanged" {
  mkdirSync(dirname(path), { recursive: true });

  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw) config = JSON.parse(raw) as Record<string, unknown>;
  }

  const existingServers =
    config.mcpServers && typeof config.mcpServers === "object"
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  const servers = { ...existingServers };
  const existing = servers[serverName];
  const existingServer =
    existing !== null && typeof existing === "object"
      ? (existing as Record<string, unknown>)
      : {};
  const unchanged =
    urlKey in existingServer && existingServer[urlKey] === mcpUrl;

  if (unchanged) return "unchanged";

  // Preserve client-specific settings such as headers or disabled state when
  // updating an existing Lobu entry; this command owns only the endpoint URL.
  servers[serverName] = { ...existingServer, [urlKey]: mcpUrl };
  config.mcpServers = servers;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return existing ? "updated" : "added";
}

export const CONNECT_TARGET_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
  "chatgpt",
  "claude-desktop",
] as const;

export type ConnectTargetId = (typeof CONNECT_TARGET_IDS)[number];

export function buildConnectPlan(
  id: ConnectTargetId,
  mcpUrl: string
): ConnectPlan {
  const hosted = isDefaultHostedEndpoint(mcpUrl);
  const serverName = serverNameForEndpoint(mcpUrl);
  switch (id) {
    case "claude-code":
      if (hosted) {
        return {
          id,
          name: "Claude Code",
          mode: "automatic",
          commands: [
            {
              command: "claude",
              args: [
                "plugin",
                "marketplace",
                "add",
                MARKETPLACE_SOURCE,
                "--sparse",
                ...MARKETPLACE_SPARSE_PATHS,
              ],
              allowAlreadyPresent: true,
            },
            {
              command: "claude",
              args: ["plugin", "install", "lobu@lobu"],
              allowAlreadyPresent: true,
            },
          ],
          instructions:
            "Start a fresh Claude Code session and use a Lobu tool. Claude opens Lobu OAuth on first use.",
        };
      }
      return {
        id,
        name: "Claude Code",
        mode: "automatic",
        commands: [
          {
            command: "claude",
            args: [
              "mcp",
              "add",
              "--scope",
              "user",
              "--transport",
              "http",
              serverName,
              mcpUrl,
            ],
            allowAlreadyPresent: true,
          },
        ],
        serverName,
        skillDirectory: join(homedir(), ".claude", "skills", "lobu"),
        instructions: `Start a fresh Claude Code session and use a ${serverName} tool. Claude opens Lobu OAuth on first use.`,
      };
    case "codex":
      if (hosted) {
        return {
          id,
          name: "Codex",
          mode: "automatic",
          commands: [
            {
              command: "codex",
              args: ["plugin", "marketplace", "add", MARKETPLACE_SOURCE],
              allowAlreadyPresent: true,
            },
            {
              command: "codex",
              args: ["plugin", "add", "lobu@lobu"],
              allowAlreadyPresent: true,
            },
          ],
          instructions:
            "Start a fresh Codex session and use a Lobu tool. Codex opens Lobu OAuth on first use.",
        };
      }
      return {
        id,
        name: "Codex",
        mode: "automatic",
        commands: [
          {
            command: "codex",
            args: ["mcp", "add", serverName, "--url", mcpUrl],
            allowAlreadyPresent: true,
          },
        ],
        serverName,
        skillDirectory: join(
          process.env.CODEX_HOME || join(homedir(), ".codex"),
          "skills",
          "lobu"
        ),
        instructions:
          "Start a fresh Codex session and use a Lobu tool. Codex opens Lobu OAuth on first use.",
      };
    case "opencode":
      return {
        id,
        name: "OpenCode",
        mode: "automatic",
        commands: [
          {
            command: "opencode",
            args: ["mcp", "add", serverName, "--url", mcpUrl],
            allowAlreadyPresent: true,
          },
        ],
        serverName,
        skillDirectory: opencodeSkillPath(),
        instructions: `Run \`opencode mcp auth ${serverName}\` or use a Lobu tool to start OAuth.`,
      };
    case "antigravity":
      return {
        id,
        name: "Antigravity CLI",
        mode: "automatic",
        commands: [],
        endpoint: mcpUrl,
        serverName,
        configUrlKey: "serverUrl",
        skillDirectory: join(homedir(), ".gemini", "config", "skills", "lobu"),
        instructions:
          "Start a fresh Antigravity CLI session with `agy`, open `/mcp` to confirm Lobu is enabled, and use a Lobu tool to complete OAuth.",
      };
    case "cursor":
      return {
        id,
        name: "Cursor",
        mode: "automatic",
        commands: [],
        endpoint: mcpUrl,
        serverName,
        configUrlKey: "url",
        skillDirectory: join(homedir(), ".cursor", "skills", "lobu"),
        instructions:
          "Restart Cursor, enable the Lobu MCP server, and complete OAuth on first use.",
      };
    case "chatgpt":
      return {
        id,
        name: "ChatGPT",
        mode: "manual",
        commands: [],
        instructions: `Open Settings, enable developer mode, create a custom MCP connector named Lobu using ${mcpUrl}, and complete OAuth.`,
      };
    case "claude-desktop":
      return {
        id,
        name: "Claude Desktop",
        mode: "manual",
        commands: [],
        instructions: `Open Settings → Connectors → Add Custom Connector, enter ${mcpUrl}, enable Lobu, and complete OAuth.`,
      };
  }
}

function runCommand(step: CommandStep): void {
  try {
    execFileSync(step.command, step.args, {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = [
      error instanceof Error ? error.message : String(error),
      String((error as { stdout?: unknown }).stdout ?? ""),
      String((error as { stderr?: unknown }).stderr ?? ""),
    ]
      .join("\n")
      .toLowerCase();
    const alreadyPresent =
      output.includes("already") &&
      ["exist", "installed", "configured", "added", "present"].some((word) =>
        output.includes(word)
      );
    if (step.allowAlreadyPresent && alreadyPresent) return;
    throw error;
  }
}

export async function configureTarget(
  plan: ConnectPlan,
  options: { dryRun?: boolean } = {}
): Promise<ConfigureResult> {
  if (options.dryRun) {
    const commands = plan.commands.map(formatCommand);
    const skill = plan.skillDirectory
      ? `Install the Lobu skill at ${join(plan.skillDirectory, "SKILL.md")}`
      : undefined;
    const mcpConfig =
      plan.id === "antigravity"
        ? `Configure ${plan.serverName ?? "lobu"} in ${antigravityConfigPath()} with ${plan.configUrlKey} ${plan.endpoint}`
        : plan.id === "cursor"
          ? `Configure ${plan.serverName ?? "lobu"} in ${cursorConfigPath()} with ${plan.configUrlKey} ${plan.endpoint}`
          : undefined;
    return {
      status: plan.mode === "manual" ? "manual" : "handoff",
      message: "No changes made (--dry-run)",
      instructions: [...commands, mcpConfig, skill, plan.instructions]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (plan.id === "cursor" || plan.id === "antigravity") {
    try {
      const action = upsertMcpServer(
        plan.id === "antigravity"
          ? antigravityConfigPath()
          : cursorConfigPath(),
        plan.serverName ?? "lobu",
        plan.endpoint ?? DEFAULT_LOBU_MCP_URL,
        plan.configUrlKey ?? "url"
      );
      const skillState = plan.skillDirectory
        ? installBundledSkill(plan.skillDirectory)
        : undefined;
      const suffix = skillState
        ? `; Lobu skill ${describeSkillState(skillState)}`
        : "";
      return {
        status: "configured",
        message: `${plan.name} MCP configuration ${action}${suffix}`,
        instructions: plan.instructions,
      };
    } catch (error) {
      return {
        status: "failed",
        message: (error as Error).message,
      };
    }
  }

  if (plan.mode === "manual") {
    return {
      status: "manual",
      message: "Manual setup required",
      instructions: plan.instructions,
    };
  }

  try {
    for (const step of plan.commands) runCommand(step);
    const skillState = plan.skillDirectory
      ? installBundledSkill(plan.skillDirectory)
      : undefined;
    const suffix = skillState
      ? `; Lobu skill ${describeSkillState(skillState)}`
      : "";
    return {
      status: "configured",
      message: `Lobu installed${suffix}`,
      instructions: plan.instructions,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      message: `Could not configure ${plan.name}: ${message}`,
      instructions: [...plan.commands.map(formatCommand), plan.instructions]
        .filter(Boolean)
        .join("\n"),
    };
  }
}

export function isConnectTargetId(value: string): value is ConnectTargetId {
  return (CONNECT_TARGET_IDS as readonly string[]).includes(value);
}
