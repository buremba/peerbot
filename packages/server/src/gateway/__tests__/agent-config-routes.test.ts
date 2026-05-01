import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { encrypt } from "@lobu/core";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { GrantStore } from "../permissions/grant-store.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-config";

describe("agent config routes", () => {
  let originalEncryptionKey: string | undefined;
  let agentSettingsStore: AgentSettingsStore;
  let agentMetadataStore: AgentMetadataStore;
  let grantStore: GrantStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    originalEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    await resetTestDatabase();

    agentSettingsStore = new AgentSettingsStore();
    agentMetadataStore = new AgentMetadataStore();
    // GrantStore still uses Redis-backed JSON helpers — out of scope for
    // Phase 6. Tests that exercise grants run the route layer; they don't
    // assert on grant persistence semantics here.
    grantStore = {
      grant: async () => {},
      hasGrant: async () => true,
      isDenied: async () => false,
      listGrants: async () => [
        {
          pattern: "api.openai.com",
          expiresAt: null,
          grantedAt: Date.now(),
        },
      ],
      revoke: async () => {},
    } as unknown as GrantStore;

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      await seedAgentRow("template-agent", {
        organizationId: ORG_ID,
        name: "Template Agent",
        ownerPlatform: "telegram",
        ownerUserId: "u1",
      });
      await seedAgentRow("telegram-1", {
        organizationId: ORG_ID,
        name: "Telegram Sandbox",
        ownerPlatform: "telegram",
        ownerUserId: "u1",
        parentConnectionId: "conn-1",
      });

      // Connection rows live in `agent_connections` keyed by id, with the
      // template agent in `agent_id` (FK → public.agents).
      const sql = getDb();
      await sql`
        INSERT INTO agent_connections (id, agent_id, platform, config, settings, metadata, status)
        VALUES ('conn-1', 'template-agent', 'telegram', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active')
        ON CONFLICT (id) DO NOTHING
      `;

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
    });
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
      })
    );

    return app;
  }

  function runWithOrg<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run({ organizationId: ORG_ID }, fn);
  }

  test("GET /config returns effective sandbox settings with provenance", async () => {
    setAuthProvider(() => ({
      agentId: "telegram-1",
      userId: "u1",
      platform: "telegram",
      exp: Date.now() + 60_000,
      settingsMode: "user",
      allowedScopes: ["view-model", "system-prompt", "permissions"],
    }));

    const app = buildApp();
    const response = await runWithOrg(() =>
      app.request("/api/v1/agents/telegram-1/config")
    );
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

    const response = await runWithOrg(() =>
      app.request(
        `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
      )
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

    const response = await runWithOrg(() =>
      app.request(
        `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
      )
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

    const response = await runWithOrg(() =>
      app.request(
        `/api/v1/agents/telegram-1/config?token=${encodeURIComponent(token)}`
      )
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

    const response = await runWithOrg(() =>
      app.request("/api/v1/agents/telegram-1/config")
    );

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
    const response = await runWithOrg(() =>
      app.request("/api/v1/agents/telegram-1/config")
    );

    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.sections.model.editable).toBe(true);
    expect(data.sections["system-prompt"].editable).toBe(true);
  });
});
