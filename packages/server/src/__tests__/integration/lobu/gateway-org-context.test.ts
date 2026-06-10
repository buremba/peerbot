/**
 * Integration tests for the embedded Lobu Agent API org-context middleware
 * (`createLobuOrgContextMiddleware` in `src/lobu/gateway.ts`).
 *
 * Covers the `x-lobu-org` per-request override that backs `lobu chat --org`:
 *
 * Session auth (Better Auth login — the normal `lobu login` CLI path):
 *   - header present + member       → org context is the header's org, so a
 *     multi-org user can target a scratch org for one run
 *   - header present + non-member   → 403 (cannot escalate cross-tenant)
 *   - header present + unknown slug → 404
 *
 * PAT auth (owl_pat_* bearer): the token stays pinned to the org it was minted
 * for — same rule as the MCP's query_sql, which rejects org overrides under
 * PAT auth:
 *   - header naming the pinned org  → 200 no-op (the CLI auto-sends the
 *     context's activeOrg, so the equal case must not error)
 *   - header naming ANY other org   → 403, even when the user is a member
 *   - header absent                 → falls back to the PAT-bound org
 *
 * The real PAT path goes through `createLobuAuthBridge` (production order).
 * The session-auth path stubs the upstream auth middleware with a session whose
 * id is not `pat:`-prefixed — the middleware's contract is `c.get('user')` /
 * `c.get('session')` / `c.get('organizationId')`, which is exactly what Better
 * Auth populates.
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

function buildPatApp(): Hono<{ Bindings: Env }> {
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

/** Simulates the Better Auth session path: user + non-PAT session, no org pin. */
function buildSessionApp(userId: string): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c: any, next: any) => {
    c.set("user", { id: userId });
    c.set("session", { id: "sess_better_auth_token", userId });
    await next();
  });
  app.use("*", createLobuOrgContextMiddleware());
  app.get("/test", (c: any) => {
    return c.json({ ok: true, organizationId: c.get("organizationId") ?? null });
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
  let patApp: Hono<{ Bindings: Env }>;

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
    patApp = buildPatApp();
  });

  describe("session auth (Better Auth login)", () => {
    it("x-lobu-org for a member org wins", async () => {
      const app = buildSessionApp(user.id);
      const { status, body } = await fetchTest(app, { org: scratchOrg.slug });
      expect(status).toBe(200);
      expect(body.organizationId).toBe(scratchOrg.id);
    });

    it("x-lobu-org for an org the user is NOT a member of → 403", async () => {
      const app = buildSessionApp(user.id);
      const { status, body } = await fetchTest(app, { org: foreignOrg.slug });
      expect(status).toBe(403);
      expect(String(body.error)).toMatch(/Not a member/);
    });

    it("x-lobu-org for an unknown slug → 404", async () => {
      const app = buildSessionApp(user.id);
      const { status, body } = await fetchTest(app, {
        org: "no-such-org-slug-xyz",
      });
      expect(status).toBe(404);
      expect(String(body.error)).toMatch(/Unknown organization/);
    });
  });

  describe("PAT auth (org-pinned)", () => {
    it("no x-lobu-org header → resolves to the PAT-bound org (pre-flag behavior)", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, { token });
      expect(status).toBe(200);
      expect(body.organizationId).toBe(patOrg.id);
    });

    it("x-lobu-org naming the pinned org is a no-op (CLI auto-sends activeOrg)", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, {
        token,
        org: patOrg.slug,
      });
      expect(status).toBe(200);
      expect(body.organizationId).toBe(patOrg.id);
    });

    it("x-lobu-org for a DIFFERENT member org → 403 (PAT stays pinned, like MCP query_sql)", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, {
        token,
        org: scratchOrg.slug,
      });
      expect(status).toBe(403);
      expect(String(body.error)).toMatch(/PAT auth/);
    });

    it("x-lobu-org for a non-member org → 403 (PAT pin rejects before membership)", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, {
        token,
        org: foreignOrg.slug,
      });
      expect(status).toBe(403);
      expect(String(body.error)).toMatch(/PAT auth/);
    });

    it("x-lobu-org for an unknown slug → 404", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, {
        token,
        org: "no-such-org-slug-xyz",
      });
      expect(status).toBe(404);
      expect(String(body.error)).toMatch(/Unknown organization/);
    });

    it("blank x-lobu-org header is ignored → falls back to PAT-bound org", async () => {
      const { token } = await createTestPAT(user.id, patOrg.id);
      const { status, body } = await fetchTest(patApp, { token, org: "   " });
      expect(status).toBe(200);
      expect(body.organizationId).toBe(patOrg.id);
    });
  });
});
