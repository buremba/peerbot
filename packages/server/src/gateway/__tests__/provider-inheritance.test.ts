import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { getDb } from "../../db/client.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { PostgresSecretStore } from "../../lobu/stores/postgres-secret-store.js";
import {
  ProviderCatalogService,
  resolveInstalledProviders,
} from "../auth/provider-catalog.js";
import {
  AgentSettingsStore,
  EphemeralAuthProfileRegistry,
} from "../auth/settings/agent-settings-store.js";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import {
  canEditSettingsSection,
  canViewSettingsSection,
  resolveSettingsView,
} from "../auth/settings/resolved-settings-view.js";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store.js";
import { DeclaredAgentRegistry } from "../services/declared-agent-registry.js";
import {
  ensureEncryptionKey,
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ORG_ID = "test-org-prov-inheritance";

beforeAll(async () => {
  // ensurePgliteForGatewayTests already populates ENCRYPTION_KEY; we set our
  // own value first so encrypt()/decrypt() round-trip in this file even when
  // the suite is run in isolation. Keep the key set on teardown — other
  // bun:test files in the gateway directory rely on it being available.
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  }
  await ensurePgliteForGatewayTests();
});

// Intentionally no afterAll teardown of ENCRYPTION_KEY — the variable is
// shared across the bun:test gateway suite.
afterAll(() => {});

async function seedConnection(
  connectionId: string,
  templateAgentId: string
): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO agent_connections (id, agent_id, platform, config, settings, metadata, status)
    VALUES (${connectionId}, ${templateAgentId}, 'telegram', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active')
    ON CONFLICT (id) DO NOTHING
  `;
}

function withOrg<T>(fn: () => Promise<T>): Promise<T> {
  return orgContext.run({ organizationId: ORG_ID }, fn);
}

describe("sandbox provider inheritance", () => {
  let store: AgentSettingsStore;
  let secretStore: PostgresSecretStore;
  let userAuthProfiles: UserAuthProfileStore;
  let declaredAgents: DeclaredAgentRegistry;
  let authProfilesManager: AuthProfilesManager;

  beforeEach(async () => {
    ensureEncryptionKey();
    await resetTestDatabase();
    secretStore = new PostgresSecretStore();
    store = new AgentSettingsStore();
    userAuthProfiles = new UserAuthProfileStore(secretStore);
    declaredAgents = new DeclaredAgentRegistry();
    authProfilesManager = new AuthProfilesManager({
      ephemeralProfiles: new EphemeralAuthProfileRegistry(),
      declaredAgents,
      userAuthProfiles,
      secretStore,
    });
  });

  test("inherits installed providers through metadata and connection template fallback", async () => {
    await withOrg(async () => {
      await seedAgentRow("template-agent", { organizationId: ORG_ID });
      await seedAgentRow("telegram-6570514069", {
        organizationId: ORG_ID,
        parentConnectionId: "conn-1",
      });
      await seedConnection("conn-1", "template-agent");

      await store.saveSettings("template-agent", {
        installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
      });

      const providers = await resolveInstalledProviders(
        store,
        "telegram-6570514069"
      );
      expect(providers).toEqual([{ providerId: "z-ai", installedAt: 1 }]);
    });
  });

  test("declared credentials surface as synthesized profiles", async () => {
    declaredAgents.replaceAll(
      new Map([
        [
          "template-agent",
          {
            settings: {
              installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
            },
            credentials: [{ provider: "z-ai", key: "secret" }],
          },
        ],
      ])
    );

    const profiles = await authProfilesManager.listProfiles("template-agent");

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.provider).toBe("z-ai");
    expect(profiles[0]?.credential).toBe("secret");
    expect(profiles[0]?.id).toBe("declared:template-agent:z-ai");
  });

  test("user-scoped profile takes precedence over declared credential", async () => {
    declaredAgents.replaceAll(
      new Map([
        [
          "template-agent",
          {
            settings: {
              installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
            },
            credentials: [{ provider: "z-ai", key: "declared-secret" }],
          },
        ],
      ])
    );

    await authProfilesManager.upsertProfile({
      agentId: "template-agent",
      userId: "userA",
      provider: "z-ai",
      credential: "user-secret",
      authType: "api-key",
      label: "z.ai byok",
    });

    const userView = await authProfilesManager.listProfiles(
      "template-agent",
      "userA"
    );
    expect(userView).toHaveLength(1);
    expect(userView[0]?.credential).toBe("user-secret");

    const anonView = await authProfilesManager.listProfiles("template-agent");
    expect(anonView).toHaveLength(1);
    expect(anonView[0]?.credential).toBe("declared-secret");
  });

  test("expired user OAuth does not mask a valid declared fallback", async () => {
    declaredAgents.replaceAll(
      new Map([
        [
          "template-agent",
          {
            settings: {
              installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
            },
            credentials: [{ provider: "z-ai", key: "declared-secret" }],
          },
        ],
      ])
    );

    await authProfilesManager.upsertProfile({
      agentId: "template-agent",
      userId: "userA",
      provider: "z-ai",
      credential: "expired-token",
      authType: "oauth",
      label: "z.ai oauth",
      metadata: { expiresAt: Date.now() - 60_000 },
    });

    const best = await authProfilesManager.getBestProfile(
      "template-agent",
      "z-ai",
      undefined,
      { userId: "userA" }
    );
    expect(best?.credential).toBe("declared-secret");
  });

  test("declared settings flow through agentSettingsStore.getEffectiveSettings", async () => {
    declaredAgents.replaceAll(
      new Map([
        [
          "declared-agent",
          {
            settings: {
              installedProviders: [{ providerId: "openai", installedAt: 1 }],
              modelSelection: { mode: "pinned", pinnedModel: "openai/gpt-5" },
              networkConfig: { allowedDomains: ["api.openai.com"] },
            },
            credentials: [{ provider: "openai", key: "sk-declared" }],
          },
        ],
      ])
    );
    store.setDeclaredAgents(declaredAgents);

    const effective = await store.getEffectiveSettings("declared-agent");
    expect(effective?.installedProviders).toEqual([
      { providerId: "openai", installedAt: 1 },
    ]);
    expect(effective?.modelSelection).toEqual({
      mode: "pinned",
      pinnedModel: "openai/gpt-5",
    });
    expect(effective?.networkConfig?.allowedDomains).toEqual([
      "api.openai.com",
    ]);
  });

  test("exposes inherited provider state with read-only model visibility", async () => {
    await withOrg(async () => {
      await seedAgentRow("template-agent", { organizationId: ORG_ID });
      await seedAgentRow("telegram-6570514069", {
        organizationId: ORG_ID,
        parentConnectionId: "conn-1",
      });
      await seedConnection("conn-1", "template-agent");

      await store.saveSettings("template-agent", {
        installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
      });

      const settingsView = await resolveSettingsView({
        agentId: "telegram-6570514069",
        agentSettingsStore: store,
        viewer: {
          settingsMode: "user",
          allowedScopes: ["view-model"],
          isAdmin: false,
        },
      });

      expect(
        canViewSettingsSection("model", {
          settingsMode: "user",
          allowedScopes: ["view-model"],
          isAdmin: false,
        })
      ).toBe(true);
      expect(
        canEditSettingsSection("model", {
          settingsMode: "user",
          allowedScopes: ["view-model"],
          isAdmin: false,
        })
      ).toBe(false);
      expect(settingsView.scope).toBe("sandbox");
      expect(settingsView.sections.model.source).toBe("inherited");
      expect(settingsView.sections.model.editable).toBe(false);
      expect(settingsView.providerSources["z-ai"]?.source).toBe("inherited");
      expect(settingsView.providerSources["z-ai"]?.canEdit).toBe(false);
    });
  });

  test("uninstalling an inherited sandbox provider writes a local override list", async () => {
    await withOrg(async () => {
      await seedAgentRow("template-agent", { organizationId: ORG_ID });
      await seedAgentRow("telegram-6570514069", {
        organizationId: ORG_ID,
        parentConnectionId: "conn-1",
      });
      await seedConnection("conn-1", "template-agent");

      await store.saveSettings("template-agent", {
        installedProviders: [
          { providerId: "z-ai", installedAt: 1 },
          { providerId: "openai", installedAt: 2 },
        ],
      });

      const catalog = new ProviderCatalogService(
        store,
        authProfilesManager,
        declaredAgents
      );
      await catalog.uninstallProvider("telegram-6570514069", "z-ai");

      const local = await store.getSettings("telegram-6570514069");
      const effective = await store.getEffectiveSettings("telegram-6570514069");

      expect(local?.installedProviders).toEqual([
        { providerId: "openai", installedAt: 2 },
      ]);
      expect(effective?.installedProviders).toEqual([
        { providerId: "openai", installedAt: 2 },
      ]);
    });
  });

  test("blocks provider mutations on declared agents", async () => {
    declaredAgents.replaceAll(
      new Map([
        [
          "declared-agent",
          {
            settings: {
              installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
            },
            credentials: [],
          },
        ],
      ])
    );

    const catalog = new ProviderCatalogService(
      store,
      authProfilesManager,
      declaredAgents
    );

    await expect(
      catalog.uninstallProvider("declared-agent", "z-ai")
    ).rejects.toThrow(/declared in lobu\.toml/);
  });
});
