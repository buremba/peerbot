/**
 * reconcileDeviceCapabilities — never steal a device pin another live
 * connection holds. Integration test against real Postgres.
 *
 * `idx_connections_org_connector_device_live` is UNIQUE on
 * (organization_id, connector_key, device_worker_id) WHERE deleted_at IS NULL
 * AND device_worker_id IS NOT NULL — an org legitimately holds one connection
 * PER DEVICE, the same shape `idx_connections_org_connector_account_live` gives
 * OAuth accounts.
 *
 * Retiring a Mac leaves its connection pinned to the now-stale device while the
 * replacement Mac's connection holds the only fresh one. The fast path resolves
 * a connection for the (org, connector) with no ORDER BY, hands it to
 * `reconcilePin`, and the pin UPDATE targets a device the OTHER row owns — 23505,
 * the whole wire transaction aborts, and the poll retries forever.
 *
 * Observed on prod 2026-07-29: org 8dc12bdd, apple.computer_use, rows 397
 * (MacBook Pro, last seen 10d) and 447 (Mac mini, last seen 2h), ~8 errors/min
 * across two replicas.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.device_pin';
const CAPABILITY = 'test_device_pin';

async function seedDefinition(orgId: string) {
  // A bundled-shape device connector: runtime + required_capability, and
  // feeds_schema {} so `declaredFeedKeys` is empty and the fast-path `ready`
  // check short-circuits true — exactly apple.computer_use's shape.
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Device Pin', '1.0.0', 'active', ${CAPABILITY},
      ${sql.json({ kind: 'device' })}, ${sql.json({})}, ${sql.json({})},
      ${sql.json({})}, ${sql.json({})}
    )
  `;
  await sql`
    INSERT INTO connector_versions (organization_id, connector_key, version)
    VALUES (${orgId}, ${CONNECTOR}, '1.0.0')
    ON CONFLICT DO NOTHING
  `;
}

/**
 * The connector must reach reconcile as a DEVICE MANIFEST: bundled connectors
 * come from the on-disk catalog (`getBundledDeviceConnectors`), which is empty
 * in tests, so a DB-only definition never enters `byKey` and the wire pass
 * returns before it can pin anything.
 */
const MANIFEST = {
  key: CONNECTOR,
  version: '1.0.0',
  name: 'Test Device Pin',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedWorker(userId: string, orgId: string, fresh: boolean): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
  // Stale = outside DEVICE_WORKER_FRESH_INTERVAL ('7 days').
  const lastSeen = fresh ? new Date() : new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const manifests = {
    [CONNECTOR]: {
      manifest: MANIFEST,
      manifest_hash: `hash-${CONNECTOR}-1.0.0`,
      received_at: new Date().toISOString(),
    },
  };
  const [row] = (await sql`
    INSERT INTO device_workers (
      user_id, worker_id, platform, capabilities, label, organization_id,
      last_seen_at, connector_manifests
    ) VALUES (
      ${userId}, ${workerId}, 'macos', ${sql.json([CAPABILITY])},
      ${fresh ? 'Mac mini' : 'MacBook Pro'}, ${orgId}, ${lastSeen},
      ${sql.json(manifests)}
    )
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return String(row.id);
}

async function seedConn(orgId: string, userId: string, device: string | null): Promise<number> {
  const slug = `conn-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = (await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      auth_profile_id, created_by, visibility, device_worker_id
    ) VALUES (
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Device Pin', 'active',
      NULL, ${userId}, 'private', ${device}::uuid
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
  return Number(row.id);
}

async function pinOf(id: number): Promise<string | null> {
  const [row] = (await sql`
    SELECT device_worker_id FROM connections WHERE id = ${id}
  `) as unknown as Array<{ device_worker_id: string | null }>;
  return row?.device_worker_id ?? null;
}

describe('device pin owner guard', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const org = await createTestOrganization();
    orgId = org.id;
    // Auto-wire targets the user's PERSONAL org, resolved by this metadata tag
    // (auth/personal-org-provisioning.ts) rather than by ownership.
    await sql`
      UPDATE "organization"
      SET metadata = ${JSON.stringify({ personal_org_for_user_id: userId })}
      WHERE id = ${orgId}
    `;
    await seedDefinition(orgId);
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('does not steal a pin held by another live connection, and clears the dead one', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    const retired = await seedConn(orgId, userId, staleDevice); // old MacBook's row
    const current = await seedConn(orgId, userId, freshDevice); // new Mac mini's row

    // Before the guard this throws 23505 inside the wire pass, the transaction
    // aborts, and the error is swallowed by the catch.
    await reconcileDeviceCapabilities(userId);

    // The live row keeps its device; the retired row is unpinned (claimable by
    // any future device) rather than left pointing at a vanished one.
    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retired)).toBeNull();
  });

  it('still repairs a stale pin to the sole fresh device when nothing else holds it', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);
    const only = await seedConn(orgId, userId, staleDevice);

    await reconcileDeviceCapabilities(userId);

    // The documented repair must survive the guard.
    expect(await pinOf(only)).toBe(freshDevice);
  });

  it('leaves a pin that is already a fresh device untouched', async () => {
    const freshDevice = await seedWorker(userId, orgId, true);
    const only = await seedConn(orgId, userId, freshDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(only)).toBe(freshDevice);
  });
});
