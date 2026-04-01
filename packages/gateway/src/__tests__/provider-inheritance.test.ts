import { beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import {
  ProviderCatalogService,
  resolveInstalledProviders,
} from "../auth/provider-catalog";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import { AuthProfilesManager } from "../auth/settings/auth-profiles-manager";
import {
  canEditSettingsSection,
  canViewSettingsSection,
  resolveSettingsView,
} from "../auth/settings/resolved-settings-view";
import { buildDefaultSettingsFromSource } from "../auth/settings/template-utils";
import { hasConfiguredProvider } from "../services/platform-helpers";

describe("sandbox provider inheritance", () => {
  let redis: MockRedisClient;
  let store: AgentSettingsStore;
  let authProfilesManager: AuthProfilesManager;

  beforeEach(() => {
    redis = new MockRedisClient();
    store = new AgentSettingsStore(redis as any);
    authProfilesManager = new AuthProfilesManager(store);
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

  test("inherits auth profiles through metadata and connection template fallback", async () => {
    await store.saveSettings("template-agent", {
      authProfiles: [
        {
          id: "profile-1",
          provider: "z-ai",
          credential: "secret",
          authType: "api-key",
          label: "z.ai",
          model: "*",
          createdAt: 1,
        },
      ],
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

    const profiles = await authProfilesManager.listProfiles(
      "telegram-6570514069"
    );

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.provider).toBe("z-ai");
    expect(profiles[0]?.credential).toBe("secret");
  });

  test("inherits auth profiles for cloned sandbox settings that copied providers", async () => {
    await store.saveSettings("template-agent", {
      authProfiles: [
        {
          id: "profile-1",
          provider: "z-ai",
          credential: "secret",
          authType: "api-key",
          label: "z.ai",
          model: "*",
          createdAt: 1,
        },
      ],
      installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
    });

    const templateSettings = await store.getSettings("template-agent");
    const cloned = buildDefaultSettingsFromSource(templateSettings);
    cloned.templateAgentId = "template-agent";
    await store.saveSettings("telegram-6570514069", cloned);

    const effective = await store.getEffectiveSettings("telegram-6570514069");
    const profiles = await authProfilesManager.listProfiles(
      "telegram-6570514069"
    );

    expect(cloned.authProfiles).toBeUndefined();
    expect(effective?.authProfiles).toHaveLength(1);
    expect(profiles).toHaveLength(1);
  });

  test("treats cloned sandbox settings as configured when template provides credentials", async () => {
    await store.saveSettings("template-agent", {
      authProfiles: [
        {
          id: "profile-1",
          provider: "z-ai",
          credential: "secret",
          authType: "api-key",
          label: "z.ai",
          model: "*",
          createdAt: 1,
        },
      ],
      installedProviders: [{ providerId: "z-ai", installedAt: 1 }],
    });

    const templateSettings = await store.getSettings("template-agent");
    const cloned = buildDefaultSettingsFromSource(templateSettings);
    cloned.templateAgentId = "template-agent";
    await store.saveSettings("telegram-6570514069", cloned);

    await expect(
      hasConfiguredProvider("telegram-6570514069", store)
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

    const catalog = new ProviderCatalogService(store, authProfilesManager);
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
