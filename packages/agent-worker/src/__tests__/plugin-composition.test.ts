import { describe, expect, mock, test } from "bun:test";
import type { PluginLogger, PluginRuntimeContext } from "@lobu/plugin-api";
import { PluginHost } from "@lobu/plugin-host";
import { createMemoryPlugin } from "@lobu/plugin-memory";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createRuntimePluginHost } from "../runtime/plugin-composition";

const logger: PluginLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const context: PluginRuntimeContext = {
  organizationId: "org",
  actorId: "actor",
  credentialSubject: "actor",
  destination: "channel",
  agentId: "agent",
  conversationId: "conversation",
  runId: 1,
  messageId: "message",
  workspaceDir: "/workspace",
  platform: "api",
  logger,
};

describe("runtime plugin composition", () => {
  test("composes concrete packages in the existing model-visible tool order", async () => {
    const host = createRuntimePluginHost({
      gatewayUrl: "http://gateway",
      workerToken: "token",
      channelId: "channel",
      conversationId: "conversation",
      workspaceDir: "/workspace",
      onCustomEvent: async () => undefined,
      onAskUserPosted: () => undefined,
      includeMcpTools: true,
      mcpTools: {
        github: [
          {
            name: "search_issues",
            description: "Search issues",
            inputSchema: { type: "object" },
          },
        ],
      },
      mcpStatus: [],
      onMcpAuthChanged: () => undefined,
    });

    expect((await host.tools(context)).map((entry) => entry.name)).toEqual([
      "upload_file",
      "generate_image",
      "generate_audio",
      "list_conversations",
      "read_conversation",
      "send_message",
      "react",
      "edit_message",
      "delete_message",
      "ask_user",
      "suggest_actions",
      "search_issues",
    ]);
  });
});

describe("memory plugin composition", () => {
  const gateway = {
    gatewayUrl: "http://gateway.test",
    workerToken: "worker-token",
    channelId: "channel",
    conversationId: "conversation",
    platform: "api",
    workspaceDir: "/workspace",
  };

  test("injects bounded recall before the agent starts", async () => {
    const invokeTool = mock(async () => ({
      content: [{ type: "text" as const, text: "Decision: ship native hooks" }],
    }));
    const host = new PluginHost<ToolDefinition>([
      createMemoryPlugin(gateway, invokeTool),
    ]);

    const prepend = await host.beforeAgentStart(
      { prompt: "what did we decide?", messages: [] },
      context
    );

    expect(prepend).toHaveLength(1);
    expect(prepend[0]).toContain("<lobu-memory>");
    expect(prepend[0]).toContain("Decision: ship native hooks");
    expect(invokeTool).toHaveBeenCalledWith(
      gateway,
      "lobu",
      "search_memory",
      {
        query: "what did we decide?",
        include_content: true,
        content_limit: 6,
        include_connections: false,
        limit: 3,
      },
      { timeoutMs: 8_000 }
    );
  });

  test("skips internal heartbeat recall", async () => {
    const invokeTool = mock(async () => ({ content: [] }));
    const host = new PluginHost<ToolDefinition>([
      createMemoryPlugin(gateway, invokeTool),
    ]);

    expect(
      await host.beforeAgentStart(
        { prompt: "heartbeat", messages: [] },
        context
      )
    ).toEqual([]);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  test("captures the final user and assistant exchange with agent scope", async () => {
    const invokeTool = mock(async () => ({ content: [] }));
    const host = new PluginHost<ToolDefinition>([
      createMemoryPlugin(gateway, invokeTool),
    ]);

    await host.agentEnd(
      {
        messages: [
          { role: "user", content: "Prefer the plugin host" },
          { role: "assistant", content: "I will keep the core boundary small" },
        ],
      },
      context
    );

    expect(invokeTool).toHaveBeenCalledWith(
      gateway,
      "lobu",
      "save_memory",
      {
        content:
          "User: Prefer the plugin host\nAssistant: I will keep the core boundary small",
        semantic_type: "observation",
        metadata: { agent_id: "agent" },
      },
      { timeoutMs: 8_000 }
    );
  });

  test("does not capture a failed turn", async () => {
    const invokeTool = mock(async () => ({ content: [] }));
    const host = new PluginHost<ToolDefinition>([
      createMemoryPlugin(gateway, invokeTool),
    ]);

    await host.agentEnd(
      {
        messages: [
          { role: "user", content: "Use the native host" },
          { role: "assistant", content: "Partial answer from a failed turn" },
        ],
        error: "provider disconnected",
      },
      context
    );

    expect(invokeTool).not.toHaveBeenCalled();
  });

  test("pairs a live steering message with the final assistant answer", async () => {
    const invokeTool = mock(async () => ({ content: [] }));
    const host = new PluginHost<ToolDefinition>([
      createMemoryPlugin(gateway, invokeTool),
    ]);

    await host.beforeAgentStart(
      { prompt: "Design the plugin API", messages: [] },
      context
    );
    invokeTool.mockClear();

    await host.agentEnd(
      {
        messages: [
          {
            role: "user",
            content:
              "<lobu-memory>old context</lobu-memory>\n\nDesign the plugin API",
          },
          {
            role: "assistant",
            content: "I will expose every runtime primitive",
          },
          { role: "user", content: "Keep the core surface minimal instead" },
          {
            role: "assistant",
            content: "I will expose only stable extension points",
          },
        ],
      },
      context
    );

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledWith(
      gateway,
      "lobu",
      "save_memory",
      {
        content:
          "User: Keep the core surface minimal instead\nAssistant: I will expose only stable extension points",
        semantic_type: "observation",
        metadata: { agent_id: "agent" },
      },
      { timeoutMs: 8_000 }
    );
  });
});
