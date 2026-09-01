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
import { serializeSigned } from 'hono/utils/cookie';
import { clearAuthCacheForTests } from '../../auth/index.js';
import { sessionCookieName } from '../../auth/session-cookie-scope.js';
import type { Env } from '../../index.js';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { getConfiguredPublicOrigin } from '../../utils/public-origin.js';

const ORG = 'org-pause-wiring';
const OTHER_ORG = 'org-pause-wiring-other';
const USER = 'u-pause-wiring';
const APPLY_ID = 'apl_dddddddd-1111-2222-3333-444444444444';
const ROLLED_BACK = 'apl_eeeeeeee-1111-2222-3333-444444444444';

let token = '';
let oauthToken = '';
let sessionCookie = '';

function requestOrigin(): string {
  return getConfiguredPublicOrigin() ?? 'http://test.local';
}

const testEnv: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

beforeAll(async () => {
  await ensureDbForGatewayTests();
  testEnv.DATABASE_URL = process.env.DATABASE_URL;
}, 60_000);

beforeEach(async () => {
  await resetTestDatabase();
  // The auth instance is cached by organization across requests. Keep this
  // harness independent of any auth suite that ran earlier in the worker.
  clearAuthCacheForTests();
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();

  await sql`
    INSERT INTO organization (id, name, slug) VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization (id, name, slug) VALUES (${OTHER_ORG}, ${OTHER_ORG}, ${OTHER_ORG})
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
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('m-pause-wiring-other', ${OTHER_ORG}, ${USER}, 'owner', now())
    ON CONFLICT (id) DO NOTHING
  `;

  const { PersonalAccessTokenService } = await import('../../auth/tokens.js');
  token = (await new PersonalAccessTokenService(sql).create(USER, ORG, 'pause-wiring')).token;

  const { generateAccessToken, hashToken } = await import('../../auth/oauth/utils.js');
  oauthToken = generateAccessToken();
  await sql`
    INSERT INTO oauth_clients (id, redirect_uris, client_name)
    VALUES ('pause-wiring-client', ARRAY['http://localhost/callback'], 'Pause Wiring')
  `;
  await sql`
    INSERT INTO oauth_tokens (
      id, token_type, token_hash, client_id, user_id, organization_id,
      granted_organization_ids, authorization_grant_type, scope, expires_at
    ) VALUES (
      'pause-wiring-oauth-token', 'access', ${hashToken(oauthToken)},
      'pause-wiring-client', ${USER}, ${ORG}, ARRAY[${ORG}, ${OTHER_ORG}]::text[],
      'authorization_code', 'mcp:read mcp:write mcp:admin',
      now() + interval '1 hour'
    )
  `;

  const sessionToken = 'pause-wiring-session-token';
  await sql`
    INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
    VALUES ('pause-wiring-session', ${sessionToken}, ${USER}, now() + interval '1 hour', now(), now())
  `;
  const requestIsHttps = new URL(requestOrigin()).protocol === 'https:';
  sessionCookie = (
    await serializeSigned(
      sessionCookieName(requestIsHttps),
      sessionToken,
      testEnv.BETTER_AUTH_SECRET as string,
      {
        httpOnly: true,
        path: '/',
        sameSite: 'Lax',
        secure: requestIsHttps,
      }
    )
  ).split(';', 1)[0] as string;
});

async function pauseOrg(organizationId = ORG): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO deployment_pause (organization_id, apply_id, rollback_of, paused_by)
    VALUES (${organizationId}, ${APPLY_ID}, ${ROLLED_BACK}, ${USER})
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
  orgSlug?: string;
  auth?: 'pat' | 'oauth' | 'session' | 'settings-cookie' | 'invalid-pat-with-session';
  provider?: InstanceType<typeof import('../multi-tenant.js').MultiTenantProvider>;
}): Promise<{ status: number; body: Record<string, unknown>; reached: boolean }> {
  const { MultiTenantProvider } = await import('../multi-tenant.js');
  const provider = opts.provider ?? new MultiTenantProvider();

  let reached = false;
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/:orgSlug/*', (c, next) => provider.resolveAuth(c, next));
  app.all('/api/:orgSlug/probe', (c) => {
    reached = true;
    return c.json({
      ok: true,
      organizationId: c.get('organizationId'),
      memberRole: c.get('memberRole'),
    });
  });

  const headers: Record<string, string> = {};
  switch (opts.auth ?? 'pat') {
    case 'pat':
      headers.authorization = `Bearer ${token}`;
      break;
    case 'oauth':
      headers.authorization = `Bearer ${oauthToken}`;
      break;
    case 'session':
      headers.cookie = sessionCookie;
      break;
    case 'settings-cookie':
      headers.cookie = 'lobu_settings_session=opaque-gateway-session';
      break;
    case 'invalid-pat-with-session':
      headers.authorization = 'Bearer owl_pat_invalid';
      headers.cookie = sessionCookie;
      break;
  }
  if (opts.applyId) headers['x-lobu-apply-id'] = opts.applyId;
  if (opts.rollbackOf) headers['x-lobu-rollback-of'] = opts.rollbackOf;

  const orgSlug = opts.orgSlug ?? ORG;
  const res = await app.fetch(
    new Request(`${requestOrigin()}/api/${orgSlug}/probe`, { method: opts.method, headers }),
    testEnv
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body, reached };
}

describe('promotions pause is enforced in the auth funnel', () => {
  test('org slug lookups read renamed workspace state immediately', async () => {
    const { getDb } = await import('../../db/client.js');
    const { MultiTenantProvider } = await import('../multi-tenant.js');
    const sql = getDb();
    const provider = new MultiTenantProvider();

    expect(await provider.getOrgSlug(ORG)).toBe(ORG);
    expect(await provider.getOrgSlugs([ORG, OTHER_ORG])).toEqual(
      new Map([
        [ORG, ORG],
        [OTHER_ORG, OTHER_ORG],
      ])
    );

    const renamed = `${ORG}-renamed`;
    await sql`UPDATE organization SET slug = ${renamed} WHERE id = ${ORG}`;
    expect(await provider.getOrgSlug(ORG)).toBe(renamed);
    expect(await provider.getOrgSlugs([ORG, OTHER_ORG])).toEqual(
      new Map([
        [ORG, renamed],
        [OTHER_ORG, OTHER_ORG],
      ])
    );
  });

  test('session membership revocation takes effect on the next request', async () => {
    expect(await request({ method: 'GET', auth: 'session' })).toMatchObject({
      status: 200,
      reached: true,
    });

    const { getDb } = await import('../../db/client.js');
    await getDb()`
      DELETE FROM "member"
      WHERE "organizationId" = ${ORG} AND "userId" = ${USER}
    `;

    expect(await request({ method: 'GET', auth: 'session' })).toMatchObject({
      status: 403,
      reached: false,
    });
  });

  test('a demotion is visible on the next request from a sibling provider instance', async () => {
    const firstReplica = new (await import('../multi-tenant.js')).MultiTenantProvider();
    const secondReplica = new (await import('../multi-tenant.js')).MultiTenantProvider();
    expect(await request({ method: 'GET', auth: 'session', provider: firstReplica })).toMatchObject({
      status: 200,
      body: { memberRole: 'owner' },
    });

    const { getDb } = await import('../../db/client.js');
    await getDb()`
      UPDATE "member" SET role = 'member'
      WHERE "organizationId" = ${ORG} AND "userId" = ${USER}
    `;

    expect(await request({ method: 'GET', auth: 'session', provider: secondReplica })).toMatchObject({
      status: 200,
      body: { memberRole: 'member' },
    });
  });

  test('owner resolution follows rename and owner removal without invalidation', async () => {
    const { getDb } = await import('../../db/client.js');
    const { MultiTenantProvider, getOrgBySlug } = await import('../multi-tenant.js');
    const sql = getDb();
    const firstReplica = new MultiTenantProvider();
    const secondReplica = new MultiTenantProvider();
    const oldOwner = await firstReplica.resolveOwner(ORG, 'organization');
    expect(oldOwner?.id).toBe(ORG);
    // PRIME the old slug on BOTH the authorization lookup and this instance
    // before renaming. Without a read taken while the old value is still true,
    // a reintroduced cache would simply miss after the rename and the
    // assertions below would pass without testing anything.
    expect(await getOrgBySlug(ORG)).toMatchObject({ id: ORG });

    const renamed = `${ORG}-owner-renamed`;
    await sql`UPDATE organization SET slug = ${renamed} WHERE id = ${ORG}`;
    // The point of this suite: a second provider instance sees the rename on its
    // very next call, with nothing invalidated anywhere.
    expect((await secondReplica.resolveOwner(renamed, 'organization'))?.id).toBe(ORG);

    // The AUTHORIZATION lookup is the one that must stop answering for the old
    // slug, and it does — it reads `organization` directly.
    expect(await getOrgBySlug(renamed)).toMatchObject({ id: ORG });
    expect(await getOrgBySlug(ORG)).toBeNull();

    // `resolveOwner` deliberately keeps answering: it reads `namespace`, which a
    // rename does not touch, and the very first resolveOwner above self-healed a
    // namespace row for the old slug. That is a DB fact, not replica staleness,
    // so no cache change could alter it and this suite must not pretend
    // otherwise. (Worth its own fix: a slug freed by a rename still resolves to
    // the previous org, and `ON CONFLICT (slug) DO NOTHING` means whoever claims
    // that slug next inherits the stale mapping.)
    expect((await secondReplica.resolveOwner(ORG, 'organization'))?.id).toBe(ORG);

    await sql`DELETE FROM "member" WHERE "organizationId" = ${ORG} AND role = 'owner'`;
    expect((await secondReplica.resolveOwner(renamed, 'organization'))?.id).toBe(ORG);
  });

  test('session revocation takes effect on the next request', async () => {
    expect(await request({ method: 'GET', auth: 'session' })).toMatchObject({
      status: 200,
      reached: true,
    });

    const { getDb } = await import('../../db/client.js');
    await getDb()`DELETE FROM "session" WHERE id = 'pause-wiring-session'`;

    expect(await request({ method: 'GET', auth: 'session' })).toMatchObject({
      status: 401,
      reached: false,
    });
  });

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
      VALUES (${ORG}, ${`deployment_${ROLLED_BACK}`}, 'change',
              ${sql.json({ manifest: { state: {} } })},
              ${sql.json({
                category: 'deployment',
                apply_id: ROLLED_BACK,
                status: 'succeeded',
              })})
    `;

    const res = await request({ method: 'PATCH', applyId: APPLY_ID, rollbackOf: ROLLED_BACK });

    expect(res.status).toBe(200);
    expect(res.reached).toBe(true);
  });

  test('OAuth resolves an explicitly granted member org before consulting its pause', async () => {
    await pauseOrg(OTHER_ORG);
    const res = await request({
      method: 'PATCH',
      applyId: APPLY_ID,
      orgSlug: OTHER_ORG,
      auth: 'oauth',
    });

    expect(res.status).toBe(409);
    expect(res.reached).toBe(false);
  });

  test('a PAT cannot cross into another org even when its owner is a member', async () => {
    await pauseOrg(OTHER_ORG);
    const res = await request({
      method: 'PATCH',
      applyId: APPLY_ID,
      orgSlug: OTHER_ORG,
      auth: 'pat',
    });

    expect(res.status).toBe(403);
    expect(res.reached).toBe(false);
  });

  test('a Better Auth session resolves the URL org and is gated', async () => {
    await pauseOrg();
    const res = await request({ method: 'PATCH', applyId: APPLY_ID, auth: 'session' });

    expect(res.status).toBe(409);
    expect(res.reached).toBe(false);
  });

  test('an invalid PAT cannot fall back to a valid session cookie', async () => {
    await pauseOrg();
    const res = await request({
      method: 'PATCH',
      applyId: APPLY_ID,
      auth: 'invalid-pat-with-session',
    });

    expect(res.status).toBe(401);
    expect(res.reached).toBe(false);
  });

  test('the gateway settings cookie is not an org-authentication credential', async () => {
    await pauseOrg();
    const res = await request({
      method: 'PATCH',
      applyId: APPLY_ID,
      auth: 'settings-cookie',
    });

    expect(res.status).toBe(401);
    expect(res.reached).toBe(false);
  });
});
