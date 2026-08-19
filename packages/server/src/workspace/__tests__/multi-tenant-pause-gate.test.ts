/**
 * Execution coverage for the wiring that makes the promotions pause real:
 * `resolveAuth` → `setContextAndContinue` → `checkApplyPause`.
 *
 * The sibling suite (src/utils/__tests__/deployment-pause.test.ts) proves the
 * pause DECISION in isolation. That is not enough on its own: the decision is
 * only worth anything if the funnel actually consults it, and the four lines
 * that do so are otherwise covered by nothing but typecheck.
 *
 * This drives the REAL `MultiTenantProvider` with a REAL PAT rather than the
 * src/lobu route harness, which replaces `mcpAuth` with a stub that only sets
 * context vars — a test written there passes with the guard deleted, which is
 * exactly the reassurance we must not buy.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';

const ORG = 'org-pause-wiring';
const USER = 'u-pause-wiring';
const APPLY_ID = 'apl_dddddddd-1111-2222-3333-444444444444';
const ROLLED_BACK = 'apl_eeeeeeee-1111-2222-3333-444444444444';

let token = '';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();

  await sql`
    INSERT INTO organization (id, name, slug) VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Pause', 'pause-wiring@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('m-pause-wiring', ${ORG}, ${USER}, 'owner', now())
    ON CONFLICT (id) DO NOTHING
  `;

  // Both caches are module-level and survive resetTestDatabase, so a prior
  // test's slug→id and org:user→role entries would outlive the rows.
  const { invalidateMembershipRoleCache, invalidateOrgSlugCache } = await import(
    '../multi-tenant.js'
  );
  invalidateOrgSlugCache(ORG);
  invalidateMembershipRoleCache(ORG, USER);

  const { PersonalAccessTokenService } = await import('../../auth/tokens.js');
  token = (await new PersonalAccessTokenService(sql).create(USER, ORG, 'pause-wiring')).token;
});

async function pauseOrg(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO deployment_pause (organization_id, apply_id, rollback_of, paused_by)
    VALUES (${ORG}, ${APPLY_ID}, ${ROLLED_BACK}, ${USER})
    ON CONFLICT (organization_id) DO UPDATE SET rollback_of = EXCLUDED.rollback_of
  `;
}

/**
 * Mount the real provider exactly as the server does and issue one request.
 * `reached` reports whether the downstream handler ran, so a 409 that came
 * from the guard is distinguishable from a handler that merely errored.
 */
async function request(opts: {
  method: string;
  applyId?: string;
  rollbackOf?: string;
}): Promise<{ status: number; body: Record<string, unknown>; reached: boolean }> {
  const { MultiTenantProvider } = await import('../multi-tenant.js');
  const provider = new MultiTenantProvider();

  let reached = false;
  const app = new Hono();
  app.use('/api/:orgSlug/*', (c, next) => provider.resolveAuth(c, next));
  app.all('/api/:orgSlug/probe', (c) => {
    reached = true;
    return c.json({ ok: true });
  });

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.applyId) headers['x-lobu-apply-id'] = opts.applyId;
  if (opts.rollbackOf) headers['x-lobu-rollback-of'] = opts.rollbackOf;

  const res = await app.request(`/api/${ORG}/probe`, { method: opts.method, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, reached };
}

describe('promotions pause is enforced in the auth funnel', () => {
  test('a paused org refuses an apply-run mutation before the handler runs', async () => {
    await pauseOrg();
    const res = await request({ method: 'PATCH', applyId: APPLY_ID });

    expect(res.status).toBe(409);
    expect(res.body.paused).toBe(true);
    // The whole point of gating here: the mutation never executes.
    expect(res.reached).toBe(false);
  });

  test('the same request succeeds when the org is not paused', async () => {
    const res = await request({ method: 'PATCH', applyId: APPLY_ID });

    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });

  test('a paused org still serves reads, so the diff and --dry-run keep working', async () => {
    await pauseOrg();
    const res = await request({ method: 'GET', applyId: APPLY_ID });

    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });

  test('traffic outside an apply run is never gated', async () => {
    await pauseOrg();
    // A UI or one-off API edit carries no apply id and must stay editable.
    const res = await request({ method: 'PATCH' });

    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });

  test('a genuine rollback passes through the pause it is exiting', async () => {
    await pauseOrg();
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO events (organization_id, origin_id, semantic_type, payload_data, metadata)
      VALUES (${ORG}, ${`deployment_${ROLLED_BACK}`}, 'change', '{}'::jsonb,
              ${JSON.stringify({ category: 'deployment' })}::jsonb)
    `;

    const res = await request({ method: 'PATCH', applyId: APPLY_ID, rollbackOf: ROLLED_BACK });

    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });
});
