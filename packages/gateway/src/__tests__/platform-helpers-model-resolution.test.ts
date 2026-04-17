import { afterEach, describe, expect, test } from "bun:test";
import {
  hasConfiguredProvider,
  resolveAgentId,
  resolveAgentOptions,
} from "../services/platform-helpers";

const originalDispatcherServiceName = process.env.DISPATCHER_SERVICE_NAME;
const originalKubernetesNamespace = process.env.KUBERNETES_NAMESPACE;

afterEach(() => {
  if (originalDispatcherServiceName === undefined) {
    delete process.env.DISPATCHER_SERVICE_NAME;
  } else {
    process.env.DISPATCHER_SERVICE_NAME = originalDispatcherServiceName;
  }

  if (originalKubernetesNamespace === undefined) {
    delete process.env.KUBERNETES_NAMESPACE;
  } else {
    process.env.KUBERNETES_NAMESPACE = originalKubernetesNamespace;
  }
});

describe("resolveAgentOptions model resolution", () => {
  test("uses pinned model when pinned provider is installed", async () => {
    const settingsStore = {
      getEffectiveSettings: async () =>
        ({
          modelSelection: {
            mode: "pinned",
            pinnedModel: "openai/gpt-5",
          },
          installedProviders: [{ providerId: "openai", installedAt: 1 }],
        }) as any,
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
      getEffectiveSettings: async () =>
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
      getEffectiveSettings: async () =>
        ({
          modelSelection: {
            mode: "auto",
          },
          installedProviders: [{ providerId: "chatgpt", installedAt: 1 }],
        }) as any,
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

  test("normalizes legacy Owletto gateway URLs to the runtime K8s service", async () => {
    process.env.DISPATCHER_SERVICE_NAME = "lobu-gateway";
    process.env.KUBERNETES_NAMESPACE = "lobu";

    const settingsStore = {
      getEffectiveSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/owletto-openclaw",
                slot: "memory",
                enabled: true,
                config: {
                  mcpUrl: "http://gateway:8080/mcp/owletto",
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
          source: "@lobu/owletto-openclaw",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl:
              "http://lobu-gateway.lobu.svc.cluster.local:8080/mcp/owletto",
            gatewayAuthUrl: "http://lobu-gateway.lobu.svc.cluster.local:8080",
          },
        },
      ],
    });
  });

  test("preserves custom Owletto endpoints", async () => {
    process.env.DISPATCHER_SERVICE_NAME = "lobu-gateway";
    process.env.KUBERNETES_NAMESPACE = "lobu";

    const settingsStore = {
      getEffectiveSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/owletto-openclaw",
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
          source: "@lobu/owletto-openclaw",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl: "https://owletto.example.com/mcp",
            gatewayAuthUrl: "https://owletto.example.com",
          },
        },
      ],
    });
  });

  test("injects Owletto mcpUrl/gatewayAuthUrl when override omits config", async () => {
    process.env.DISPATCHER_SERVICE_NAME = "lobu-gateway";
    process.env.KUBERNETES_NAMESPACE = "lobu";

    const settingsStore = {
      getEffectiveSettings: async () =>
        ({
          pluginsConfig: {
            plugins: [
              {
                source: "@lobu/owletto-openclaw",
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
          source: "@lobu/owletto-openclaw",
          slot: "memory",
          enabled: true,
          config: {
            mcpUrl:
              "http://lobu-gateway.lobu.svc.cluster.local:8080/mcp/owletto",
            gatewayAuthUrl: "http://lobu-gateway.lobu.svc.cluster.local:8080",
          },
        },
      ],
    });
  });
});

describe("hasConfiguredProvider", () => {
  test("accepts declared agents with credentials regardless of system keys", async () => {
    const { DeclaredAgentRegistry } = await import(
      "../services/declared-agent-registry"
    );
    const settingsStore = {
      getEffectiveSettings: async () => null,
    };
    const declaredAgents = new DeclaredAgentRegistry();
    declaredAgents.replaceAll(
      new Map([
        [
          "telegram-6570514069",
          {
            settings: {
              installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
            },
            credentials: [{ provider: "z-ai", key: "secret" }],
          },
        ],
      ])
    );

    await expect(
      hasConfiguredProvider(
        "telegram-6570514069",
        settingsStore as any,
        declaredAgents
      )
    ).resolves.toBe(true);
  });
});

describe("resolveAgentId", () => {
  test("uses deterministic shadow id when no binding and no template", async () => {
    const resolved = await resolveAgentId({
      platform: "telegram",
      userId: "777",
      channelId: "12345",
      isGroup: false,
    });

    expect(resolved).toEqual({
      agentId: "telegram-777",
      source: "shadow",
    });
  });

  test("existing binding wins over template (tier 1)", async () => {
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
      userId: "U1",
      channelId: "C1",
      isGroup: true,
      teamId: "T1",
      templateAgentId: "template-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "bound-agent",
      source: "binding",
    });
  });

  test("no binding + templateAgentId routes to template (tier 2)", async () => {
    const bindingService = {
      getBinding: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      userId: "U1",
      channelId: "C1",
      isGroup: true,
      teamId: "T1",
      templateAgentId: "template-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "template-agent",
      source: "template",
    });
  });

  test("no binding + no template falls back to shadow (tier 3)", async () => {
    const bindingService = {
      getBinding: async () => null,
    };

    const resolved = await resolveAgentId({
      platform: "slack",
      userId: "U1",
      channelId: "C1",
      isGroup: true,
      teamId: "T1",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "slack-g-C1",
      source: "shadow",
    });
  });

  test("template tier works on platforms without teamId (Telegram)", async () => {
    const bindingService = {
      getBinding: async (_p: string, _c: string, teamId?: string) => {
        expect(teamId).toBeUndefined();
        return null;
      },
    };

    const resolved = await resolveAgentId({
      platform: "telegram",
      userId: "777",
      channelId: "12345",
      isGroup: false,
      templateAgentId: "my-tg-agent",
      channelBindingService: bindingService as any,
    });

    expect(resolved).toEqual({
      agentId: "my-tg-agent",
      source: "template",
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
      userId: "U1",
      channelId: "C1",
      isGroup: true,
      teamId: "T1",
      templateAgentId: "template-agent",
      channelBindingService: bindingService as any,
    });

    // Bridge owns the auto-bind side effect, not the resolver.
    expect(createCount).toBe(0);
  });
});
