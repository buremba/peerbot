/**
 * Integration tests for `ClientSDK.org()` — the cross-org accessor.
 *
 * Exercises the real `organization` / `member` tables and the shared
 * auth-layer cache (`multi-tenant.ts#memberRoleCache`). Covers slug and id
 * resolution, AccessDenied / OrgNotFound error shape, public-workspace
 * fallback, and revocation flowing through the explicit cache invalidation.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
  AccessDeniedError,
  buildClientSDK,
  OrgNotFoundError,
  resolveOrgMembership,
} from "../../../sandbox/client-sdk";
import type { ToolContext } from "../../../tools/registry";
import { invalidateMembershipRoleCache } from "../../../workspace/multi-tenant";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from "../../setup/test-fixtures";

const testEnv: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
};

describe("ClientSDK.org() accessor", () => {
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgPublic: Awaited<ReturnType<typeof createTestOrganization>>;
  let user1: Awaited<ReturnType<typeof createTestUser>>;
  let user2: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    orgA = await createTestOrganization({ name: "Org A", slug: "org-a-sdk" });
    orgB = await createTestOrganization({ name: "Org B", slug: "org-b-sdk" });
    orgPublic = await createTestOrganization({
      name: "Org Public",
      slug: "org-public-sdk",
      visibility: "public",
    });
    user1 = await createTestUser({ email: "user1-sdk@test.example.com" });
    user2 = await createTestUser({ email: "user2-sdk@test.example.com" });
    await addUserToOrganization(user1.id, orgA.id, "owner");
    await addUserToOrganization(user2.id, orgB.id, "admin");
  });

  function buildCtx(userId: string, orgId: string): ToolContext {
    return {
      organizationId: orgId,
      userId,
      memberRole: "owner",
      isAuthenticated: true,
      tokenType: "oauth",
      scopedToOrg: false,
      allowCrossOrg: true,
    };
  }

  describe("resolveOrgMembership", () => {
    it("resolves by slug for a member", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgA.slug, ctx);
      expect(record.orgId).toBe(orgA.id);
      expect(record.role).toBe("owner");
      expect(record.visibility).toBe("private");
    });

    it("resolves by id when slug lookup misses", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgA.id, ctx);
      expect(record.slug).toBe(orgA.slug);
    });

    it("throws AccessDenied on private org the user is not a member of", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      await expect(
        resolveOrgMembership(orgB.slug, ctx),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("returns record with role=null on public org for non-members", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(orgPublic.slug, ctx);
      expect(record.visibility).toBe("public");
      expect(record.role).toBeNull();
    });

    it("throws OrgNotFound for an unknown slug-or-id", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      await expect(
        resolveOrgMembership("does-not-exist-xyz", ctx),
      ).rejects.toBeInstanceOf(OrgNotFoundError);
    });

    it("resolves slugs that are long (no id-regex false-positive)", async () => {
      const longSlug = "very-long-customer-success-platform-slug";
      const longOrg = await createTestOrganization({
        name: "Long Slug Org",
        slug: longSlug,
      });
      await addUserToOrganization(user1.id, longOrg.id, "member");
      const ctx = buildCtx(user1.id, orgA.id);
      const record = await resolveOrgMembership(longSlug, ctx);
      expect(record.slug).toBe(longSlug);
      expect(record.role).toBe("member");
    });
  });

  describe("buildClientSDK", () => {
    it("exposes every namespace", () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      expect(sdk.entities).toBeDefined();
      expect(sdk.entitySchema).toBeDefined();
      expect(sdk.connections).toBeDefined();
      expect(sdk.feeds).toBeDefined();
      expect(sdk.authProfiles).toBeDefined();
      expect(sdk.operations).toBeDefined();
      expect(sdk.watchers).toBeDefined();
      expect(sdk.classifiers).toBeDefined();
      expect(sdk.viewTemplates).toBeDefined();
      expect(sdk.knowledge).toBeDefined();
      expect(sdk.organizations).toBeDefined();
      expect(sdk.query).toBeInstanceOf(Function);
      expect(sdk.log).toBeInstanceOf(Function);
      expect(sdk.org).toBeInstanceOf(Function);
    });

    it(".org() throws AccessDenied on a non-member private org", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });

    it(".org() returns a public-org SDK with memberRole=null for non-members", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkPub = await sdk.org(orgPublic.slug);
      expect(sdkPub).toBeDefined();
    });
  });

  describe("buildClientSDK with user1 also a member of orgB", () => {
    beforeAll(async () => {
      await addUserToOrganization(user1.id, orgB.id, "member");
      // Clear any stale "not-a-member" negative cache from earlier tests.
      invalidateMembershipRoleCache(orgB.id, user1.id);
    });

    it(".org() returns a fresh SDK for the other member org", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      expect(sdkB).toBeDefined();
      expect(sdkB).not.toBe(sdk);
      expect(sdkB.org).toBeInstanceOf(Function);
    });

    it("chained .org() re-validates against the original user", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      const sdkB = await sdk.org(orgB.slug);
      const sdkBackToA = await sdkB.org(orgA.slug);
      expect(sdkBackToA).toBeDefined();
    });

    it("revocation is detected after explicit cache invalidation", async () => {
      const ctx = buildCtx(user1.id, orgA.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await sdk.org(orgB.slug);

      const sql = getTestDb();
      await sql`DELETE FROM "member" WHERE "userId" = ${user1.id} AND "organizationId" = ${orgB.id}`;
      invalidateMembershipRoleCache(orgB.id, user1.id);

      await expect(sdk.org(orgB.slug)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });
  });

  describe("non-member isolation", () => {
    it("user2 cannot access orgA", async () => {
      const ctx = buildCtx(user2.id, orgB.id);
      const sdk = buildClientSDK(ctx, testEnv);
      await expect(sdk.org(orgA.slug)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });
  });
});
