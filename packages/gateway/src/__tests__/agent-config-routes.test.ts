import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { encrypt } from "@lobu/core";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import { GrantStore } from "../permissions/grant-store";
import { createAgentConfigRoutes } from "../routes/public/agent-config";
import { setAuthProvider } from "../routes/public/settings-auth";

describe("agent config routes", () => {
  let originalEncryptionKey: string | undefined;
  let redis: MockRedisClient;
  let agentSettingsStore: AgentSettingsStore;
  let agentMetadataStore: AgentMetadataStore;
  let grantStore: GrantStore;

  beforeEach(async () => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    redis = new MockRedisClient();
    agentSettingsStore = new AgentSettingsStore(redis as any);
    agentMetadataStore = new AgentMetadataStore(redis as any);
    grantStore = new GrantStore(redis as any);

    await agentMetadataStore.createAgent(
      "template-agent",
      "Template Agent",
      "telegram",
      "u1"
    );
    await agentMetadataStore.createAgent(
      "telegram-1",
      "Telegram Sandbox",
      "telegram",
      "u1",
      { parentConnectionId: "conn-1" }
    );
    await redis.set(
      "connection:conn-1",
      JSON.stringify({ templateAgentId: "template-agent" })
    );

    await agentSettingsStore.saveSettings("template-agent", {
      identityMd: "Template identity",
      soulMd: "Template soul",
      userMd: "Template user",
      installedProviders: [{ providerId: "chatgpt", installedAt: 1 }],
      verboseLogging: true,
    });
    await agentSettingsStore.saveSettings("telegram-1", {
      identityMd: "Local identity",
    });
    await grantStore.grant("telegram-1", "api.openai.com", null);
  });

  afterEach(() => {
    if (originalEncryptionKey !== undefined) {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
    setAuthProvider(null);
  });

  function buildApp() {
    const app = new OpenAPIHono();
    const scheduledWakeupService = {
      async listPendingForAgent(agentId: string) {
        if (agentId !== "telegram-1") return [];
        return [
          {
            id: "schedule-1",
            task: "Check provider state",
            triggerAt: "2026-03-30T18:00:00.000Z",
            status: "pending",
            isRecurring: false,
            iteration: 1,
            maxIterations: 1,
          },
        ];
      },
      async cancelByAgent() {
        return true;
      },
    };

    app.route(
      "/api/v1/agents/:agentId/config",
      createAgentConfigRoutes({
        agentSettingsStore,
        agentConfigStore: {
          getSettings: (agentId: string) =>
            agentSettingsStore.getSettings(agentId),
          getMetadata: (agentId: string) =>
            agentMetadataStore.getMetadata(agentId),
        },
        grantStore,
        scheduledWakeupService: scheduledWakeupService as any,
      })
    );

    return app;
  }

  test("GET /config returns effective sandbox settings with provenance", async () => {
    setAuthProvider(() => ({
      agentId: "telegram-1",
      userId: "u1",
      platform: "telegram",
      exp: Date.now() + 60_000,
      settingsMode: "user",
      allowedScopes: [
        "view-model",
        "system-prompt",
        "permissions",
        "schedules",
      ],
    }));

    const app = buildApp();
    const response = await app.request("/api/v1/agents/telegram-1/config");
    expect(response.status).toBe(200);

    const data = (await response.json()) as any;
    expect(data.scope).toBe("sandbox");
    expect(data.templateAgentId).toBe("template-agent");
    expect(data.templateAgentName).toBe("Template Agent");
    expect(data.instructions.identity).toBe("Local identity");
    expect(data.instructions.soul).toBe("Template soul");
    expect(data.providers.order).toEqual(["chatgpt"]);
    expect(data.sections.model.source).toBe("inherited");
    expect(data.sections.model.editable).toBe(false);
    expect(data.sections["system-prompt"].source).toBe("mixed");
    expect(data.providerViews.chatgpt.source).toBe("inherited");
    expect(data.providerViews.chatgpt.canEdit).toBe(false);
    expect(data.tools.permissions).toHaveLength(1);
    expect(data.tools.schedules).toHaveLength(1);
    expect(data.tools.schedules[0]?.scheduleId).toBe("schedule-1");
  });

  test("GET /config accepts direct query token auth", async () => {
    const app = buildApp();
    const token = encrypt(
      JSON.stringify({
        agentId: "telegram-1",
        userId: "u1",
        platform: "telegram",
        exp: Date.now() + 60_000,
        settingsMode: "user",
        allowedScopes: ["view-model", "system-prompt", "permissions"],
      })
    );

    const response = await app.request(
      `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.agentId).toBe("telegram-1");
    expect(data.scope).toBe("sandbox");
  });

  test("GET /config keeps exact agent tokens read-only when settingsMode is missing", async () => {
    const app = buildApp();
    const token = encrypt(
      JSON.stringify({
        agentId: "telegram-1",
        userId: "u1",
        platform: "telegram",
        exp: Date.now() + 60_000,
      })
    );

    const response = await app.request(
      `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.sections.model.editable).toBe(false);
    expect(data.sections["system-prompt"].editable).toBe(false);
  });

  test("GET /config rejects direct query token for the wrong agent", async () => {
    const app = buildApp();
    const token = encrypt(
      JSON.stringify({
        agentId: "template-agent",
        userId: "u1",
        platform: "telegram",
        exp: Date.now() + 60_000,
        settingsMode: "user",
      })
    );

    const response = await app.request(
      `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
    );

    expect(response.status).toBe(401);
  });

  test("GET /config reads effective settings from the settings store", async () => {
    setAuthProvider(() => ({
      agentId: "telegram-1",
      userId: "u1",
      platform: "telegram",
      exp: Date.now() + 60_000,
      settingsMode: "user",
      allowedScopes: ["view-model", "system-prompt"],
    }));

    const app = new OpenAPIHono();
    app.route(
      "/api/v1/agents/:agentId/config",
      createAgentConfigRoutes({
        agentSettingsStore,
        agentConfigStore: {
          getSettings: async () => null,
          getMetadata: (agentId: string) =>
            agentMetadataStore.getMetadata(agentId),
        },
      })
    );

    const response = await app.request("/api/v1/agents/telegram-1/config");

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.instructions.identity).toBe("Local identity");
    expect(data.instructions.soul).toBe("Template soul");
    expect(data.providers.order).toEqual(["chatgpt"]);
    expect(data.templateAgentId).toBe("template-agent");
  });

  test("GET /config grants owners full access even when browser session has no settingsMode", async () => {
    setAuthProvider(() => ({
      userId: "u1",
      platform: "telegram",
      exp: Date.now() + 60_000,
    }));

    const app = buildApp();
    const response = await app.request("/api/v1/agents/telegram-1/config");

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.sections.model.editable).toBe(true);
    expect(data.sections["system-prompt"].editable).toBe(true);
  });
});
