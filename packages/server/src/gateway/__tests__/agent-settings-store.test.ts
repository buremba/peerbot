import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPostgresAgentConfigStore } from "../../lobu/stores/postgres-stores.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-settings";

describe("AgentSettingsStore", () => {
  let store: AgentSettingsStore;

  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore(createPostgresAgentConfigStore());
  });

  function withOrg<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run({ organizationId: ORG_ID }, fn);
  }

  describe("CRUD basics", () => {
    test("getSettings uses explicit organization context when agent ids collide", async () => {
      const otherOrg = `${ORG_ID}-other`;
      await orgContext.run({ organizationId: ORG_ID }, async () => {
        await seedAgentRow("shared-agent", { organizationId: ORG_ID });
        await store.saveSettings("shared-agent", {
          defaultModel: "openai/gpt-4o-mini",
        });
      });
      await orgContext.run({ organizationId: otherOrg }, async () => {
        await seedAgentRow("shared-agent", { organizationId: otherOrg });
        await store.saveSettings("shared-agent", {
          defaultModel: "z-ai/glm-5.2",
        });
      });

      const settings = await store.getSettings("shared-agent", {
        organizationId: ORG_ID,
      });

      expect(settings?.defaultModel).toBe("openai/gpt-4o-mini");
    });

    test("saveSettings stores and getSettings retrieves", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { defaultModel: "claude-sonnet-4" });
        const result = await store.getSettings("agent-1");
        expect(result).not.toBeNull();
        expect(result!.defaultModel).toBe("claude-sonnet-4");
        expect(result!.updatedAt).toBeGreaterThan(0);
      });
    });

    test("getSettings returns null for non-existent agent", async () => {
      await withOrg(async () => {
        const result = await store.getSettings("missing");
        expect(result).toBeNull();
      });
    });

    test("updateSettings merges with existing", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { defaultModel: "claude-sonnet-4" });
        await store.updateSettings("agent-1", { soulMd: "Be helpful" });
        const result = await store.getSettings("agent-1");
        expect(result!.defaultModel).toBe("claude-sonnet-4");
        expect(result!.soulMd).toBe("Be helpful");
      });
    });

    test("deleteSettings removes settings", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { defaultModel: "claude-sonnet-4" });
        await store.deleteSettings("agent-1");
        const result = await store.getSettings("agent-1");
        // After deleteSettings the row still exists but settings columns are
        // reset; getSettings returns a default-shaped object with no model.
        expect(result).not.toBeNull();
        expect(result!.defaultModel).toBeUndefined();
      });
    });

    test("hasSettings tracks row existence", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        expect(await store.hasSettings("agent-1")).toBe(true);
      });
    });
  });

  describe("partial update merging", () => {
    test("merges new fields with existing", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", {
          defaultModel: "claude-sonnet-4",
          soulMd: "Original",
        });
        await store.updateSettings("agent-1", { userMd: "New field" });
        const result = await store.getSettings("agent-1");
        expect(result!.defaultModel).toBe("claude-sonnet-4");
        expect(result!.soulMd).toBe("Original");
        expect(result!.userMd).toBe("New field");
      });
    });

    test("overwrites overlapping fields", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { defaultModel: "claude-sonnet-4" });
        await store.updateSettings("agent-1", { defaultModel: "claude-opus-4" });
        const result = await store.getSettings("agent-1");
        expect(result!.defaultModel).toBe("claude-opus-4");
      });
    });
  });

});
