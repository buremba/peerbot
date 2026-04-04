import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { UserAgentsStore } from "../auth/user-agents-store";
import { createConnectionCrudRoutes } from "../routes/public/connections";
import { setAuthProvider } from "../routes/public/settings-auth";

describe("connection routes", () => {
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
      "telegram",
      "u1"
    );
    await agentMetadataStore.createAgent(
      "sandbox-1",
      "Sandbox 1",
      "telegram",
      "u1",
      {
        parentConnectionId: "conn-1",
      }
    );
    await userAgentsStore.addAgent("telegram", "u1", "agent-1");
  });

  afterEach(() => {
    setAuthProvider(null);
  });

  function buildApp() {
    return createConnectionCrudRoutes(
      {
        async listConnections(filters?: any) {
          const connection = {
            id: "conn-1",
            platform: "telegram",
            templateAgentId: "agent-1",
            config: { platform: "telegram" },
            settings: {},
            metadata: {},
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          };
          if (
            filters?.templateAgentId &&
            filters.templateAgentId !== "agent-1"
          ) {
            return [];
          }
          return [connection];
        },
        async getConnection(id: string) {
          if (id !== "conn-1") return null;
          return {
            id: "conn-1",
            platform: "telegram",
            templateAgentId: "agent-1",
            config: { platform: "telegram" },
            settings: {},
            metadata: {},
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          };
        },
        has() {
          return true;
        },
        getServices() {
          return {
            getQueue() {
              return {
                getRedisClient() {
                  return redis;
                },
              };
            },
          };
        },
      } as any,
      {
        userAgentsStore,
        agentMetadataStore: {
          getMetadata: (agentId: string) =>
            agentMetadataStore.getMetadata(agentId),
          listSandboxes: (connectionId: string) =>
            agentMetadataStore.listSandboxes(connectionId),
        },
      }
    );
  }

  test("forbids non-admin sessions from listing all connections", async () => {
    setAuthProvider(() => ({
      userId: "u1",
      platform: "telegram",
      exp: Date.now() + 60_000,
    }));

    const response = await buildApp().request("/api/v1/connections");
    expect(response.status).toBe(403);
  });

  test("allows external owner sessions to list connections for their agent", async () => {
    setAuthProvider(() => ({
      userId: "u1",
      oauthUserId: "u1",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    const response = await buildApp().request(
      "/api/v1/connections?templateAgentId=agent-1"
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.connections).toHaveLength(1);
    expect(data.connections[0]?.id).toBe("conn-1");
  });

  test("forbids sandbox listing when session cannot access the connection template agent", async () => {
    setAuthProvider(() => ({
      userId: "u2",
      platform: "telegram",
      exp: Date.now() + 60_000,
    }));

    const response = await buildApp().request(
      "/api/v1/connections/conn-1/sandboxes"
    );
    expect(response.status).toBe(403);
  });
});
