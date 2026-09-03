/**
 * Integration test for the stale device-worker reaper's automation binding.
 *
 * An ARCHIVED Automation can never execute again, so it must not count as a
 * binding that keeps a dead machine alive — otherwise one soft-deleted row
 * anchors its device permanently and the reaper skips it every night. Because
 * `automations.device_worker_id` is a NO ACTION FK, ignoring archived rows in
 * the predicate is not enough on its own: the pin has to be released inside the
 * delete transaction or the FK rejects the DELETE.
 *
 * A LIVE pin must still block, and must not be cleared as a side effect — that
 * is the difference between reaping a dead machine and silently un-pinning a
 * runnable Automation.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import { handleDelete } from '../../tools/admin/manage_automations/crud';
import { reapStaleDeviceWorkers } from '../reap-stale-device-workers';

const ORG_ID = 'device-pin-reaper-org';
const USER_ID = 'device-pin-reaper-user';

beforeAll(async () => {
  await ensureDbForGatewayTests();
});

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "user" (id, name, email)
    VALUES (${USER_ID}, ${USER_ID}, ${`${USER_ID}@example.test`})
    ON CONFLICT (id) DO NOTHING
  `;
});

/** A device unseen well past the reaper's 30-day threshold. */
async function seedStaleDevice(workerId: string): Promise<string> {
  const sql = getDb();
  const [row] = (await sql`
    INSERT INTO device_workers (user_id, worker_id, organization_id, platform, last_seen_at)
    VALUES (${USER_ID}, ${workerId}, ${ORG_ID}, 'macos', now() - interval '40 days')
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedAutomationPinnedTo(
  deviceWorkerId: string,
  name: string
): Promise<number> {
  const sql = getDb();
  const [row] = (await sql`
    WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
    INSERT INTO automations (
      id, automation_group_id, organization_id, created_by, name, slug, device_worker_id
    )
    SELECT id, id, ${ORG_ID}, ${USER_ID}, ${name}, ${name}, ${deviceWorkerId}
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function archive(automationId: number): Promise<void> {
  const result = await handleDelete(
    { action: 'delete', automation_ids: [String(automationId)] } as never,
    { organizationId: ORG_ID, userId: USER_ID } as never
  );
  expect(result.summary.successful).toBe(1);
}

async function deviceExists(id: string): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT 1 FROM device_workers WHERE id = ${id}
  `) as unknown as Array<unknown>;
  return rows.length > 0;
}

async function pinOf(automationId: number): Promise<string | null> {
  const sql = getDb();
  const [row] = (await sql`
    SELECT device_worker_id FROM automations WHERE id = ${automationId}
  `) as unknown as Array<{ device_worker_id: string | null }>;
  return row?.device_worker_id ?? null;
}

describe('stale device-worker reaper vs archived automation pins', () => {
  test('reaps a device whose only pin is an archived Automation', async () => {
    const deviceId = await seedStaleDevice('worker-archived-pin');
    const automationId = await seedAutomationPinnedTo(deviceId, 'stale-envelope');

    // Blocked while the Automation is live.
    const blocked = await reapStaleDeviceWorkers();
    expect(blocked.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);

    await archive(automationId);

    // Archival is a soft delete: the pin is retained as history, NOT cleared
    // eagerly. Releasing it is the reaper's job, at the moment it deletes.
    expect(await pinOf(automationId)).toBe(deviceId);

    const after = await reapStaleDeviceWorkers();
    expect(after.reaped).toBe(1);
    expect(await deviceExists(deviceId)).toBe(false);
    expect(await pinOf(automationId)).toBeNull();
  });

  test('a live pin still blocks its device and is never cleared', async () => {
    const deviceId = await seedStaleDevice('worker-live-pin');
    const automationId = await seedAutomationPinnedTo(deviceId, 'still-active');

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);
    // The release must be scoped to archived rows — a runnable Automation must
    // not be silently un-pinned by a reaper pass that spared its device.
    expect(await pinOf(automationId)).toBe(deviceId);
  });

  test('one live pin protects the device even alongside archived ones', async () => {
    const deviceId = await seedStaleDevice('worker-mixed-pins');
    const archivedId = await seedAutomationPinnedTo(deviceId, 'mixed-archived');
    const liveId = await seedAutomationPinnedTo(deviceId, 'mixed-live');
    await archive(archivedId);

    const result = await reapStaleDeviceWorkers();

    expect(result.reaped).toBe(0);
    expect(await deviceExists(deviceId)).toBe(true);
    expect(await pinOf(liveId)).toBe(deviceId);
    expect(await pinOf(archivedId)).toBe(deviceId);
  });
});
