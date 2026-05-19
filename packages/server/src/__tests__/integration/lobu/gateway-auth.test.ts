/**
 * Integration tests for the embedded Lobu Agent API auth bridge
 * (`createLobuAuthBridge` in `src/lobu/gateway.ts`).
 *
 * These cover the codex round-2 findings on PR #940:
 *
 *   - #1 (HIGH) tenant-membership check after PAT verification
 *   - #2 (MED)  PAT validation runs BEFORE cookie hydration
 *   - #3 (MED)  PATs with null `organization_id` are rejected on this path
 *   - #4 (LOW)  no test coverage for the bridge before this file
 *
 * The bridge is mounted on a minimal Hono app rather than booting the full
 * embedded gateway — the `(user, session, organizationId)` context the
 * bridge writes is the contract downstream `authProvider` reads, so the
 * test handler simply mirrors that state back as JSON and asserts on it.
 */

import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createLobuAuthBridge } from '../../../lobu/gateway';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
} from '../../setup/test-fixtures';

const testEnv: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  MAX_CONSECUTIVE_FAILURES: '3',
  RATE_LIMIT_ENABLED: 'false',
};

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', createLobuAuthBridge());
  // Mirror the (user, session, organizationId) the bridge populated. Tests
  // hit this single handler and inspect either the JSON body (success
  // shape) or the bridge's own short-circuit response (401/403).
  app.get('/test', (c: any) => {
    const user = c.get('user');
    const session = c.get('session');
    const organizationId = c.get('organizationId') ?? null;
    if (!user) {
      return c.json({ ok: false, reason: 'no-user' }, 401);
    }
    return c.json({
      ok: true,
      userId: user.id,
      sessionId: session?.id ?? null,
      organizationId,
    });
  });
  return app;
}

async function fetchTest(
  app: Hono<{ Bindings: Env }>,
  options: { token?: string; cookie?: string; authHeader?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.authHeader !== undefined) {
    headers.Authorization = options.authHeader;
  } else if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  const res = await app.fetch(new Request('http://test.local/test', { headers }), testEnv);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

describe('Lobu embedded Agent API auth bridge', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let otherOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let app: Hono<{ Bindings: Env }>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    org = await createTestOrganization({ name: 'PAT Bridge Org' });
    otherOrg = await createTestOrganization({ name: 'PAT Bridge Other Org' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id);
    // user is intentionally NOT a member of otherOrg — used by the
    // membership-removed test (codex #1).
  });

  beforeEach(() => {
    app = buildApp();
  });

  describe('PAT happy path', () => {
    it('accepts a valid PAT and pins the bound organization', async () => {
      const { token } = await createTestPAT(user.id, org.id);

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.userId).toBe(user.id);
      expect(body.organizationId).toBe(org.id);
      expect(body.sessionId).toMatch(/^pat:/);
    });
  });

  describe('PAT rejection cases', () => {
    it('rejects a PAT with the owl_pat_ prefix but an unknown hash', async () => {
      const { status, body } = await fetchTest(app, {
        token: 'owl_pat_unknown_hash_that_will_never_match',
      });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
    });

    it('rejects an expired PAT', async () => {
      const { token } = await createTestPAT(user.id, org.id);
      const sql = getTestDb();
      await sql`
        UPDATE personal_access_tokens
        SET expires_at = NOW() - INTERVAL '1 hour'
        WHERE user_id = ${user.id} AND organization_id = ${org.id}
      `;

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
    });

    it('rejects a revoked PAT', async () => {
      const { token } = await createTestPAT(user.id, org.id);
      const sql = getTestDb();
      await sql`
        UPDATE personal_access_tokens
        SET revoked_at = NOW()
        WHERE user_id = ${user.id} AND organization_id = ${org.id}
      `;

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
    });

    it('treats a bearer token without the owl_pat_ prefix as not-a-PAT (falls through to Better Auth)', async () => {
      // Non-PAT bearer token + no cookie → cookie hydration runs and fails →
      // downstream handler sees no user and returns 401. Importantly this
      // path does NOT 401 the request as "invalid PAT" — that contract is
      // reserved for tokens that actually carry the owl_pat_ prefix.
      const { status, body } = await fetchTest(app, { token: 'definitely_not_a_pat' });

      expect(status).toBe(401);
      // Bridge's own 401 has body.error; this 401 comes from the test
      // handler (no Better Auth session resolved), so body.reason === 'no-user'.
      expect(body.reason).toBe('no-user');
    });

    it('rejects an empty Authorization header value', async () => {
      // Empty Authorization is non-PAT → Better Auth runs → no user → 401.
      const { status, body } = await fetchTest(app, { authHeader: '' });

      expect(status).toBe(401);
      expect(body.reason).toBe('no-user');
    });

    it('rejects a malformed Authorization header (no Bearer scheme)', async () => {
      // No Bearer prefix → non-PAT path → Better Auth → no user → 401.
      const { status, body } = await fetchTest(app, {
        authHeader: 'Basic dXNlcjpwYXNz',
      });

      expect(status).toBe(401);
      expect(body.reason).toBe('no-user');
    });
  });

  describe('Cookie precedence (codex #2)', () => {
    it('rejects an invalid PAT even when a valid session cookie is present', async () => {
      // The pre-fix bridge hydrated cookies first and only ran PAT
      // validation behind `if (!c.get('user'))` — a valid cookie therefore
      // masked any invalid PAT in the same request. After the fix, a
      // request with `Authorization: Bearer owl_pat_*` is authoritative on
      // the PAT path: invalid PAT → 401 regardless of cookie.
      const session = await createTestSession(user.id);

      const { status, body } = await fetchTest(app, {
        token: 'owl_pat_obviously_invalid_hash',
        cookie: session.cookieHeader,
      });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
    });
  });

  describe('Tenant membership (codex #1)', () => {
    it('rejects a valid PAT when the user is no longer a member of the bound org', async () => {
      // Mint a PAT bound to org A, then delete the (user, org A) member row
      // — the PAT itself is still valid, but the user has lost membership.
      // Bridge must reject with 403 `forbidden` (mirrors multi-tenant.ts:425).
      const tempOrg = await createTestOrganization({ name: 'Membership Drop Org' });
      await addUserToOrganization(user.id, tempOrg.id);
      const { token } = await createTestPAT(user.id, tempOrg.id);

      const sql = getTestDb();
      await sql`
        DELETE FROM "member"
        WHERE "userId" = ${user.id} AND "organizationId" = ${tempOrg.id}
      `;

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(403);
      expect(body.error).toBe('forbidden');
      expect(body.error_description).toContain('not a member');
    });

    it('rejects a PAT whose user has never been a member of the bound org', async () => {
      // Defensive: even a PAT minted directly for an org the user never
      // joined (shouldn't happen via the supported mint path, but the row
      // can land via direct SQL or a race) must fail closed.
      const sql = getTestDb();
      // Use createTestPAT but against otherOrg, where user has no member row.
      const { token } = await createTestPAT(user.id, otherOrg.id);
      // Sanity: confirm the member row is absent.
      const memberRows = (await sql`
        SELECT 1 FROM "member"
        WHERE "userId" = ${user.id} AND "organizationId" = ${otherOrg.id}
      `) as unknown as Array<unknown>;
      expect(memberRows.length).toBe(0);

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(403);
      expect(body.error).toBe('forbidden');
    });
  });

  describe('Null org PAT (codex #3)', () => {
    it('rejects a valid PAT whose organization_id is NULL', async () => {
      // PATs with null org id (e.g. minted against a since-deleted org —
      // `ON DELETE SET NULL`) must NOT silently re-resolve to the user's
      // earliest membership on the embedded Agent API path.
      const sql = getTestDb();
      const { token } = await createTestPAT(user.id, org.id);
      await sql`
        UPDATE personal_access_tokens
        SET organization_id = NULL
        WHERE user_id = ${user.id}
        AND token_prefix = ${token.substring(0, 12)}
      `;

      const { status, body } = await fetchTest(app, { token });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
      expect(body.error_description).toContain('not scoped to an organization');
    });
  });
});
