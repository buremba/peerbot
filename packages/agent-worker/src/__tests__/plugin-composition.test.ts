import { describe, expect, mock, test } from "bun:test";
import {
  defineLobuPlugin,
  type PluginLogger,
  type PluginRuntimeContext,
} from "@lobu/plugin-api";
import { PluginHost } from "@lobu/plugin-host";
import { createMemoryPlugin } from "@lobu/plugin-memory";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  createRuntimePluginHost,
  wrapToolsWithPluginHooks,
} from "../runtime/plugin-composition";

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

function tool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "test_tool",
    label: "test_tool",
    description: "Plugin adapter fixture",
    parameters: Type.Object({ value: Type.String() }),
    execute,
  };
}

describe("plugin composition tool adapter", () => {
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
      "search_issues",
    ]);
  });

  test("fails closed before invoking a tool", async () => {
    const execute = mock(async () => ({
      content: [{ type: "text" as const, text: "should not run" }],
      details: {},
    }));
    const host = new PluginHost<ToolDefinition>([
      defineLobuPlugin<ToolDefinition>({
        manifest: {
          name: "policy",
          version: "1.0.0",
          apiVersion: 1,
          description: "Block fixture",
        },
        hooks: {
          beforeToolCall: () => ({
            block: true,
            blockReason: "denied by native policy",
          }),
        },
      }),
    ]);
    const [wrapped] = wrapToolsWithPluginHooks([tool(execute)], host, context);

    await expect(
      wrapped.execute("call", { value: "x" }, undefined, undefined)
    ).rejects.toThrow("denied by native policy");
    expect(execute).not.toHaveBeenCalled();
  });

  test("passes transformed parameters and observes the result", async () => {
    const execute = mock(async (_id: string, params: { value: string }) => ({
      content: [{ type: "text" as const, text: params.value }],
      details: {},
    }));
    const afterToolCall = mock(() => undefined);
    const host = new PluginHost<ToolDefinition>([
      defineLobuPlugin<ToolDefinition>({
        manifest: {
          name: "observer",
          version: "1.0.0",
          apiVersion: 1,
          description: "Transform and observe fixture",
        },
        hooks: {
          beforeToolCall: () => ({ params: { value: "rewritten" } }),
          afterToolCall,
        },
      }),
    ]);
    const [wrapped] = wrapToolsWithPluginHooks(
      [tool(execute as ToolDefinition["execute"])],
      host,
      context
    );

    const result = await wrapped.execute(
      "call",
      { value: "original" },
      undefined,
      undefined
    );

    expect(execute).toHaveBeenCalledWith(
      "call",
      { value: "rewritten" },
      undefined,
      undefined,
      undefined
    );
    expect(result.content).toEqual([{ type: "text", text: "rewritten" }]);
    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "test_tool",
        params: { value: "rewritten" },
        isError: false,
      }),
      context
    );
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
