import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-history";

describe("agent history routes", () => {
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
        ownerPlatform: "external",
        ownerUserId: "u1",
      });
      await userAgentsStore.addAgent("external", "u1", "agent-1");
    });
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

    const response = await orgContext.run({ organizationId: ORG_ID }, () =>
      app.request("/api/v1/agents/agent-1/history/status", {
        headers: {
          host: "localhost",
        },
        method: "GET",
      })
    );

    expect(response.status).toBe(401);
  });
});
