import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { UserAgentsStore } from "../auth/user-agents-store";
import { createAgentHistoryRoutes } from "../routes/public/agent-history";
import { setAuthProvider } from "../routes/public/settings-auth";

describe("agent history routes", () => {
  let redis: MockRedisClient;
  let agentMetadataStore: AgentMetadataStore;
  let userAgentsStore: UserAgentsStore;

  beforeEach(async () => {
    redis = new MockRedisClient();
    agentMetadataStore = new AgentMetadataStore(redis as any);
    userAgentsStore = new UserAgentsStore(redis as any);

    await agentMetadataStore.createAgent(
      "agent-1",
      "Agent 1",
      "external",
      "u1"
    );
    await userAgentsStore.addAgent("external", "u1", "agent-1");
  });

  afterEach(() => {
    setAuthProvider(null);
  });

  test("rejects sessions that do not own the requested agent", async () => {
    setAuthProvider(() => ({
      userId: "u2",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    const app = new Hono();
    app.route(
      "/api/v1/agents/:agentId/history",
      createAgentHistoryRoutes({
        connectionManager: {
          getDeploymentsForAgent() {
            return [];
          },
          getHttpUrl() {
            return null;
          },
        } as any,
        agentConfigStore: {
          getMetadata: (agentId: string) =>
            agentMetadataStore.getMetadata(agentId),
          listSandboxes: async () => [],
        },
        userAgentsStore,
      })
    );

    const response = await app.request(
      "/api/v1/agents/agent-1/history/status",
      {
        headers: {
          host: "localhost",
        },
        method: "GET",
      }
    );

    expect(response.status).toBe(401);
  });
});
