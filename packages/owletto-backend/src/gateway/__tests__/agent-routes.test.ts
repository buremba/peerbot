import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentRoutes } from "../routes/public/agents.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-routes";

describe("agent routes", () => {
  let agentMetadataStore: AgentMetadataStore;
  let agentSettingsStore: AgentSettingsStore;
  let userAgentsStore: UserAgentsStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    agentMetadataStore = new AgentMetadataStore();
    agentSettingsStore = new AgentSettingsStore();
    userAgentsStore = new UserAgentsStore();

    await orgContext.run({ organizationId: ORG_ID }, async () => {
      await seedAgentRow("agent-1", {
        organizationId: ORG_ID,
        name: "Agent 1",
        ownerPlatform: "telegram",
        ownerUserId: "u1",
      });
      await userAgentsStore.addAgent("telegram", "u1", "agent-1");
    });
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

    const response = await orgContext.run(
      { organizationId: ORG_ID },
      () => app.request("/")
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]?.agentId).toBe("agent-1");
  });
});
