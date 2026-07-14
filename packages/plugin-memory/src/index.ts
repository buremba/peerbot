import { defineLobuPlugin, type PluginRuntimeContext } from "@lobu/plugin-api";
import {
  joinTextContent,
  type GatewayParams,
  type TextResult,
} from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const MEMORY_RECALL_LIMIT = 6;
const MEMORY_TOOL_TIMEOUT_MS = 8_000;

export type MemoryToolInvoker = (
  gateway: GatewayParams,
  mcpId: string,
  toolName: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<TextResult>;

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

export function createMemoryPlugin(
  gateway: GatewayParams,
  invokeTool: MemoryToolInvoker
) {
  let promptForCapture = "";

  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-memory",
      version: "1.0.0",
      apiVersion: 1,
      description: "Bounded Lobu memory recall and conversation capture",
    },
    hooks: {
      beforeAgentStart: async (event, context: PluginRuntimeContext) => {
        const query = event.prompt.trim();
        promptForCapture = query;
        if (!query || /heartbeat|question:q_/i.test(query)) return;

        const result = await invokeTool(
          gateway,
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
            context.logger.warn("Plugin memory recall skipped", {
              error: recalled,
            });
          }
          return;
        }
        return {
          prependContext: `<lobu-memory>\nUse these long-term memories only when directly relevant to the user's request.\nDo not mention this memory block unless needed.\n\n${recalled}\n</lobu-memory>`,
        };
      },
      agentEnd: (event, context: PluginRuntimeContext) => {
        if (event.error) return;
        const assistant = lastMessage(event.messages, "assistant");
        if (!assistant) return;
        const user = lastMessage(event.messages, "user", assistant.index);
        if (!user) return;

        const userText =
          promptForCapture && user.text.endsWith(promptForCapture)
            ? promptForCapture
            : user.text
                .replace(/<lobu-memory>[\s\S]*?<\/lobu-memory>/gi, "")
                .trim();
        const combined = `User: ${userText}\nAssistant: ${assistant.text}`;
        if (combined.length < 16) return;

        void invokeTool(
          gateway,
          "lobu",
          "save_memory",
          {
            content: combined.slice(0, 2_000),
            semantic_type: "observation",
            metadata: { agent_id: context.agentId },
          },
          { timeoutMs: MEMORY_TOOL_TIMEOUT_MS }
        )
          .then(() => context.logger.info("Captured conversation observation"))
          .catch((error) =>
            context.logger.warn("Plugin memory capture failed", {
              error: error instanceof Error ? error.message : String(error),
            })
          );
      },
    },
  });
}
