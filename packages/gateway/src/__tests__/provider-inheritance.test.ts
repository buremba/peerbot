import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import {
  ProviderCatalogService,
  resolveInstalledProviders,
} from "../auth/provider-catalog";
import {
  AgentSettingsStore,
  EphemeralAuthProfileRegistry,
} from "../auth/settings/agent-settings-store";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager";
import {
  canEditSettingsSection,
  canViewSettingsSection,
  resolveSettingsView,
} from "../auth/settings/resolved-settings-view";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store";
import { RedisSecretStore } from "../secrets";
import { DeclaredAgentRegistry } from "../services/declared-agent-registry";
import { hasConfiguredProvider } from "../services/platform-helpers";

const TEST_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

let originalEncryptionKey: string | undefined;

beforeAll(() => {
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

afterAll(() => {
  if (originalEncryptionKey !== undefined) {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
  } else {
    delete process.env.ENCRYPTION_KEY;
  }
});

describe("sandbox provider inheritance", () => {
  let redis: MockRedisClient;
  let store: AgentSettingsStore;
  let secretStore: RedisSecretStore;
  let userAuthProfiles: UserAuthProfileStore;
  let declaredAgents: DeclaredAgentRegistry;
  let authProfilesManager: AuthProfilesManager;

  beforeEach(() => {
    redis = new MockRedisClient();
    secretStore = new RedisSecretStore(redis as any, "lobu:test:secrets:");
    store = new AgentSettingsStore(redis as any);
    userAuthProfiles = new UserAuthProfileStore(redis as any, secretStore);
    declaredAgents = new DeclaredAgentRegistry();
    authProfilesManager = new AuthProfilesManager({
      ephemeralProfiles: new EphemeralAuthProfileRegistry(),
      declaredAgents,
      userAuthProfiles,
      secretStore,
    });
  });

  test("inherits installed providers through metadata and connection template fallback", async () => {
    await store.saveSettings("template-agent", {
      installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
    });
    await redis.set(
      "agent_metadata:telegram-6570514069",
      JSON.stringify({ parentConnectionId: "conn-1" })
    );
    await redis.set(
      "connection:conn-1",
      JSON.stringify({ templateAgentId: "template-agent" })
    );

    const providers = await resolveInstalledProviders(
      store,
      "telegram-6570514069"
    );

    expect(providers).toEqual([{ providerId: "z-ai", installedAt: 1 }]);
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

  test("treats declared agent as configured even without system key", async () => {
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

    await expect(
      hasConfiguredProvider("template-agent", store, declaredAgents)
    ).resolves.toBe(true);
  });

  test("exposes inherited provider state with read-only model visibility", async () => {
    await store.saveSettings("template-agent", {
      installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
    });
    await redis.set(
      "agent_metadata:telegram-6570514069",
      JSON.stringify({ parentConnectionId: "conn-1" })
    );
    await redis.set(
      "connection:conn-1",
      JSON.stringify({ templateAgentId: "template-agent" })
    );

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

  test("uninstalling an inherited sandbox provider writes a local override list", async () => {
    await store.saveSettings("template-agent", {
      installedProviders: [
        { providerId: "z-ai", installedAt: 1 },
        { providerId: "openai", installedAt: 2 },
      ],
    });
    await redis.set(
      "agent_metadata:telegram-6570514069",
      JSON.stringify({ parentConnectionId: "conn-1" })
    );
    await redis.set(
      "connection:conn-1",
      JSON.stringify({ templateAgentId: "template-agent" })
    );

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
