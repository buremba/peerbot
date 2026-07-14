import type { McpToolDef } from "@lobu/core";
import { createConversationPlugin } from "@lobu/plugin-conversations";
import { PluginHost } from "@lobu/plugin-host";
import { createMcpPlugin, callMcpTool } from "@lobu/plugin-mcp";
import { createMediaPlugin } from "@lobu/plugin-media";
import { createMemoryPlugin } from "@lobu/plugin-memory";
import type { PluginLogger, PluginRuntimeContext } from "@lobu/plugin-api";
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { value };
}

export function wrapToolsWithPluginHooks(
  tools: ToolDefinition[],
  host: PluginHost<ToolDefinition>,
  context: PluginRuntimeContext
): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, executionContext) => {
      const before = await host.beforeToolCall(
        { toolName: tool.name, toolCallId, params: asRecord(params) },
        context
      );
      if (before.blockReason) throw new Error(before.blockReason);
      try {
        const result = await tool.execute(
          toolCallId,
          before.params as typeof params,
          signal,
          onUpdate,
          executionContext
        );
        await host.afterToolCall(
          {
            toolName: tool.name,
            toolCallId,
            params: before.params,
            result,
            isError: false,
          },
          context
        );
        return result;
      } catch (error) {
        await host.afterToolCall(
          {
            toolName: tool.name,
            toolCallId,
            params: before.params,
            result: error instanceof Error ? error.message : String(error),
            isError: true,
          },
          context
        );
        throw error;
      }
    },
  }));
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
