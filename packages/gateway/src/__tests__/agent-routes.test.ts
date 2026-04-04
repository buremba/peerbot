import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store";
import { UserAgentsStore } from "../auth/user-agents-store";
import { createAgentRoutes } from "../routes/public/agents";
import { setAuthProvider } from "../routes/public/settings-auth";

describe("agent routes", () => {
  let redis: MockRedisClient;
  let agentMetadataStore: AgentMetadataStore;
  let agentSettingsStore: AgentSettingsStore;
  let userAgentsStore: UserAgentsStore;

  beforeEach(async () => {
    redis = new MockRedisClient();
    agentMetadataStore = new AgentMetadataStore(redis as any);
    agentSettingsStore = new AgentSettingsStore(redis as any);
    userAgentsStore = new UserAgentsStore(redis as any);

    await agentMetadataStore.createAgent(
      "agent-1",
      "Agent 1",
      "telegram",
      "u1"
    );
    await userAgentsStore.addAgent("telegram", "u1", "agent-1");
  });

  afterEach(() => {
    setAuthProvider(null);
  });

  test("lists agents for external browser sessions by owner userId", async () => {
    setAuthProvider(() => ({
      userId: "u1",
      oauthUserId: "u1",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    const app = createAgentRoutes({
      userAgentsStore,
      agentMetadataStore,
      agentSettingsStore,
      channelBindingService: {
        async getBinding() {
          return null;
        },
        async createBinding() {
          return true;
        },
        async listBindings() {
          return [];
        },
        async deleteAllBindings() {
          return 0;
        },
      } as any,
    });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]?.agentId).toBe("agent-1");
  });
});
