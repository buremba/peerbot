/**
 * Integration smoke test that actually dispatches through every namespace's
 * read path. Catches field-name drift between the SDK wrapper and the handler
 * TypeBox schema — the kind of bug static `as never` casts hide.
 *
 * Only read/list methods are exercised here; write smoke coverage lives in
 * the per-tool integration tests that already exist in the repo.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { buildClientSDK, type ClientSDK } from "../../../sandbox/client-sdk";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from "../../setup/test-fixtures";

const testEnv: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
};


describe("ClientSDK namespace dispatch (read paths)", () => {
  let sdk: ClientSDK;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();
    const org = await createTestOrganization({
      name: "Dispatch Org",
      slug: "dispatch-sdk",
    });
    const user = await createTestUser({
      email: "dispatch-sdk@test.example.com",
    });
    await addUserToOrganization(user.id, org.id, "owner");
    const ctx: ToolContext = {
      organizationId: org.id,
      userId: user.id,
      memberRole: "owner",
      isAuthenticated: true,
      tokenType: "oauth",
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
      scopedToOrg: false,
      allowCrossOrg: true,
    };
    sdk = buildClientSDK(ctx, testEnv);
  });

  it("entities.list dispatches cleanly", async () => {
    await expect(sdk.entities.list()).resolves.toBeDefined();
  });

  it("entitySchema.listTypes dispatches cleanly", async () => {
    await expect(sdk.entitySchema.listTypes()).resolves.toBeDefined();
  });

  it("entitySchema.listRelTypes dispatches cleanly", async () => {
    await expect(sdk.entitySchema.listRelTypes()).resolves.toBeDefined();
  });

  it("connections.list dispatches cleanly", async () => {
    await expect(sdk.connections.list()).resolves.toBeDefined();
  });

  it(
    "connections.listConnectorDefinitions dispatches cleanly",
    async () => {
      await expect(
        sdk.connections.listConnectorDefinitions(),
      ).resolves.toBeDefined();
    },
  );

  it("feeds.list dispatches cleanly", async () => {
    await expect(sdk.feeds.list()).resolves.toBeDefined();
  });

  it("authProfiles.list dispatches cleanly", async () => {
    await expect(sdk.authProfiles.list()).resolves.toBeDefined();
  });

  it("operations.listAvailable dispatches cleanly", async () => {
    await expect(sdk.operations.listAvailable()).resolves.toBeDefined();
  });

  // NOTE: the wrapper dispatch itself is asserted by the listAvailable test
  // above; operations.listRuns result-shape is covered by the operations
  // suite, not duplicated here.

  it("watchers.list dispatches cleanly", async () => {
    await expect(sdk.watchers.list()).resolves.toBeDefined();
  });

  it("classifiers.list dispatches cleanly", async () => {
    await expect(sdk.classifiers.list()).resolves.toBeDefined();
  });

  it("organizations.list dispatches cleanly", async () => {
    const orgs = await sdk.organizations.list();
    expect(Array.isArray(orgs)).toBe(true);
  });

  it("organizations.current returns the session org", async () => {
    const current = await sdk.organizations.current();
    expect(current.slug).toBe("dispatch-sdk");
  });

  it("knowledge.search dispatches cleanly", async () => {
    await expect(
      sdk.knowledge.search({ query: "nothing-here-likely" }),
    ).resolves.toBeDefined();
  });

  it("query runs a scoped read-only statement", async () => {
    const rows = await sdk.query("SELECT COUNT(*)::int AS n FROM entities");
    expect(Array.isArray(rows)).toBe(true);
  });
});
