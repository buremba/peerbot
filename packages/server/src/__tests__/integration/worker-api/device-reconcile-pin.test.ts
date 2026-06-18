/**
 * device-reconcile pin self-heal — re-pair drift.
 *
 * After re-pair the extension polls under a new worker_id (new device_workers
 * surrogate id) while the chrome connection may still point at the old offline
 * row. Pin repair must use the same online window dispatch uses (20m), not the
 * 7-day fresh fleet window.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcileDeviceCapabilities } from '../../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();
const BROWSER_DEBUGGER = ['browser.debugger'];

async function markPersonalOrg(orgId: string, userId: string): Promise<void> {
  await sql`
    UPDATE organization
    SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
    WHERE id = ${orgId}
  `;
}

async function insertDeviceWorker(opts: {
  userId: string;
  orgId: string;
  workerId: string;
  lastSeenAt: Date;
}): Promise<string> {
  const rows = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id, last_seen_at
    ) VALUES (
      ${opts.userId}, ${opts.workerId}, 'chrome-extension',
      ${sql.json(BROWSER_DEBUGGER)}, 'Test Chrome', ${opts.orgId}, ${opts.lastSeenAt}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows[0].id;
}

async function seedChromeFastPath(orgId: string, deviceWorkerId: string): Promise<number> {
  await sql`
    INSERT INTO connector_definitions
      (key, name, organization_id, version, status, runtime, required_capability)
    VALUES (
      'chrome', 'Chrome', ${orgId}, '0.2.0', 'active',
      ${sql.json({ platforms: ['chrome-extension'] })},
      'browser.debugger'
    )
  `;
  await sql`
    INSERT INTO connector_versions (connector_key, version, compiled_code, created_at)
    VALUES ('chrome', '0.2.0', 'module.exports = {}', NOW())
    ON CONFLICT DO NOTHING
  `;
  const connRows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, device_worker_id, created_at, updated_at)
    VALUES
      (${orgId}, 'chrome', 'active', 'private', 'chrome-pin-test',
       ${deviceWorkerId}::uuid, NOW(), NOW())
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  const connectionId = connRows[0].id;
  for (const feedKey of ['open_tabs', 'tab_events']) {
    await sql`
      INSERT INTO feeds
        (organization_id, connection_id, feed_key, display_name, status, next_run_at)
      VALUES
        (${orgId}, ${connectionId}, ${feedKey}, 'Chrome', 'active', NOW())
    `;
  }
  return connectionId;
}

describe('reconcileDeviceCapabilities pin repair', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('migrates a chrome pin from an offline device to the sole online device after re-pair', async () => {
    const user = await createTestUser();
    const org = await createTestOrganization();
    await markPersonalOrg(org.id, user.id);

    const staleLastSeen = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const oldDeviceId = await insertDeviceWorker({
      userId: user.id,
      orgId: org.id,
      workerId: 'chrome-ext-old',
      lastSeenAt: staleLastSeen,
    });
    const newDeviceId = await insertDeviceWorker({
      userId: user.id,
      orgId: org.id,
      workerId: 'chrome-ext-new',
      lastSeenAt: new Date(),
    });
    const connectionId = await seedChromeFastPath(org.id, oldDeviceId);

    await reconcileDeviceCapabilities(user.id);

    const rows = (await sql`
      SELECT device_worker_id::text AS device_worker_id
      FROM connections
      WHERE id = ${connectionId}
    `) as unknown as Array<{ device_worker_id: string }>;
    expect(rows[0]?.device_worker_id).toBe(newDeviceId);
    expect(rows[0]?.device_worker_id).not.toBe(oldDeviceId);
  });

  it('does not override a deliberate pin when two devices are online', async () => {
    const user = await createTestUser();
    const org = await createTestOrganization();
    await markPersonalOrg(org.id, user.id);

    const deviceA = await insertDeviceWorker({
      userId: user.id,
      orgId: org.id,
      workerId: 'chrome-ext-a',
      lastSeenAt: new Date(),
    });
    const deviceB = await insertDeviceWorker({
      userId: user.id,
      orgId: org.id,
      workerId: 'chrome-ext-b',
      lastSeenAt: new Date(),
    });
    const connectionId = await seedChromeFastPath(org.id, deviceA);

    await reconcileDeviceCapabilities(user.id);

    const rows = (await sql`
      SELECT device_worker_id::text AS device_worker_id
      FROM connections
      WHERE id = ${connectionId}
    `) as unknown as Array<{ device_worker_id: string }>;
    expect(rows[0]?.device_worker_id).toBe(deviceA);
    expect(rows[0]?.device_worker_id).not.toBe(deviceB);
  });
});