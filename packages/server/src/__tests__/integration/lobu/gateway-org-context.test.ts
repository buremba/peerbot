/**
 * Integration tests for the embedded Lobu Agent API org-context middleware
 * (`createLobuOrgContextMiddleware` in `src/lobu/gateway.ts`).
 *
 * Covers the `x-lobu-org` per-request override that backs `lobu chat --org`:
 *   - header present + member       → org context is the header's org (not the
 *     PAT-bound org), so a multi-org user can target a scratch org for one run
 *   - header present + non-member   → 403 (cannot escalate cross-tenant)
 *   - header present + unknown slug → 404
 *   - header absent                 → falls back to the PAT-bound org
 *     (pre-flag behavior preserved)
 *
 * The middleware reads `c.get('user')`, which `createLobuAuthBridge` populates,
 * so the test app mounts the bridge first (production order) and a handler that
 * mirrors the resolved `organizationId` back as JSON.
 */

import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import {
  createLobuAuthBridge,
  createLobuOrgContextMiddleware,
} from "../../../lobu/gateway";
import { clearMultiTenantCachesForTests } from "../../../workspace/multi-tenant";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from "../../setup/test-fixtures";

const testEnv: Env = {
  ENVIRONMENT: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: "test-jwt-secret-for-testing-only",
  BETTER_AUTH_SECRET: "test-auth-secret-for-testing-only",
  MAX_CONSECUTIVE_FAILURES: "3",
  RATE_LIMIT_ENABLED: "false",
};

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", createLobuAuthBridge());
  app.use("*", createLobuOrgContextMiddleware());
  app.get("/test", (c: any) => {
    const user = c.get("user");
    const organizationId = c.get("organizationId") ?? null;
    if (!user) return c.json({ ok: false, reason: "no-user" }, 401);
    return c.json({ ok: true, userId: user.id, organizationId });
  });
  return app;
}

async function fetchTest(
  app: Hono<{ Bindings: Env }>,
  options: { token?: string; org?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.org !== undefined) headers["x-lobu-org"] = options.org;
  const res = await app.fetch(
    new Request("http://test.local/test", { headers }),
    testEnv,
  );
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe("Lobu embedded Agent API org-context middleware (x-lobu-org)", () => {
  let patOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let scratchOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let foreignOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let app: Hono<{ Bindings: Env }>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    patOrg = await createTestOrganization({ name: "Chat Org PAT" });
    scratchOrg = await createTestOrganization({ name: "Chat Org Scratch" });
    foreignOrg = await createTestOrganization({ name: "Chat Org Foreign" });
    user = await createTestUser({});
    // The user belongs to BOTH the PAT org and the scratch org, but NOT the
    // foreign org — the override must respect that membership boundary.
    await addUserToOrganization(user.id, patOrg.id);
    await addUserToOrganization(user.id, scratchOrg.id);
  });

  beforeEach(() => {
    clearMultiTenantCachesForTests();
    app = buildApp();
  });

  it("no x-lobu-org header → resolves to the PAT-bound org (pre-flag behavior)", async () => {
    const { token } = await createTestPAT(user.id, patOrg.id);
    const { status, body } = await fetchTest(app, { token });
    expect(status).toBe(200);
    expect(body.organizationId).toBe(patOrg.id);
  });

  it("x-lobu-org for a member org overrides the PAT-bound org", async () => {
    const { token } = await createTestPAT(user.id, patOrg.id);
    const { status, body } = await fetchTest(app, {
      token,
      org: scratchOrg.slug,
    });
    expect(status).toBe(200);
    // The override wins: context is the scratch org, not the PAT's org.
    expect(body.organizationId).toBe(scratchOrg.id);
    expect(body.organizationId).not.toBe(patOrg.id);
  });

  it("x-lobu-org for an org the user is NOT a member of → 403", async () => {
    const { token } = await createTestPAT(user.id, patOrg.id);
    const { status, body } = await fetchTest(app, {
      token,
      org: foreignOrg.slug,
    });
    expect(status).toBe(403);
    expect(String(body.error)).toMatch(/Not a member/);
  });

  it("x-lobu-org for an unknown slug → 404", async () => {
    const { token } = await createTestPAT(user.id, patOrg.id);
    const { status, body } = await fetchTest(app, {
      token,
      org: "no-such-org-slug-xyz",
    });
    expect(status).toBe(404);
    expect(String(body.error)).toMatch(/Unknown organization/);
  });

  it("blank x-lobu-org header is ignored → falls back to PAT-bound org", async () => {
    const { token } = await createTestPAT(user.id, patOrg.id);
    const { status, body } = await fetchTest(app, { token, org: "   " });
    expect(status).toBe(200);
    expect(body.organizationId).toBe(patOrg.id);
  });
});
