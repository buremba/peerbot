import { afterEach, describe, expect, test } from "bun:test";
import type { AgentConfigStore, AgentSettings } from "@lobu/core";
import { Hono } from "hono";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import type { UserAgentsStore } from "../auth/user-agents-store.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { setAuthProvider } from "../routes/public/settings-auth.js";

const AGENT_ID = "lobu-builder";
const ORGANIZATION_ID = "org-b";

function createApp(
  settingsReads: Array<string | undefined>,
  organizations = [ORGANIZATION_ID],
): Hono {
  const configStore = {
    async getSettings(): Promise<AgentSettings> {
      settingsReads.push(orgContext.getStore()?.organizationId);
      return {
        models: ["gemini/gemini-2.5-flash"],
        updatedAt: Date.now(),
      };
    },
    async getMetadata() {
      return null;
    },
  } as AgentConfigStore;
  const userAgentsStore = {
    async findAgentOrganizations() {
      return organizations;
    },
  } as UserAgentsStore;
  const router = createAgentConfigRoutes({
    agentSettingsStore: new AgentSettingsStore(configStore),
    agentConfigStore: configStore,
    userAgentsStore,
  });
  const app = new Hono();
  app.route("/api/v1/agents/:agentId/config", router);
  return app;
}

describe("agent config tenant scope", () => {
  afterEach(() => {
    setAuthProvider(null);
  });

  test("uses the tenant proven by the settings-cookie owner mapping", async () => {
    const settingsReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const response = await createApp(settingsReads).request(
      `/api/v1/agents/${AGENT_ID}/config`,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).models).toEqual([
      "gemini/gemini-2.5-flash",
    ]);
    expect(settingsReads).toEqual([ORGANIZATION_ID]);
  });

  test("rejects an ambiguous owner mapping without reading settings", async () => {
    const settingsReads: Array<string | undefined> = [];
    setAuthProvider(() => ({
      userId: "owner-b",
      platform: "slack",
      agentId: AGENT_ID,
      exp: Date.now() + 60_000,
    }));

    const response = await createApp(settingsReads, [
      "org-a",
      ORGANIZATION_ID,
    ]).request(`/api/v1/agents/${AGENT_ID}/config`);

    expect(response.status).toBe(401);
    expect(settingsReads).toEqual([]);
  });
});
