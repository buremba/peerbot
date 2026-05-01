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
import { stripEnv } from "@lobu/core";
import { isDirectPackageInstallCommand } from "./tool-policy";
import { SENSITIVE_WORKER_ENV_KEYS } from "../shared/worker-env-keys";

type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
};

const CLAUDE_PARAM_GROUPS: Record<
  "read" | "write" | "edit",
  RequiredParamGroup[]
> = {
  read: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  write: [{ keys: ["path", "file_path"], label: "path (path or file_path)" }],
  edit: [
    { keys: ["path", "file_path"], label: "path (path or file_path)" },
    {
      keys: ["oldText", "old_string"],
      label: "oldText (oldText or old_string)",
    },
    {
      keys: ["newText", "new_string"],
      label: "newText (newText or new_string)",
    },
  ],
};

function normalizeToolParams(
  params: unknown
): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const normalized = { ...record };

  if ("file_path" in normalized && !("path" in normalized)) {
    normalized.path = normalized.file_path;
    delete normalized.file_path;
  }
  if ("old_string" in normalized && !("oldText" in normalized)) {
    normalized.oldText = normalized.old_string;
    delete normalized.old_string;
  }
  if ("new_string" in normalized && !("newText" in normalized)) {
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
      if (
        !group.allowEmpty &&
        typeof value === "string" &&
        value.trim() === ""
      ) {
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
      const normalized = normalizeToolParams(rawParams) ?? {};
      assertRequiredParams(normalized, required);
      return tool.execute(toolCallId, normalized as any, signal, onUpdate);
    },
  };
}

function buildReadSchema() {
  return Type.Object({
    path: Type.Optional(Type.String({ description: "Path to the file" })),
    file_path: Type.Optional(Type.String({ description: "Path to the file" })),
    offset: Type.Optional(
      Type.Number({ description: "Start reading at this byte offset" })
    ),
    limit: Type.Optional(Type.Number({ description: "Maximum bytes to read" })),
  });
}

function buildWriteSchema() {
  return Type.Object({
    path: Type.Optional(Type.String({ description: "Path to the file" })),
    file_path: Type.Optional(Type.String({ description: "Path to the file" })),
    content: Type.String({ description: "Content to write" }),
  });
}

function buildEditSchema() {
  return Type.Object({
    path: Type.Optional(Type.String({ description: "Path to the file" })),
    file_path: Type.Optional(Type.String({ description: "Path to the file" })),
    oldText: Type.Optional(Type.String({ description: "Text to replace" })),
    old_string: Type.Optional(Type.String({ description: "Text to replace" })),
    newText: Type.Optional(Type.String({ description: "Replacement text" })),
    new_string: Type.Optional(Type.String({ description: "Replacement text" })),
  });
}

export function createOpenClawTools(
  cwd: string,
  options?: { bashOperations?: BashOperations }
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
      env: stripEnv(params.env, SENSITIVE_WORKER_ENV_KEYS),
    }),
  };
  const bash = wrapBashWithProxyHint(createBashTool(cwd, bashToolOpts));

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
 * Wrap bash tool to detect proxy CONNECT 403 errors and append a hint.
 * curl doesn't display the proxy response body for CONNECT failures,
 * so the model never sees "Domain not allowed" — only exit code 56.
 */
function wrapBashWithProxyHint(tool: AgentTool<any>): AgentTool<any> {
  const PROXY_403_PATTERN = /Received HTTP code 403 from proxy after CONNECT/i;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const command =
        params && typeof params === "object" && "command" in params
          ? String((params as { command?: unknown }).command ?? "")
          : "";
      if (isDirectGatewayApiAccessCommand(command)) {
        throw new Error(
          "DIRECT GATEWAY API ACCESS BLOCKED. Use the registered MCP/auth tools instead of calling gateway /mcp or /internal endpoints from Bash."
        );
      }
      if (isDirectPackageInstallCommand(command)) {
        throw new Error(
          "DIRECT PACKAGE INSTALL BLOCKED. Install system packages with nixPackages in lobu.toml or agent settings instead of using package managers inside the worker."
        );
      }
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (PROXY_403_PATTERN.test(msg)) {
          throw new Error(
            `DOMAIN BLOCKED BY PROXY. The domain is blocked at the network level. Network access is configured via lobu.toml or the gateway configuration APIs — do NOT retry the request.\n\n${msg}`
          );
        }
        throw err;
      }
    },
  };
}
