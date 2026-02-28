import { describe, expect, test } from "bun:test";
import {
  type BaseProviderConfig,
  BaseProviderModule,
} from "../auth/base-provider-module";
import {
  generateChannelSettingsToken,
  generateSettingsToken,
} from "../auth/settings/token-service";

const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}

class TestProviderModule extends BaseProviderModule {
  constructor(authProfilesManager: {
    upsertProfile(input: unknown): Promise<void>;
    deleteProviderProfiles(
      agentId: string,
      providerId: string,
      profileId?: string
    ): Promise<void>;
    hasProviderProfiles(agentId: string, providerId: string): Promise<boolean>;
    getBestProfile(agentId: string, providerId: string): Promise<unknown>;
  }) {
    const config: BaseProviderConfig = {
      providerId: "test-provider",
      providerDisplayName: "Test Provider",
      providerIconUrl: "https://example.com/icon.png",
      credentialEnvVarName: "TEST_PROVIDER_API_KEY",
      secretEnvVarNames: ["TEST_PROVIDER_API_KEY"],
      authType: "api-key",
    };

    super(config, authProfilesManager as any);
  }
}

function createAuthProfilesManagerMock() {
  const upsertCalls: unknown[] = [];
  const deleteCalls: Array<{
    agentId: string;
    providerId: string;
    profileId?: string;
  }> = [];

  const manager = {
    async upsertProfile(input: unknown): Promise<void> {
      upsertCalls.push(input);
    },
    async deleteProviderProfiles(
      agentId: string,
      providerId: string,
      profileId?: string
    ): Promise<void> {
      deleteCalls.push({ agentId, providerId, profileId });
    },
    async hasProviderProfiles(): Promise<boolean> {
      return false;
    },
    async getBestProfile(): Promise<null> {
      return null;
    },
  };

  return { manager, upsertCalls, deleteCalls };
}

describe("BaseProviderModule auth protection", () => {
  test("rejects unauthenticated save-key requests", async () => {
    const { manager, upsertCalls } = createAuthProfilesManagerMock();
    const module = new TestProviderModule(manager);

    const response = await module.getApp().request("/save-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1", apiKey: "sk-test" }),
    });

    expect(response.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  test("rejects unauthenticated logout requests", async () => {
    const { manager, deleteCalls } = createAuthProfilesManagerMock();
    const module = new TestProviderModule(manager);

    const response = await module.getApp().request("/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-1" }),
    });

    expect(response.status).toBe(401);
    expect(deleteCalls).toHaveLength(0);
  });

  test("accepts authenticated save-key requests with matching agent token", async () => {
    const { manager, upsertCalls } = createAuthProfilesManagerMock();
    const module = new TestProviderModule(manager);
    const token = generateSettingsToken("agent-1", "user-1", "slack");

    const response = await module
      .getApp()
      .request(`/save-key?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", apiKey: "sk-test" }),
      });

    expect(response.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
  });

  test("rejects authenticated save-key requests when token agent mismatches", async () => {
    const { manager, upsertCalls } = createAuthProfilesManagerMock();
    const module = new TestProviderModule(manager);
    const token = generateSettingsToken("agent-2", "user-1", "slack");

    const response = await module
      .getApp()
      .request(`/save-key?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", apiKey: "sk-test" }),
      });

    expect(response.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });

  test("rejects channel-scoped token for save-key requests", async () => {
    const { manager, upsertCalls } = createAuthProfilesManagerMock();
    const module = new TestProviderModule(manager);
    const token = generateChannelSettingsToken("user-1", "slack", "C123");

    const response = await module
      .getApp()
      .request(`/save-key?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: "agent-1", apiKey: "sk-test" }),
      });

    expect(response.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });
});
