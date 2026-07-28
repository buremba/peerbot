import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type BashCommandPolicy,
  enforceBashCommandPolicy,
  isDirectPackageInstallCommand,
} from "./tool-policy";
import { buildAgentEnv } from "../shared/worker-env-keys";

type RequiredParamGroup = {
  keys: readonly string[];
  label?: string;
};

const CLAUDE_PARAM_GROUPS: Record<
  "read" | "write" | "edit",
  RequiredParamGroup[]
> = {
  read: [{ keys: ["file_path"], label: "file_path" }],
  write: [{ keys: ["file_path"], label: "file_path" }],
  edit: [
    { keys: ["file_path"], label: "file_path" },
    { keys: ["old_string"], label: "old_string" },
    { keys: ["new_string"], label: "new_string" },
  ],
};

// pi-coding-agent's underlying tools use camelCase (path/oldText/newText);
// our schema exposes snake_case to the LLM. Translate before calling through.
function normalizeToolParams(
  params: unknown
): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const normalized = { ...record };

  if ("file_path" in normalized) {
    normalized.path = normalized.file_path;
    delete normalized.file_path;
  }
  if ("old_string" in normalized) {
    normalized.oldText = normalized.old_string;
    delete normalized.old_string;
  }
  if ("new_string" in normalized) {
    normalized.newText = normalized.new_string;
    delete normalized.new_string;
  }
  return normalized;
}

function assertRequiredParams(
  params: Record<string, unknown>,
  groups: RequiredParamGroup[]
): void {
  for (const group of groups) {
    const hasValue = group.keys.some((key) => {
      const value = params[key];
      if (value === undefined || value === null) {
        return false;
      }
      if (typeof value === "string" && value.trim() === "") {
        return false;
      }
      return true;
    });
    if (!hasValue) {
      const label = group.label ?? group.keys.join(" or ");
      throw new Error(`Missing required parameter: ${label}`);
    }
  }
}

function wrapToolWithNormalization(params: {
  tool: AgentTool<any>;
  required: RequiredParamGroup[];
  schema: unknown;
}): AgentTool<any> {
  const { tool, required, schema } = params;
  return {
    ...tool,
    parameters: schema as any,
    execute: async (toolCallId, rawParams, signal, onUpdate) => {
      // Assert against the snake_case LLM surface BEFORE normalising,
      // since normalise rewrites to pi-coding-agent's camelCase keys.
      const sourceParams =
        rawParams && typeof rawParams === "object"
          ? (rawParams as Record<string, unknown>)
          : {};
      assertRequiredParams(sourceParams, required);
      const normalized = normalizeToolParams(rawParams) ?? {};
      return tool.execute(toolCallId, normalized as any, signal, onUpdate);
    },
  };
}

function buildReadSchema() {
  return Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    offset: Type.Optional(
      Type.Number({ description: "Start reading at this byte offset" })
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum bytes to read" })),
  });
}

function buildWriteSchema() {
  return Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    content: Type.String({ description: "Content to write" }),
  });
}

function buildEditSchema() {
  return Type.Object({
    file_path: Type.String({ description: "Path to the file" }),
    old_string: Type.String({ description: "Text to replace" }),
    new_string: Type.String({ description: "Replacement text" }),
  });
}

export function createLobuTools(
  cwd: string,
  options?: { bashOperations?: BashOperations; bashPolicy?: BashCommandPolicy }
): AgentTool<any>[] {
  const read = wrapToolWithNormalization({
    tool: createReadTool(cwd),
    required: CLAUDE_PARAM_GROUPS.read,
    schema: buildReadSchema(),
  });

  const write = wrapToolWithNormalization({
    tool: createWriteTool(cwd),
    required: CLAUDE_PARAM_GROUPS.write,
    schema: buildWriteSchema(),
  });

  const edit = wrapToolWithNormalization({
    tool: createEditTool(cwd),
    required: CLAUDE_PARAM_GROUPS.edit,
    schema: buildEditSchema(),
  });

  const bashToolOpts = {
    ...(options?.bashOperations ? { operations: options.bashOperations } : {}),
    spawnHook: (params: {
      command: string;
      cwd: string;
      env: Record<string, string | undefined>;
    }) => ({
      command: params.command,
      cwd: params.cwd,
      env: buildAgentEnv(params.env) as NodeJS.ProcessEnv,
    }),
  };
  const bash = wrapBashWithProxyHint(
    createBashTool(cwd, bashToolOpts),
    options?.bashPolicy
  );

  return [
    read,
    write,
    edit,
    bash,
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ];
}

function isDirectGatewayApiAccessCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  if (/\$(?:\{)?(?:DISPATCHER_URL|WORKER_TOKEN)\b/.test(trimmed)) {
    return true;
  }

  if (!/\b(?:curl|wget|http|httpie|fetch)\b/i.test(trimmed)) {
    return false;
  }

  if (!/\/(?:internal|mcp)(?:\/|\b)/i.test(trimmed)) {
    return false;
  }

  const gatewayTargets = new Set<string>([
    "http://gateway",
    "https://gateway",
    "gateway:",
    "http://dispatcher",
    "https://dispatcher",
    "dispatcher:",
    "http://localhost",
    "https://localhost",
    "localhost:",
    "http://127.0.0.1",
    "https://127.0.0.1",
    "127.0.0.1:",
  ]);

  const dispatcherUrl = process.env.DISPATCHER_URL?.trim();
  if (dispatcherUrl) {
    gatewayTargets.add(dispatcherUrl);
    gatewayTargets.add(dispatcherUrl.replace(/\/+$/, ""));
    try {
      const parsed = new URL(dispatcherUrl);
      gatewayTargets.add(`${parsed.protocol}//${parsed.host}`);
      gatewayTargets.add(parsed.host);
      gatewayTargets.add(parsed.hostname);
    } catch {
      // Ignore invalid dispatcher URLs and rely on static aliases.
    }
  }

  const normalized = trimmed.toLowerCase();
  return [...gatewayTargets].some((target) =>
    normalized.includes(target.toLowerCase())
  );
}

/**
 * The command-inspection gauntlet the hardened bash tool applies before it runs
 * anything. Extracted so BOTH the agent's tool wrapper (below) and the `!`-bash
 * intercept (which calls pi's `session.executeBash` for its transcript recording
 * and so bypasses the tool wrapper) enforce the SAME guards from one source of
 * truth. Throws on any violation; returns void when the command is allowed.
 * Order:
 *   - prefix allow/deny policy (`enforceBashCommandPolicy`)
 *   - direct-gateway-API-access block
 *   - direct-package-install block
 *
 * NOT included here: env allowlisting (`spawnHook`/`buildAgentEnv`, inside
 * `createBashTool`) and bash *removal* when policy disallows it (a tool-list
 * filter in the caller). The `!` intercept covers those separately: it selects
 * the same hardened `BashOperations` and only runs when bash survived the
 * removal filter.
 */
export function enforceBashPreflight(
  command: string,
  bashPolicy?: BashCommandPolicy
): void {
  if (bashPolicy) {
    enforceBashCommandPolicy(command, bashPolicy);
  }
  if (isDirectGatewayApiAccessCommand(command)) {
    throw new Error(
      "DIRECT GATEWAY API ACCESS BLOCKED. Use the registered MCP/auth tools instead of calling gateway /mcp or /internal endpoints from Bash."
    );
  }
  if (isDirectPackageInstallCommand(command)) {
    throw new Error(
      "DIRECT PACKAGE INSTALL BLOCKED. Install system packages with nixPackages in lobu.config.ts or agent settings instead of using package managers inside the worker."
    );
  }
}

/**
 * The single hardened bash entry point. Wraps the raw bash tool so any caller
 * that holds this tool object gets the full policy by construction — the agent's
 * tool loop routes through here. It runs {@link enforceBashPreflight} on the
 * extracted command, then, on failure, appends a proxy-403 hint (curl hides the
 * proxy CONNECT body, so the model would otherwise see only exit code 56, not
 * "Domain not allowed").
 *
 * Env allowlisting (`spawnHook`/`buildAgentEnv`) lives inside `createBashTool`;
 * bash *removal* when policy disallows it is a tool-list filter in the caller.
 */
function wrapBashWithProxyHint(
  tool: AgentTool<any>,
  bashPolicy?: BashCommandPolicy
): AgentTool<any> {
  const PROXY_403_PATTERN = /Received HTTP code 403 from proxy after CONNECT/i;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const command =
        params && typeof params === "object" && "command" in params
          ? String((params as { command?: unknown }).command ?? "")
          : "";
      enforceBashPreflight(command, bashPolicy);
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (PROXY_403_PATTERN.test(msg)) {
          throw new Error(
            `DOMAIN BLOCKED BY PROXY. The domain is blocked at the network level. Network access is configured via lobu.config.ts or the gateway configuration APIs — do NOT retry the request.\n\n${msg}`
          );
        }
        throw err;
      }
    },
  };
}
