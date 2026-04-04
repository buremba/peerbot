import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { UserAgentsStore } from "../auth/user-agents-store";
import { createAgentSchedulesRoutes } from "../routes/public/agent-schedules";
import { setAuthProvider } from "../routes/public/settings-auth";

describe("agent schedules routes", () => {
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

  test("rejects neutral sessions that do not own the agent", async () => {
    setAuthProvider(() => ({
      userId: "u2",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    const app = new OpenAPIHono();
    app.route(
      "/api/v1/agents/:agentId/schedules",
      createAgentSchedulesRoutes({
        scheduledWakeupService: {
          async listPendingForAgent() {
            return [];
          },
        } as any,
        userAgentsStore,
        agentMetadataStore: {
          getMetadata: (agentId: string) =>
            agentMetadataStore.getMetadata(agentId),
        },
      })
    );

    const response = await app.request("/api/v1/agents/agent-1/schedules");
    expect(response.status).toBe(401);
  });
});
