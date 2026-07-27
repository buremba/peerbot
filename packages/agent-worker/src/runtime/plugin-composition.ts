import type { McpToolDef } from "@lobu/core";
import type { PluginLogger } from "@lobu/plugin-api";
import { createConversationPlugin } from "@lobu/plugin-conversations";
import { PluginHost } from "@lobu/plugin-host";
import { callMcpTool, createMcpPlugin } from "@lobu/plugin-mcp";
import { createMediaPlugin } from "@lobu/plugin-media";
import { createMemoryPlugin } from "@lobu/plugin-memory";
import type { GatewayParams } from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

interface RuntimePluginParams extends GatewayParams {
  workspaceDir: string;
  onCustomEvent: (name: string, data: Record<string, unknown>) => Promise<void>;
  onAskUserPosted: () => void;
  includeMcpTools: boolean;
  mcpTools: Record<string, McpToolDef[]>;
  mcpStatus: Array<{
    id: string;
    name: string;
    requiresAuth: boolean;
    requiresInput?: boolean;
    authenticated?: boolean;
    configured?: boolean;
  }>;
  mcpContext?: Record<string, string>;
  onMcpAuthChanged: () => void;
  /**
   * Dispatch source (`platformMetadata.source`). `"starters"` marks the hidden
   * chip-generation turn — see {@link UNATTENDED_SOURCES}.
   */
  source?: string | undefined;
}

/**
 * Sources that run with NO user watching and NO user consent for side effects.
 *
 * A turn from one of these gets a restricted plugin host: read-only MCP tools
 * only, no conversation mutation, no memory capture. `toolsConfig.allowedTools`
 * cannot express this — it gates only the built-in tools (read/bash/edit/…) and
 * never touches plugin or MCP tools, so an unattended turn composed the normal
 * way is handed `send_message`, `edit_message`, `delete_message` and every
 * mutating MCP tool. The starters turn fires automatically whenever a user
 * opens a fresh chat; before this gate it could have posted to a real Slack.
 */
const UNATTENDED_SOURCES = new Set(["starters"]);

/**
 * True when a dispatch `source` runs unattended (no user watching, no consent
 * for side effects). Shared with the session runner so the runtime capability
 * boundary is derived from one list: `createRuntimePluginHost` uses it to
 * restrict plugin/MCP tools, and the session runner uses it to drop built-in
 * tools and force read-only MCP exposure. Keeping both call sites on the same
 * predicate means a new unattended source is gated everywhere at once.
 */
export function isUnattendedSource(source?: string): boolean {
  return UNATTENDED_SOURCES.has(source ?? "");
}

/**
 * Conversation-plugin tools an unattended turn may use. Allowlist, not
 * denylist: a new mutating tool must be excluded by default.
 */
const UNATTENDED_CONVERSATION_TOOLS = new Set(["suggest_actions"]);

export function createRuntimePluginHost(params: RuntimePluginParams) {
  const unattended = isUnattendedSource(params.source);
  const plugins = [
    // The memory plugin's `agentEnd` hook calls `save_memory` with the last
    // user+assistant text — for an unattended turn that is the hidden internal
    // prompt, which would pollute durable org memory. The worker's transcript
    // skip does NOT prevent this: the hook fires independently of the snapshot.
    ...(unattended ? [] : [createMemoryPlugin(params, callMcpTool)]),
    ...(unattended
      ? []
      : [
          createMediaPlugin({
            ...params,
            onFileUploaded: (data) =>
              params.onCustomEvent("file-uploaded", data),
          }),
        ]),
    unattended
      ? restrictToolsTo(
          createConversationPlugin(params),
          UNATTENDED_CONVERSATION_TOOLS
        )
      : createConversationPlugin(params),
  ];
  if (params.includeMcpTools) {
    plugins.push(
      createMcpPlugin({
        ...params,
        onAuthChanged: params.onMcpAuthChanged,
        // Read-only MCP tools only — the org-data tools this turn needs to
        // inspect the workspace, and nothing that writes.
        ...(unattended ? { readOnlyOnly: true } : {}),
      })
    );
  }
  return new PluginHost<ToolDefinition>(plugins);
}

/**
 * Wrap a plugin so it contributes only the named tools. Applied at composition
 * time so the restriction is structural — the excluded tools are never built,
 * never described to the model, and cannot be called.
 */
function restrictToolsTo<T extends { tools?: (context: never) => unknown }>(
  plugin: T,
  allowed: ReadonlySet<string>
): T {
  const original = plugin.tools;
  if (!original) return plugin;
  return {
    ...plugin,
    tools: async (context: never) => {
      const all = (await original.call(plugin, context)) as Array<{
        name?: string;
      }>;
      return all.filter((tool) => allowed.has(tool.name ?? ""));
    },
  };
}

export function createPluginLogger(logger: {
  debug(value: unknown, message?: string): void;
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}): PluginLogger {
  return {
    debug: (message, data) => logger.debug(data ?? {}, message),
    info: (message, data) => logger.info(data ?? {}, message),
    warn: (message, data) => logger.warn(data ?? {}, message),
    error: (message, data) => logger.error(data ?? {}, message),
  };
}
