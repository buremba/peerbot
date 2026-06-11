/**
 * Local/personal-install device-worker registration on an *anonymous* poll.
 *
 * When WORKER_API_TOKEN is unset, a device-worker poll whose token fails auth
 * doesn't 401 — the /api/workers/* middleware degrades it to `anonymous`. The
 * fix (worker-api.ts) re-anchors such a poll to the user that already owns the
 * posted worker_id in a non-cloud install, so the device_workers capability
 * registration (which drives connector wiring) still happens. Cloud
 * (LOBU_CLOUD_MODE) must stay strict: since the #1192 security audit the
 * middleware fails anonymous workers-API calls closed with a 401 there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { post } from '../../setup/test-helpers';

async function seedDeviceOwner(opts: { caps?: Record<string, boolean>; appVersion?: string }) {
  const sql = getTestDb();
  const orgId = `org-anon-${generateSecureToken(4)}`;
  const slug = orgId.toLowerCase();
  const userId = `user_${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, "createdAt")
    VALUES (${orgId}, ${orgId}, ${slug}, 'private', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Anon Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, 'macos', ${opts.appVersion ?? '1.0.0'}, ${sql.json(Object.keys(opts.caps ?? {}))}, 'Mac', ${orgId})
  `;
  return { orgId, userId, workerId };
}

async function readDevice(workerId: string) {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT app_version, capabilities FROM device_workers WHERE worker_id = ${workerId} LIMIT 1
  `) as unknown as Array<{ app_version: string | null; capabilities: unknown }>;
  if (rows.length === 0) return null;
  const caps = Array.isArray(rows[0].capabilities) ? (rows[0].capabilities as string[]) : [];
  return { appVersion: rows[0].app_version, caps };
}

const pollBody = (workerId: string) => ({
  worker_id: workerId,
  capabilities: { screentime: true },
  platform: 'macos',
  app_version: '9.9.0',
  label: 'Mac',
});

describe('anonymous device-worker registration (local/non-cloud)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(() => {
    delete process.env.LOBU_CLOUD_MODE;
  });

  it('re-registers an existing device’s capabilities on an anonymous poll', async () => {
    const { workerId } = await seedDeviceOwner({ caps: {}, appVersion: '8.0.0' });

    const res = await post('/api/workers/poll', { body: pollBody(workerId) });
    expect(res.status).toBe(200);

    const dev = await readDevice(workerId);
    expect(dev).not.toBeNull();
    expect(dev?.caps).toContain('screentime');
    expect(dev?.appVersion).toBe('9.9.0');
  });

  it('does NOT register in cloud mode — strict, no worker_id spoofing', async () => {
    const { workerId } = await seedDeviceOwner({ caps: {}, appVersion: '8.0.0' });
    process.env.LOBU_CLOUD_MODE = '1';

    // #1192: anonymous workers-API access in cloud mode is rejected outright
    // (fail-closed 401), so the poll never reaches registration at all.
    const res = await post('/api/workers/poll', { body: pollBody(workerId) });
    expect(res.status).toBe(401);

    const dev = await readDevice(workerId);
    expect(dev?.caps).not.toContain('screentime');
    expect(dev?.appVersion).toBe('8.0.0');
  });

  it('does not fabricate a registration for an unknown worker_id', async () => {
    const unknown = `wk-${generateSecureToken(6)}`;

    const res = await post('/api/workers/poll', { body: pollBody(unknown) });
    expect(res.status).toBe(200);

    expect(await readDevice(unknown)).toBeNull();
  });
});
