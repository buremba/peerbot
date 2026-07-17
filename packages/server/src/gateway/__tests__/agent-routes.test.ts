import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentMetadataStore } from "../auth/agent-metadata-store.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentRoutes } from "../routes/public/agents.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-routes";
const ORG_OTHER = "test-org-agent-routes-other";

describe("agent routes", () => {
  let agentMetadataStore: AgentMetadataStore;
  let agentSettingsStore: AgentSettingsStore;
  let userAgentsStore: UserAgentsStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    const configStore = createPostgresAgentConfigStore();
    agentMetadataStore = new AgentMetadataStore(configStore);
    agentSettingsStore = new AgentSettingsStore(configStore);
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

  test("GET collection is org-scoped: never surfaces another org's same-named agent", async () => {
    // A DIFFERENT org owns the SAME agent id (agents PK = (org, id)), owned by a
    // DIFFERENT user. The GET collection derives
    // each agent's org from the authoritative per-caller source, so u1 must see
    // ONLY their org's `agent-1` (name + channelCount), never org-other's.
    await orgContext.run({ organizationId: ORG_OTHER }, async () => {
      await seedAgentRow("agent-1", {
        organizationId: ORG_OTHER,
        name: "Other Org Agent 1",
        ownerPlatform: "telegram",
        ownerUserId: "someone-else",
      });
    });
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
    });

    const response = await orgContext.run({ organizationId: ORG_ID }, () =>
      app.request("/")
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    // Exactly ORG_ID's agent-1 — the other org's same-named agent is NOT listed.
    expect(data.agents).toHaveLength(1);
    expect(data.agents[0]?.agentId).toBe("agent-1");
    expect(data.agents[0]?.name).toBe("Agent 1");
  });
});
