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
  onInBandReplyDelivered?: () => void;
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
}

export function createRuntimePluginHost(params: RuntimePluginParams) {
  const plugins = [
    createMemoryPlugin(params, callMcpTool),
    createMediaPlugin({
      ...params,
      onFileUploaded: (data) => params.onCustomEvent("file-uploaded", data),
    }),
    createConversationPlugin(params),
  ];
  if (params.includeMcpTools) {
    plugins.push(
      createMcpPlugin({
        ...params,
        onAuthChanged: params.onMcpAuthChanged,
      })
    );
  }
  return new PluginHost<ToolDefinition>(plugins);
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
