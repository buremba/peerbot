import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createConnectionCrudRoutes } from "../routes/public/connections.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-conn-routes";

describe("connection routes", () => {
  let agentMetadataStore: AgentMetadataStore;
  let userAgentsStore: UserAgentsStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    agentMetadataStore = new AgentMetadataStore();
    userAgentsStore = new UserAgentsStore();

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      await seedAgentRow("agent-1", {
        organizationId: ORG_ID,
        name: "Agent 1",
        ownerPlatform: "telegram",
        ownerUserId: "u1",
      });
      await seedAgentRow("sandbox-1", {
        organizationId: ORG_ID,
        name: "Sandbox 1",
        ownerPlatform: "telegram",
        ownerUserId: "u1",
        parentConnectionId: "conn-1",
      });
      await userAgentsStore.addAgent("telegram", "u1", "agent-1");
    });
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
              return {};
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

    const response = await orgContext.run({ organizationId: ORG_ID }, () =>
      buildApp().request("/api/v1/connections")
    );
    expect(response.status).toBe(403);
  });

  test("allows external owner sessions to list connections for their agent", async () => {
    setAuthProvider(() => ({
      userId: "u1",
      oauthUserId: "u1",
      platform: "external",
      exp: Date.now() + 60_000,
    }));

    const response = await orgContext.run({ organizationId: ORG_ID }, () =>
      buildApp().request("/api/v1/connections?templateAgentId=agent-1")
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

    const response = await orgContext.run({ organizationId: ORG_ID }, () =>
      buildApp().request("/api/v1/connections/conn-1/sandboxes")
    );
    expect(response.status).toBe(403);
  });
});
