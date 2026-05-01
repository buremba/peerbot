import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GrantStore } from "../permissions/grant-store.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
  seedAgentRow,
} from "./helpers/db-setup.js";

describe("GrantStore (PG-backed)", () => {
  let store: GrantStore;

  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    // grants.agent_id has an FK on agents(id); seed the row used by every
    // test in this file so the inserts below succeed.
    await seedAgentRow("agent-1");
    store = new GrantStore();
  });

  describe("grant", () => {
    test("stores grant without expiry when expiresAt is null", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      const grants = await store.listGrants("agent-1");
      expect(grants).toHaveLength(1);
      expect(grants[0]?.pattern).toBe("api.openai.com");
      expect(grants[0]?.expiresAt).toBeNull();
      expect(grants[0]?.grantedAt).toBeGreaterThan(0);
    });

    test("stores grant with expiry when expiresAt is set", async () => {
      const future = Date.now() + 60_000;
      await store.grant("agent-1", "api.openai.com", future);
      const grants = await store.listGrants("agent-1");
      expect(grants).toHaveLength(1);
      expect(grants[0]?.expiresAt).not.toBeNull();
    });

    test("stores denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      const grants = await store.listGrants("agent-1");
      expect(grants[0]?.denied).toBe(true);
    });

    test("preserves MCP path casing when storing grants", async () => {
      await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
      expect(
        await store.hasGrant("agent-1", "/mcp/Gmail/tools/SendEmail")
      ).toBe(true);
    });
  });

  describe("hasGrant", () => {
    test("returns true for existing grant", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
    });

    test("returns false for missing grant", async () => {
      expect(await store.hasGrant("agent-1", "unknown.com")).toBe(false);
    });

    test("returns false for denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      expect(await store.hasGrant("agent-1", "evil.com")).toBe(false);
    });

    test("matches MCP wildcard pattern", async () => {
      await store.grant("agent-1", "/mcp/gmail/tools/*", null);
      expect(
        await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
      ).toBe(true);
    });

    test("matches exact MCP path with original casing", async () => {
      await store.grant("agent-1", "/mcp/Gmail/tools/SendEmail", null);
      expect(
        await store.hasGrant("agent-1", "/mcp/Gmail/tools/SendEmail")
      ).toBe(true);
    });

    test("MCP wildcard denied blocks access", async () => {
      await store.grant("agent-1", "/mcp/gmail/tools/*", null, true);
      expect(
        await store.hasGrant("agent-1", "/mcp/gmail/tools/send_email")
      ).toBe(false);
    });

    test("matches domain wildcard pattern", async () => {
      await store.grant("agent-1", "*.example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("matches leading-dot domain wildcard pattern", async () => {
      await store.grant("agent-1", ".example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("domain wildcard does not match two-part domains", async () => {
      await store.grant("agent-1", "*.example.com", null);
      expect(await store.hasGrant("agent-1", "example.com")).toBe(false);
    });

    test("domain wildcard denied blocks access", async () => {
      await store.grant("agent-1", "*.evil.com", null, true);
      expect(await store.hasGrant("agent-1", "sub.evil.com")).toBe(false);
    });

    test("exact match takes precedence over wildcards", async () => {
      await store.grant("agent-1", "api.example.com", null);
      expect(await store.hasGrant("agent-1", "api.example.com")).toBe(true);
    });

    test("non-MCP non-domain path returns false", async () => {
      expect(await store.hasGrant("agent-1", "/some/other/path")).toBe(false);
    });

    test("expired grant is filtered out", async () => {
      const past = Date.now() - 1000;
      await store.grant("agent-1", "stale.com", past);
      expect(await store.hasGrant("agent-1", "stale.com")).toBe(false);
    });
  });

  describe("isDenied", () => {
    test("returns true for denied grant", async () => {
      await store.grant("agent-1", "evil.com", null, true);
      expect(await store.isDenied("agent-1", "evil.com")).toBe(true);
    });

    test("returns false for allowed grant", async () => {
      await store.grant("agent-1", "good.com", null);
      expect(await store.isDenied("agent-1", "good.com")).toBe(false);
    });

    test("returns false for missing grant", async () => {
      expect(await store.isDenied("agent-1", "unknown.com")).toBe(false);
    });
  });

  describe("revoke", () => {
    test("removes grant", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(true);
      await store.revoke("agent-1", "api.openai.com");
      expect(await store.hasGrant("agent-1", "api.openai.com")).toBe(false);
    });

    test("removes normalized wildcard grant variants", async () => {
      await store.grant("agent-1", "*.github.com", null);
      expect(await store.hasGrant("agent-1", "api.github.com")).toBe(true);
      await store.revoke("agent-1", ".github.com");
      expect(await store.hasGrant("agent-1", "api.github.com")).toBe(false);
    });
  });

  describe("listGrants", () => {
    test("returns empty array when no grants", async () => {
      const grants = await store.listGrants("agent-1");
      expect(grants).toEqual([]);
    });

    test("lists every active grant for the agent", async () => {
      await store.grant("agent-1", "api.openai.com", null);
      await store.grant("agent-1", "*.github.com", null);
      const grants = await store.listGrants("agent-1");
      expect(grants).toHaveLength(2);
      const patterns = grants.map((g) => g.pattern).sort();
      expect(patterns).toEqual([".github.com", "api.openai.com"]);
    });
  });
});
