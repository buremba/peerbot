/**
 * Child-token lifecycle for /api/me/devices/mint-child-token (#2884 follow-up).
 *
 * A minted child PAT used to carry the bare `device_worker:run` scope — the
 * exact scope the mint gate checks — and no expiry, so a child could mint
 * children forever and every link lived until manually revoked. Now:
 *
 *   - newly minted children get a hard expiry (forward-only: legacy children
 *     keep their null expiry until they rotate — a retroactive backfill is an
 *     owner decision this change deliberately does not take)
 *   - a child may re-mint its own bound worker_id on the SAME platform (the old
 *     PAT is revoked in the same transaction) — the refresh path a device has
 *     before its token expires, without re-pairing
 *   - a child may NOT obtain credentials for any other worker_id: the chain
 *     stops at depth 1, so no new grandchild can outlive a revoked parent PAT
 *
 * Unbound first-party device grants (Mac bridge OAuth, `lobu login`
 * device-code) keep pairing new siblings.
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { PersonalAccessTokenService } from '../../auth/tokens';
import { mintDeviceChildToken } from '../../worker-api/device-management';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../setup/test-fixtures';

const TEST_ENV = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
  RATE_LIMIT_ENABLED: 'false',
} as unknown as Env;

async function markPersonalOrg(orgId: string, userId: string): Promise<void> {
  const sql = getTestDb();
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
    WHERE id = ${orgId}
  `;
}

type AuthShape = { scopes: string[]; workerId?: string } | null;

type MintApp = Hono<{
  Bindings: Env;
  Variables: { user: { id: string }; mcpAuthInfo: AuthShape };
}>;

function mintApp(userId: string, auth: AuthShape): MintApp {
  const app: MintApp = new Hono();
  app.post(
    '/api/me/devices/mint-child-token',
    async (c, next) => {
      c.set('user', { id: userId });
      c.set('mcpAuthInfo', auth);
      await next();
    },
    (c) => mintDeviceChildToken(c)
  );
  return app;
}

async function seedUser(email: string): Promise<string> {
  const personalOrg = await createTestOrganization({ name: `Personal ${email}` });
  const user = await createTestUser({ email });
  await markPersonalOrg(personalOrg.id, user.id);
  await addUserToOrganization(user.id, personalOrg.id, 'owner');
  return user.id;
}

async function mint(
  userId: string,
  auth: AuthShape,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await mintApp(userId, auth).request(
    '/api/me/devices/mint-child-token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    TEST_ENV
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function verifyPat(token: unknown): Promise<Exclude<AuthShape, null>> {
  const auth = await new PersonalAccessTokenService(getTestDb()).verify(String(token));
  expect(auth).not.toBeNull();
  return {
    scopes: auth!.scopes,
    ...(auth!.workerId ? { workerId: auth!.workerId } : {}),
  };
}

const PARENT_AUTH: AuthShape = { scopes: ['device_worker:run'] };

describe('device child-token lifecycle', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('mints worker-bound children with a hard expiry', async () => {
    const sql = getTestDb();
    const userId = await seedUser('child-lifecycle-mint@test.example.com');

    const { status, json } = await mint(userId, PARENT_AUTH, {
      platform: 'headless',
      label: 'herdr-life',
    });
    expect(status).toBe(200);

    const rows = (await sql`
      SELECT scope, expires_at FROM personal_access_tokens
      WHERE user_id = ${userId} AND worker_id = ${json.worker_id as string}
        AND revoked_at IS NULL
    `) as unknown as Array<{ scope: string; expires_at: Date | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('device_worker:run');
    expect(rows[0].expires_at).not.toBeNull();
    const days =
      (new Date(rows[0].expires_at as unknown as string).getTime() -
        Date.now()) /
      86_400_000;
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);
    expect(await verifyPat(json.access_token)).toEqual({
      scopes: ['device_worker:run'],
      workerId: json.worker_id,
    });
    // The response tells the caller when the credential it just stored dies.
    expect(typeof json.expires_at).toBe('string');
  });

  it('a child cannot mint a NEW device credential — the chain stops at depth 1', async () => {
    const userId = await seedUser('child-lifecycle-chain@test.example.com');
    const first = await mint(userId, PARENT_AUTH, {
      platform: 'headless',
      label: 'herdr-parent',
    });
    expect(first.status).toBe(200);
    const childAuth = await verifyPat(first.json.access_token);
    expect(childAuth.workerId).toBe(first.json.worker_id);

    // No worker_id (fresh identity) and a different worker_id both refuse.
    const fresh = await mint(userId, childAuth, { platform: 'headless' });
    expect(fresh.status).toBe(403);
    expect(String(fresh.json.error_description)).toMatch(/own worker_id/);

    const sibling = await mint(userId, childAuth, {
      platform: 'chrome-extension',
      worker_id: 'some-other-worker',
    });
    expect(sibling.status).toBe(403);

    // Its OWN worker_id under a different platform is the same escalation with
    // extra steps: reuse requires a platform match, so without the second arm
    // of the gate this falls through to a fresh uuid — a brand-new device
    // credential minted by a child.
    const swapped = await mint(userId, childAuth, {
      platform: 'chrome-extension',
      worker_id: first.json.worker_id as string,
    });
    expect(swapped.status).toBe(403);
    expect(swapped.json.access_token).toBeUndefined();
  });

  it('a child CAN rotate its own worker_id, revoking the previous PAT', async () => {
    const sql = getTestDb();
    const userId = await seedUser('child-lifecycle-rotate@test.example.com');
    const first = await mint(userId, PARENT_AUTH, {
      platform: 'headless',
      label: 'herdr-rotate',
    });
    expect(first.status).toBe(200);
    const workerId = first.json.worker_id as string;

    const rotated = await mint(userId, await verifyPat(first.json.access_token), {
      platform: 'headless',
      worker_id: workerId,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.worker_id).toBe(workerId);
    expect(rotated.json.access_token).not.toBe(first.json.access_token);

    const live = (await sql`
      SELECT token_prefix FROM personal_access_tokens
      WHERE user_id = ${userId} AND worker_id = ${workerId} AND revoked_at IS NULL
    `) as unknown as Array<{ token_prefix: string }>;
    expect(live).toHaveLength(1);
    expect(String(rotated.json.access_token)).toContain(live[0].token_prefix);
  });

  it('a LEGACY child (bare scope, worker-bound) is still held to the depth-1 gate', async () => {
    // Children minted before this change carry a null expires_at and the bare
    // `device_worker:run` scope. Their worker binding must still classify
    // them as children, or every already-issued child keeps unlimited mint
    // power until it happens to rotate.
    const sql = getTestDb();
    const userId = await seedUser('child-lifecycle-legacy@test.example.com');
    const first = await mint(userId, PARENT_AUTH, {
      platform: 'headless',
      label: 'herdr-legacy',
    });
    expect(first.status).toBe(200);
    const workerId = first.json.worker_id as string;
    await sql`
      UPDATE personal_access_tokens
      SET expires_at = NULL
      WHERE user_id = ${userId} AND worker_id = ${workerId} AND revoked_at IS NULL
    `;
    const legacyInfo = await new PersonalAccessTokenService(sql).verify(
      String(first.json.access_token)
    );
    expect(legacyInfo).not.toBeNull();
    const legacyChildAuth: Exclude<AuthShape, null> = {
      scopes: legacyInfo!.scopes,
      ...(legacyInfo!.workerId ? { workerId: legacyInfo!.workerId } : {}),
    };
    expect(legacyChildAuth).toEqual({ scopes: ['device_worker:run'], workerId });

    const fresh = await mint(userId, legacyChildAuth, { platform: 'headless' });
    expect(fresh.status).toBe(403);
    expect(String(fresh.json.error_description)).toMatch(/own worker_id/);

    const sibling = await mint(userId, legacyChildAuth, {
      platform: 'chrome-extension',
      worker_id: 'some-other-worker',
    });
    expect(sibling.status).toBe(403);

    // Rotation of its own identity keeps working and upgrades the row to an
    // expiring token through the normal re-register.
    const rotated = await mint(userId, legacyChildAuth, {
      platform: 'headless',
      worker_id: workerId,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.worker_id).toBe(workerId);
    const upgraded = await verifyPat(rotated.json.access_token);
    expect(upgraded).toEqual({
      scopes: ['device_worker:run'],
      workerId,
    });
    const expiry = (await sql`
      SELECT expires_at FROM personal_access_tokens
      WHERE user_id = ${userId} AND worker_id = ${workerId} AND revoked_at IS NULL
    `) as unknown as Array<{ expires_at: Date | null }>;
    expect(expiry).toHaveLength(1);
    expect(expiry[0].expires_at).not.toBeNull();
  });
});
