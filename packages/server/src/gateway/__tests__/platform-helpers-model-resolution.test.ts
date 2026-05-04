import { describe, expect, test } from "bun:test";
import {
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";

describe("resolveAgentOptions model resolution", () => {
  test("uses pinned model when pinned provider is installed", async () => {
    const settingsStore = {
      getSettings: async () =>
        ({
          modelSelection: {
            mode: "pinned",
            pinnedModel: "openai/gpt-5",
          },
          installedProviders: [{ providerId: "openai", installedAt: 1 }],
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "fallback-model" },
      settingsStore as any
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("uses primary provider preference in auto mode", async () => {
    const settingsStore = {
      getSettings: async () =>
        ({
          modelSelection: {
            mode: "auto",
          },
          installedProviders: [
            { providerId: "chatgpt", installedAt: 1 },
            { providerId: "claude", installedAt: 2 },
          ],
          providerModelPreferences: {
            chatgpt: "chatgpt/gpt-5",
            claude: "claude/sonnet",
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "fallback-model" },
      settingsStore as any
    );

    expect(resolved.model).toBe("chatgpt/gpt-5");
  });

  test("clears model in auto mode when providers exist but no preference", async () => {
    const settingsStore = {
      getSettings: async () =>
        ({
          modelSelection: {
            mode: "auto",
          },
          installedProviders: [{ providerId: "chatgpt", installedAt: 1 }],
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "fallback-model" },
      settingsStore as any
    );

    expect(resolved.model).toBeUndefined();
  });

  test("normalizes legacy Owletto gateway URLs to the embedded gateway", async () => {
    process.env.PORT = "8787";

    const settingsStore = {
      getSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/openclaw-plugin",
                slot: "memory",
                enabled: true,
                config: {
                  mcpUrl: "http://gateway:8080/mcp/lobu-memory",
                  gatewayAuthUrl: "http://gateway:8080",
                },
              },
            ],
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      settingsStore as any
    );

    expect(resolved.pluginsConfig).toEqual({
      plugins: [
        {
          source: "@lobu/openclaw-plugin",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl: "http://127.0.0.1:8787/lobu/mcp/lobu-memory",
            gatewayAuthUrl: "http://127.0.0.1:8787/lobu",
          },
        },
      ],
    });
  });

  test("normalizes custom Owletto endpoints to the embedded gateway", async () => {
    process.env.PORT = "8787";

    const settingsStore = {
      getSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/openclaw-plugin",
                slot: "memory",
                enabled: true,
                config: {
                  mcpUrl: "https://owletto.example.com/mcp",
                  gatewayAuthUrl: "https://owletto.example.com",
                },
              },
            ],
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      settingsStore as any
    );

    expect(resolved.pluginsConfig).toEqual({
      plugins: [
        {
          source: "@lobu/openclaw-plugin",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl: "http://127.0.0.1:8787/lobu/mcp/lobu-memory",
            gatewayAuthUrl: "http://127.0.0.1:8787/lobu",
          },
        },
      ],
    });
  });

  test("injects Owletto mcpUrl/gatewayAuthUrl when override omits config", async () => {
    process.env.PORT = "8787";

    const settingsStore = {
      getSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/openclaw-plugin",
                slot: "memory",
                enabled: true,
              },
            ],
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      settingsStore as any
    );

    expect(resolved.pluginsConfig).toEqual({
      plugins: [
        {
          source: "@lobu/openclaw-plugin",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl: "http://127.0.0.1:8787/lobu/mcp/lobu-memory",
            gatewayAuthUrl: "http://127.0.0.1:8787/lobu",
          },
        },
      ],
    });
  });

  test("normalizes lobu-memory MCP servers to the local embedded upstream", async () => {
    process.env.PORT = "8787";

    const settingsStore = {
      getSettings: async () =>
        ({
          mcpServers: {
            "lobu-memory": {
              url: "https://app.example.test/mcp/buremba",
              type: "streamable-http",
            },
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
      settingsStore as any
    );

    expect(resolved.mcpServers).toEqual({
      "lobu-memory": {
        url: "http://127.0.0.1:8787/mcp/buremba",
        type: "streamable-http",
      },
    });
  });
});

describe("resolveAgentId", () => {
  test("returns null when no binding and connection has no agent", async () => {
    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
    });

    expect(resolved).toBeNull();
  });

  test("existing binding wins over connection agent", async () => {
    const bindingService = {
      getBinding: async (
        platform: string,
        channelId: string,
        teamId?: string
      ) => {
        expect(platform).toBe("slack");
        expect(channelId).toBe("C1");
        expect(teamId).toBe("T1");
        return { agentId: "bound-agent", platform, channelId, teamId };
      },
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "binding",
    });
  });

  test("no binding + agentId routes to connection agent", async () => {
    const bindingService = {
      getBinding: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "connection-agent",
      source: "connection",
    });
  });

  test("no binding + no connection agent returns null", async () => {
    const bindingService = {
      getBinding: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toBeNull();
  });

  test("connection agent works on platforms without teamId (Telegram)", async () => {
    const bindingService = {
      getBinding: async (_p: string, _c: string, teamId?: string) => {
        expect(teamId).toBeUndefined();
        return null;
      },
    };

    const resolved = await resolveAgentId({
      platform: "telegram",
      channelId: "12345",
      agentId: "my-tg-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "my-tg-agent",
      source: "connection",
    });
  });

  test("resolver does NOT write bindings — pure side-effect-free", async () => {
    let createCount = 0;
    const bindingService = {
      getBinding: async () => null,
      createBinding: async () => {
        createCount += 1;
      },
    };

    await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
      channelBindingService: bindingService as any,
    });

    // Bridge owns the auto-bind side effect, not the resolver.
    expect(createCount).toBe(0);
  });
});
