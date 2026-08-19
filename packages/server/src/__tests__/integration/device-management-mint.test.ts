/**
 * POST /api/me/devices/mint-child-token must let a headless device register
 * itself (platform: 'headless') from a device_worker:run bearer, and bind the
 * device + child PAT to the user's personal org - the same contract as the
 * chrome-extension Mac-bridge path, now open to server/VM devices (herdr).
 */

import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
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
  // Match personal-org-provisioning.ts: the marker lives in org metadata as
  // plain JSON text (the read path casts with (metadata::jsonb)->>).
  await sql`
    UPDATE "organization"
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
    WHERE id = ${orgId}
  `;
}

function mintApp(userId: string): Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: { scopes: string[] } | null } }> {
  const app = new Hono<{ Bindings: Env; Variables: { user: { id: string }; mcpAuthInfo: { scopes: string[] } | null } }>();
  app.post(
    '/api/me/devices/mint-child-token',
    async (c, next) => {
      // Device-scoped bearer: device_worker:run scope, NO MCP resource audience.
      c.set('user', { id: userId });
      c.set('mcpAuthInfo', { scopes: ['device_worker:run'] });
      await next();
    },
    (c) => mintDeviceChildToken(c)
  );
  return app;
}

describe('headless device mint (mint-child-token)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('mints a headless device bound to the personal org with an owl_pat_ child token', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal' });
    const user = await createTestUser({ email: 'headless-mint@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', label: 'herdr-test' }),
      },
      TEST_ENV
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      worker_id: string;
      access_token: string;
      platform: string;
      label: string;
    };
    expect(body.platform).toBe('headless');
    expect(body.label).toBe('herdr-test');
    expect(body.access_token.startsWith('owl_pat_')).toBe(true);

    // The persisted device row is platform- and personal-org-bound.
    const rows = (await sql`
      SELECT platform, label, organization_id FROM device_workers
      WHERE user_id = ${user.id} AND worker_id = ${body.worker_id}
    `) as unknown as Array<{ platform: string; label: string; organization_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe('headless');
    expect(rows[0].label).toBe('herdr-test');
    expect(rows[0].organization_id).toBe(personalOrg.id);
  });

  it('reuses a headless worker_id on re-mint and revokes the previous child PAT', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Reuse' });
    const user = await createTestUser({ email: 'headless-mint-reuse@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);

    const first = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', label: 'herdr-reuse' }),
      },
      TEST_ENV
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { worker_id: string; access_token: string };

    // Re-register with the stored worker_id (what a headless daemon does on
    // restart): identity must stay stable and the previous PAT must be revoked.
    const second = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', worker_id: firstBody.worker_id }),
      },
      TEST_ENV
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { worker_id: string; access_token: string };
    expect(secondBody.worker_id).toBe(firstBody.worker_id);
    expect(secondBody.access_token).not.toBe(firstBody.access_token);

    const deviceRows = (await sql`
      SELECT worker_id, platform FROM device_workers WHERE user_id = ${user.id}
    `) as unknown as Array<{ worker_id: string; platform: string }>;
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0].worker_id).toBe(firstBody.worker_id);
    expect(deviceRows[0].platform).toBe('headless');

    const pats = (await sql`
      SELECT revoked_at FROM personal_access_tokens
      WHERE user_id = ${user.id} AND worker_id = ${firstBody.worker_id}
      ORDER BY id ASC
    `) as unknown as Array<{ revoked_at: Date | null }>;
    expect(pats).toHaveLength(2);
    expect(pats[0].revoked_at).not.toBeNull();
    expect(pats[1].revoked_at).toBeNull();
  });

  it('does not reuse a chrome-extension worker_id when re-minting as headless', async () => {
    const sql = getTestDb();
    const personalOrg = await createTestOrganization({ name: 'Personal Cross' });
    const user = await createTestUser({ email: 'headless-mint-cross@test.example.com' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');
    const app = mintApp(user.id);

    const chrome = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'chrome-extension', label: 'chrome' }),
      },
      TEST_ENV
    );
    expect(chrome.status).toBe(200);
    const chromeBody = (await chrome.json()) as { worker_id: string };

    const headless = await app.request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'headless', worker_id: chromeBody.worker_id }),
      },
      TEST_ENV
    );
    expect(headless.status).toBe(200);
    const headlessBody = (await headless.json()) as { worker_id: string };
    expect(headlessBody.worker_id).not.toBe(chromeBody.worker_id);

    const rows = (await sql`
      SELECT worker_id, platform FROM device_workers WHERE user_id = ${user.id} ORDER BY platform ASC
    `) as unknown as Array<{ worker_id: string; platform: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform)).toEqual(['chrome-extension', 'headless']);
  });

  it('rejects a platform that is not eligible for child-token mint', async () => {
    const user = await createTestUser({ email: 'headless-mint-reject@test.example.com' });
    const personalOrg = await createTestOrganization({ name: 'Personal Reject' });
    await markPersonalOrg(personalOrg.id, user.id);
    await addUserToOrganization(user.id, personalOrg.id, 'owner');

    const res = await mintApp(user.id).request(
      '/api/me/devices/mint-child-token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'macos', label: 'should-fail' }),
      },
      TEST_ENV
    );
    expect(res.status).toBe(400);
  });
});