import { beforeEach, describe, expect, test } from "bun:test";
import { MockRedisClient } from "@lobu/core/testing";
import { AgentSettingsStore } from "../auth/settings/agent-settings-store";

function createStore(redis?: MockRedisClient) {
  const r = redis ?? new MockRedisClient();
  const store = new AgentSettingsStore(r as any);
  return { store, redis: r };
}

describe("AgentSettingsStore", () => {
  let store: AgentSettingsStore;

  beforeEach(() => {
    store = createStore().store;
  });

  describe("CRUD basics", () => {
    test("saveSettings stores and getSettings retrieves", async () => {
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      const result = await store.getSettings("agent-1");
      expect(result).not.toBeNull();
      expect(result!.model).toBe("claude-sonnet-4");
      expect(result!.updatedAt).toBeGreaterThan(0);
    });

    test("getSettings returns null for non-existent agent", async () => {
      const result = await store.getSettings("missing");
      expect(result).toBeNull();
    });

    test("updateSettings merges with existing", async () => {
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      await store.updateSettings("agent-1", { soulMd: "Be helpful" });
      const result = await store.getSettings("agent-1");
      expect(result!.model).toBe("claude-sonnet-4");
      expect(result!.soulMd).toBe("Be helpful");
    });

    test("deleteSettings removes settings", async () => {
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      await store.deleteSettings("agent-1");
      const result = await store.getSettings("agent-1");
      expect(result).toBeNull();
    });

    test("hasSettings returns boolean", async () => {
      expect(await store.hasSettings("agent-1")).toBe(false);
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      expect(await store.hasSettings("agent-1")).toBe(true);
    });
  });

  describe("partial update merging", () => {
    test("merges new fields with existing", async () => {
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

    test("overwrites overlapping fields", async () => {
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      await store.updateSettings("agent-1", { model: "claude-opus-4" });
      const result = await store.getSettings("agent-1");
      expect(result!.model).toBe("claude-opus-4");
    });

    test("creates if no existing settings", async () => {
      await store.updateSettings("agent-1", { model: "claude-opus-4" });
      const result = await store.getSettings("agent-1");
      expect(result).not.toBeNull();
      expect(result!.model).toBe("claude-opus-4");
    });
  });

  describe("findSandboxAgentIds", () => {
    test("returns agent IDs referencing template", async () => {
      const templateId = "template-agent";

      await store.saveSettings(templateId, {
        model: "claude-opus-4",
        installedProviders: [{ providerId: "anthropic", installedAt: 1 }],
      });

      await store.saveSettings("sandbox-1", {
        model: "claude-sonnet-4",
        templateAgentId: templateId,
      });

      await store.saveSettings("sandbox-2", {
        model: "claude-sonnet-4",
        templateAgentId: templateId,
      });

      await store.saveSettings("other-agent", { model: "claude-sonnet-4" });

      const sandboxIds = await store.findSandboxAgentIds(templateId);
      expect(sandboxIds).toHaveLength(2);
      expect(sandboxIds.sort()).toEqual(["sandbox-1", "sandbox-2"]);
    });

    test("returns empty array when no sandboxes exist", async () => {
      await store.saveSettings("agent-1", { model: "claude-sonnet-4" });
      const sandboxIds = await store.findSandboxAgentIds("non-existent");
      expect(sandboxIds).toEqual([]);
    });
  });
});
