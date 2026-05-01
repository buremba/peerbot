import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { orgContext } from "../../lobu/stores/org-context.js";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

const ORG_ID = "test-org-agent-settings";

describe("AgentSettingsStore", () => {
  let store: AgentSettingsStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    store = new AgentSettingsStore();
  });

  function withOrg<T>(fn: () => Promise<T>): Promise<T> {
    return orgContext.run({ organizationId: ORG_ID }, fn);
  }

  describe("CRUD basics", () => {
    test("saveSettings stores and getSettings retrieves", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
        const result = await store.getSettings("agent-1");
        expect(result).not.toBeNull();
        expect(result!.model).toBe("claude-sonnet-4");
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
        await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
        await store.updateSettings("agent-1", { soulMd: "Be helpful" });
        const result = await store.getSettings("agent-1");
        expect(result!.model).toBe("claude-sonnet-4");
        expect(result!.soulMd).toBe("Be helpful");
      });
    });

    test("deleteSettings removes settings", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
        await store.deleteSettings("agent-1");
        const result = await store.getSettings("agent-1");
        // After deleteSettings the row still exists but settings columns are
        // reset; getSettings returns a default-shaped object with no model.
        expect(result).not.toBeNull();
        expect(result!.model).toBeUndefined();
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
          model: "claude-sonnet-4",
          soulMd: "Original",
        });
        await store.updateSettings("agent-1", { userMd: "New field" });
        const result = await store.getSettings("agent-1");
        expect(result!.model).toBe("claude-sonnet-4");
        expect(result!.soulMd).toBe("Original");
        expect(result!.userMd).toBe("New field");
      });
    });

    test("overwrites overlapping fields", async () => {
      await withOrg(async () => {
        await seedAgentRow("agent-1", { organizationId: ORG_ID });
        await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
        await store.updateSettings("agent-1", { model: "claude-opus-4" });
        const result = await store.getSettings("agent-1");
        expect(result!.model).toBe("claude-opus-4");
      });
    });
  });

  describe("findSandboxAgentIds", () => {
    test("returns agent IDs referencing template", async () => {
      await withOrg(async () => {
        const templateId = "template-agent";
        await seedAgentRow(templateId, { organizationId: ORG_ID });
        await store.saveSettings(templateId, {
          model: "claude-opus-4",
          installedProviders: [{ providerId: "anthropic", installedAt: 1 }],
        });

        await seedAgentRow("sandbox-1", {
          organizationId: ORG_ID,
          templateAgentId: templateId,
        });
        await store.saveSettings("sandbox-1", {
          model: "claude-sonnet-4",
          templateAgentId: templateId,
        });

        await seedAgentRow("sandbox-2", {
          organizationId: ORG_ID,
          templateAgentId: templateId,
        });
        await store.saveSettings("sandbox-2", {
          model: "claude-sonnet-4",
          templateAgentId: templateId,
        });

        await seedAgentRow("other-agent", { organizationId: ORG_ID });
        await store.saveSettings("other-agent", { model: "claude-sonnet-4" });

        const sandboxIds = await store.findSandboxAgentIds(templateId);
        expect(sandboxIds.sort()).toEqual(["sandbox-1", "sandbox-2"]);
      });
    });

    test("returns empty array when no sandboxes exist", async () => {
      await withOrg(async () => {
        const sandboxIds = await store.findSandboxAgentIds("non-existent");
        expect(sandboxIds).toEqual([]);
      });
    });
  });
});
