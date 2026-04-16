/**
 * Worker-side MCP-as-CLI bootstrap for embedded deployment mode.
 *
 * Registers one `just-bash` custom command per MCP server (e.g. `owletto`,
 * `gmail`). The agent invokes MCP tools via the sandboxed bash:
 *
 *   owletto search_knowledge <<<'{"query":"foo"}'
 *   owletto --help
 *   owletto save_knowledge --schema
 *   owletto auth login
 *
 * Payload is read from `ctx.stdin` as JSON. If stdin is empty, falls back to
 * `args[1]` as a JSON string (defense-in-depth for models that write the JSON
 * inline).
 */
import type { McpStatus, McpToolDef } from "@lobu/core";
import { createLogger } from "@lobu/core";
import type { GatewayParams } from "../shared/tool-implementations";
import { callMcpTool } from "../shared/tool-implementations";
import { isDirectPackageInstallCommand } from "../openclaw/tool-policy";

const logger = createLogger("mcp-cli");

/** Names reserved by just-bash / POSIX shells that we must not shadow. */
const RESERVED_COMMAND_NAMES = new Set([
  "cd",
  "echo",
  "export",
  "test",
  "true",
  "false",
  "pwd",
  "set",
  "unset",
  "exit",
  "source",
  ".",
  ":",
  "[",
]);

/**
 * Mutable snapshot of MCP session state. CLI handlers read through `current`
 * so that `auth login|check|logout` can refresh tools/state via `refresh()`
 * without rebuilding the Bash instance. New servers discovered after startup
 * are not retro-registered — they require a worker restart.
 */
export interface McpRuntimeState {
  mcpTools: Record<string, McpToolDef[]>;
  mcpStatus: McpStatus[];
  mcpContext: Record<string, string>;
}

export interface McpRuntimeRef {
  current: McpRuntimeState;
  /** Re-fetch session context and return a fresh snapshot, or `null` on failure. */
  refresh?: () => Promise<McpRuntimeState | null>;
}

export interface McpCliCommand {
  name: string;
  execute: (
    args: string[],
    ctx: { stdin?: string; signal?: AbortSignal }
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface McpCliDeps {
  callTool: typeof callMcpTool;
}

const DEFAULT_DEPS: McpCliDeps = {
  callTool: callMcpTool,
};

/** Check whether an MCP id would collide with a bash builtin or deny-prefix. */
export function isMcpIdReserved(mcpId: string): string | null {
  if (RESERVED_COMMAND_NAMES.has(mcpId)) {
    return `reserved bash builtin`;
  }
  // Probe against the package-install denylist using invocations that match
  // its actual patterns (install/add/require/upgrade/etc.).
  const probes = [
    `${mcpId} install`,
    `${mcpId} i`,
    `${mcpId} add`,
    `${mcpId} upgrade`,
    `${mcpId} require`,
    mcpId,
  ];
  if (probes.some((p) => isDirectPackageInstallCommand(p))) {
    return `matches package-install denylist`;
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function renderHelp(
  mcpId: string,
  state: McpRuntimeState
): { stdout: string; exitCode: number } {
  const tools = state.mcpTools[mcpId] ?? [];
  const status = state.mcpStatus.find((s) => s.id === mcpId);
  const contextPrefix = state.mcpContext[mcpId];
  const lines: string[] = [];

  lines.push(`${mcpId} — MCP server CLI`);
  if (contextPrefix) {
    lines.push(contextPrefix);
  }
  lines.push("");
  lines.push("Usage:");
  lines.push(`  ${mcpId} <tool> <<'EOF'`);
  lines.push(`  { ...json args... }`);
  lines.push(`  EOF`);
  lines.push("");
  lines.push(`  ${mcpId} <tool> --schema     # print the JSON schema`);
  lines.push(`  ${mcpId} --help              # this message`);
  if (status?.requiresAuth) {
    lines.push(`  ${mcpId} auth login|check|logout`);
  }
  lines.push("");

  if (tools.length === 0) {
    lines.push(
      "(no tools discovered — the server may need authentication or configuration)"
    );
  } else {
    lines.push("Tools:");
    for (const tool of tools) {
      const desc = truncate(tool.description ?? "", 80);
      lines.push(`  ${tool.name}${desc ? `  ${desc}` : ""}`);
    }
  }

  return { stdout: `${lines.join("\n")}\n`, exitCode: 0 };
}

function findTool(
  mcpId: string,
  toolName: string,
  state: McpRuntimeState
): McpToolDef | undefined {
  return state.mcpTools[mcpId]?.find((t) => t.name === toolName);
}

export function parsePayload(
  stdin: string | undefined,
  inlineArg: string | undefined
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const raw = (stdin && stdin.trim()) || (inlineArg && inlineArg.trim()) || "";
  if (!raw) {
    return { ok: true, payload: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "expected a JSON object payload" };
    }
    return { ok: true, payload: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Build the execute handler for a single MCP server CLI.
 * Exposed for unit testing.
 */
export function buildMcpServerHandler(
  mcpId: string,
  ref: McpRuntimeRef,
  gw: GatewayParams,
  deps: McpCliDeps = DEFAULT_DEPS
): McpCliCommand["execute"] {
  return async (args, ctx) => {
    const subcommand = args[0];
    const state = ref.current;

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      const { stdout, exitCode } = renderHelp(mcpId, state);
      return { stdout, stderr: "", exitCode };
    }

    if (subcommand === "auth") {
      return runAuthSubcommand(mcpId, args.slice(1), gw, ref);
    }

    // <tool> --schema
    if (args[1] === "--schema") {
      const tool = findTool(mcpId, subcommand, state);
      if (!tool) {
        return {
          stdout: "",
          stderr: `unknown tool: ${subcommand}. Run \`${mcpId} --help\`.\n`,
          exitCode: 2,
        };
      }
      const schema = tool.inputSchema ?? {};
      return {
        stdout: `${JSON.stringify(schema, null, 2)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // <tool> [json]
    const tool = findTool(mcpId, subcommand, state);
    if (!tool) {
      return {
        stdout: "",
        stderr: `unknown tool: ${subcommand}. Run \`${mcpId} --help\`.\n`,
        exitCode: 2,
      };
    }

    const parsed = parsePayload(ctx.stdin, args[1]);
    if (!parsed.ok) {
      return { stdout: "", stderr: `${parsed.error}\n`, exitCode: 2 };
    }

    try {
      const result = await deps.callTool(gw, mcpId, subcommand, parsed.payload);
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return { stdout: text ? `${text}\n` : "", stderr: "", exitCode: 0 };
    } catch (err) {
      return {
        stdout: "",
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  };
}

async function refreshRef(
  ref: McpRuntimeRef,
  mcpId: string,
  verb: string
): Promise<void> {
  if (!ref.refresh) return;
  try {
    const fresh = await ref.refresh();
    if (fresh) ref.current = fresh;
  } catch (err) {
    logger.warn(
      `Failed to refresh MCP state after ${mcpId} auth ${verb}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function runAuthSubcommand(
  mcpId: string,
  args: string[],
  gw: GatewayParams,
  ref: McpRuntimeRef
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const verb = args[0];
  // Lazy import to avoid a heavy dependency cycle in tests.
  const impl = await import("../shared/tool-implementations");

  if (verb === "login") {
    const res = await impl.startMcpLogin(gw, { mcpId });
    const text = extractText(res.content);
    return {
      stdout: `${summariseAuthStart(text, mcpId)}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (verb === "check") {
    const res = await impl.checkMcpLogin(gw, { mcpId });
    const text = extractText(res.content);
    const parsed = tryJson(text);
    if (parsed?.authenticated === true) {
      await refreshRef(ref, mcpId, "check");
    }
    return {
      stdout: `${summariseAuthCheck(parsed, mcpId, text)}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  if (verb === "logout") {
    const res = await impl.logoutMcp(gw, { mcpId });
    const text = extractText(res.content);
    // Tools that required auth are now unreachable — refresh so the next
    // invocation sees the empty state.
    await refreshRef(ref, mcpId, "logout");
    return { stdout: `${text}\n`, stderr: "", exitCode: 0 };
  }

  return {
    stdout: "",
    stderr: `unknown auth subcommand: ${verb ?? "(none)"}. Use login|check|logout.\n`,
    exitCode: 2,
  };
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        c.type === "text" && typeof c.text === "string"
    )
    .map((c) => c.text)
    .join("\n");
}

export function summariseAuthStart(rawText: string, mcpId: string): string {
  const parsed = tryJson(rawText);
  if (!parsed) return rawText;
  if (parsed.status === "already_authenticated") {
    return JSON.stringify({ status: "already_authenticated", mcp_id: mcpId });
  }
  if (parsed.status === "login_started") {
    const interactionPosted = Boolean(parsed.interaction_posted);
    // If the link-button side-channel didn't fire, fall back to the raw payload
    // so the verification URL + user_code remain reachable by the model.
    if (!interactionPosted) return rawText;
    return JSON.stringify({
      status: "login_started",
      mcp_id: mcpId,
      interaction_posted: true,
      message: `Login link sent directly to the user. Run \`${mcpId} auth check\` after they confirm.`,
    });
  }
  return rawText;
}

export function summariseAuthCheck(
  parsed: Record<string, unknown> | null,
  mcpId: string,
  fallback: string
): string {
  if (!parsed) return fallback;
  return JSON.stringify({
    status: parsed.status ?? "unknown",
    mcp_id: mcpId,
    authenticated: parsed.authenticated ?? false,
  });
}

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Build one command per MCP server in `ref.current.mcpStatus`, including
 * servers that currently have no discovered tools (so `<server> auth login`
 * still works for unauthenticated servers).
 */
export function buildMcpCliCommands(
  ref: McpRuntimeRef,
  gw: GatewayParams,
  deps: Partial<McpCliDeps> = {}
): McpCliCommand[] {
  const resolvedDeps: McpCliDeps = { ...DEFAULT_DEPS, ...deps };
  const state = ref.current;
  const serverIds = new Set<string>([
    ...Object.keys(state.mcpTools ?? {}),
    ...(state.mcpStatus ?? []).map((s) => s.id),
  ]);

  const commands: McpCliCommand[] = [];
  for (const mcpId of serverIds) {
    const reserved = isMcpIdReserved(mcpId);
    if (reserved) {
      logger.warn(
        `Skipping MCP CLI registration for "${mcpId}" — ${reserved}. Rename the MCP server to enable CLI mode.`
      );
      continue;
    }
    commands.push({
      name: mcpId,
      execute: buildMcpServerHandler(mcpId, ref, gw, resolvedDeps),
    });
  }
  return commands;
}
