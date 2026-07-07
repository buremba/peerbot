import { describe, expect, test } from "bun:test";
import {
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers.js";

describe("resolveAgentOptions model resolution (layered fallback)", () => {
  test("behavior override (baseOptions.model) wins over the agent default", async () => {
    const settingsStore = {
      getSettings: async () => ({ defaultModel: "openai/gpt-5" }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "claude/claude-opus-4-8" },
			settingsStore as any,
      "org-1",
    );

    // The per-behavior override is highest priority.
    expect(resolved.model).toBe("claude/claude-opus-4-8");
  });

  test("uses the agent defaultModel when no behavior override", async () => {
    const settingsStore = {
      getSettings: async () => ({ defaultModel: "openai/gpt-5" }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
			settingsStore as any,
      "org-1",
    );

    expect(resolved.model).toBe("openai/gpt-5");
  });

  test("reads the agent row scoped to the caller's org (shared agent id across orgs)", async () => {
    // A shared agent id (e.g. "lobu-builder") exists in multiple orgs, each with
    // its own defaultModel. The worker-dispatch path has no ambient orgContext,
    // so getSettings MUST receive the org explicitly — otherwise it reads an
    // arbitrary org's row and mis-resolves the model (the Gemini/Claude 404 bug).
    const rowsByOrg: Record<string, { defaultModel: string }> = {
      "org-a": { defaultModel: "claude/claude-sonnet-4-6" },
      "org-b": { defaultModel: "gemini/gemini-2.5-flash" },
    };
    const seenAgentIds: string[] = [];
    const settingsStore = {
      getSettings: async (
        agentId: string,
        context?: { organizationId?: string },
      ) => {
        seenAgentIds.push(agentId);
        // Mirror the store contract: an unscoped read is ambiguous. Simulate the
        // real bug by returning the WRONG org's row when no org is passed.
        const org = context?.organizationId ?? "org-a";
        return rowsByOrg[org] as any;
      },
    };

    const resolved = await resolveAgentOptions(
      "lobu-builder",
      {},
      settingsStore as any,
      "org-b",
    );

    // The store was queried for the right agent, and org-b's model resolved —
    // not the default/first org's Claude model.
    expect(seenAgentIds).toEqual(["lobu-builder"]);
    expect(resolved.model).toBe("gemini/gemini-2.5-flash");
  });

  test("clears model when neither behavior nor agent nor org sets one (worker throws)", async () => {
    const settingsStore = {
      getSettings: async () => ({}) as any,
    };

    // organizationId undefined ⇒ no org lookup ⇒ nothing resolved.
    const resolved = await resolveAgentOptions(
      "agent-1",
      { model: "" },
			settingsStore as any,
      undefined,
    );

    expect(resolved.model).toBeUndefined();
  });

  test("normalizes legacy Lobu gateway URLs to the embedded gateway", async () => {
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
			settingsStore as any,
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

  test("normalizes custom Lobu endpoints to the embedded gateway", async () => {
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
                  mcpUrl: "https://lobu.example.com/mcp",
                  gatewayAuthUrl: "https://lobu.example.com",
                },
              },
            ],
          },
        }) as any,
    };

    const resolved = await resolveAgentOptions(
      "agent-1",
      {},
			settingsStore as any,
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

  test("injects Lobu mcpUrl/gatewayAuthUrl when override omits config", async () => {
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
			settingsStore as any,
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
			getBindingForConnection: async (
				connectionId: string,
        channelId: string,
				organizationId: string,
      ) => {
				expect(connectionId).toBe("conn-1");
        expect(channelId).toBe("C1");
				expect(organizationId).toBe("org-1");
				return { agentId: "bound-agent", platform: "slack", channelId };
      },
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      teamId: "T1",
      agentId: "connection-agent",
			connectionId: "conn-1",
			organizationId: "org-1",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "binding",
    });
  });

  test("per-binding model override propagates from the binding (Listen behavior)", async () => {
    const bindingService = {
      getBindingForConnection: async (
        _connectionId: string,
        channelId: string,
      ) => ({
        agentId: "bound-agent",
        platform: "slack",
        channelId,
        organizationId: "org-1",
        model: "openai/gpt-5",
      }),
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      channelId: "C1",
      agentId: "connection-agent",
      connectionId: "conn-1",
      organizationId: "org-1",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "binding",
      organizationId: "org-1",
      model: "openai/gpt-5",
    });
  });

  test("no binding + agentId routes to connection agent", async () => {
    const bindingService = {
			getBindingForConnection: async () => null,
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
			getBindingForConnection: async () => null,
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
			getBindingForConnection: async () => null,
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
			getBindingForConnection: async () => null,
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
