import {
  defineLobuPlugin,
  type PluginLogger,
  type PluginRuntimeContext,
} from "@lobu/plugin-api";
import { PluginHost } from "@lobu/plugin-host";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  callMcpTool,
  type GatewayParams,
  joinTextContent,
  type TextResult,
} from "../shared/tool-implementations";
import { createLobuCustomTools } from "./custom-tools";

export const RUNTIME_TOOL_CAPABILITY = "runtime.gateway-tools";
export const RUNTIME_MEMORY_CAPABILITY = "runtime.memory";

const MEMORY_RECALL_LIMIT = 6;
const MEMORY_TOOL_TIMEOUT_MS = 8_000;

type MemoryToolInvoker = (
  gw: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<TextResult>;

interface RuntimeToolsPluginParams extends GatewayParams {
  workspaceDir: string;
  onCustomEvent: (name: string, data: Record<string, unknown>) => Promise<void>;
  onAskUserPosted: () => void;
}

export function createRuntimeToolsPlugin(params: RuntimeToolsPluginParams) {
  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-runtime-tools",
      version: "1.0.0",
      apiVersion: 1,
      description: "Lobu-owned gateway and interaction tools for agent runs",
      capabilities: [RUNTIME_TOOL_CAPABILITY],
    },
    tools: () => createLobuCustomTools(params),
  });
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

function lastMessage(
  messages: readonly unknown[],
  role: "user" | "assistant",
  before = messages.length
): { index: number; text: string } | null {
  for (let index = Math.min(before, messages.length) - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== role
    ) {
      continue;
    }
    const text = messageText(message).trim();
    if (text) return { index, text };
  }
  return null;
}

/**
 * Lobu's default memory behavior as a native plugin. This replaces the old
 * compatibility package with the same bounded recall/capture contract while
 * using the worker's per-run gateway token and native hook lifecycle.
 */
export function createNativeMemoryPlugin(
  params: GatewayParams,
  invokeTool: MemoryToolInvoker = callMcpTool
) {
  let promptForCapture = "";

  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-memory",
      version: "1.0.0",
      apiVersion: 1,
      description: "Bounded Lobu memory recall and conversation capture",
      capabilities: [RUNTIME_MEMORY_CAPABILITY],
    },
    hooks: {
      beforeAgentStart: async (event, context) => {
        const query = event.prompt.trim();
        promptForCapture = query;
        if (!query || /heartbeat|question:q_/i.test(query)) return;

        const result = await invokeTool(
          params,
          "lobu",
          "search_memory",
          {
            query,
            include_content: true,
            content_limit: MEMORY_RECALL_LIMIT,
            include_connections: false,
            limit: 3,
          },
          { timeoutMs: MEMORY_TOOL_TIMEOUT_MS }
        );
        const recalled = joinTextContent(result.content).trim();
        if (!recalled || /^error:/i.test(recalled)) {
          if (recalled) {
            context.logger.warn("Native memory recall skipped", {
              error: recalled,
            });
          }
          return;
        }
        return {
          prependContext: `<lobu-memory>\nUse these long-term memories only when directly relevant to the user's request.\nDo not mention this memory block unless needed.\n\n${recalled}\n</lobu-memory>`,
        };
      },
      agentEnd: (event, context) => {
        if (event.error) return;
        const assistant = lastMessage(event.messages, "assistant");
        if (!assistant) return;
        const user = lastMessage(event.messages, "user", assistant.index);
        if (!user) return;

        // The main prompt stored by Pi includes Lobu's recalled/context
        // preamble and ends with the raw user prompt we saw in
        // beforeAgentStart. Prefer that raw prompt for a normal turn. A live
        // steering message is a later user message and does not end with the
        // original prompt, so it remains the captured question paired with
        // the final assistant answer.
        const userText =
          promptForCapture && user.text.endsWith(promptForCapture)
            ? promptForCapture
            : user.text
                .replace(/<lobu-memory>[\s\S]*?<\/lobu-memory>/gi, "")
                .trim();

        const combined = `User: ${userText}\nAssistant: ${assistant.text}`;
        if (combined.length < 16) return;
        const content = combined.slice(0, 2_000);

        // Capture must not delay terminal delivery. The request is still
        // bounded, and every rejection is observed and logged.
        void invokeTool(
          params,
          "lobu",
          "save_memory",
          {
            content,
            semantic_type: "observation",
            metadata: { agent_id: context.agentId },
          },
          { timeoutMs: MEMORY_TOOL_TIMEOUT_MS }
        )
          .then(() => context.logger.info("Captured conversation observation"))
          .catch((error) =>
            context.logger.warn("Native memory capture failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          );
      },
    },
  });
}

export function createRuntimePluginHost(params: RuntimeToolsPluginParams) {
  return new PluginHost<ToolDefinition>(
    [createNativeMemoryPlugin(params), createRuntimeToolsPlugin(params)],
    new Set([RUNTIME_MEMORY_CAPABILITY, RUNTIME_TOOL_CAPABILITY])
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : { value };
}

export function wrapToolsWithNativePluginHooks(
  tools: ToolDefinition[],
  host: PluginHost<ToolDefinition>,
  context: PluginRuntimeContext
): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, executionContext) => {
      const input = asRecord(params);
      const before = await host.beforeToolCall(
        { toolName: tool.name, toolCallId, params: input },
        context
      );
      if (before.blockReason) {
        throw new Error(before.blockReason);
      }

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
