/**
 * reconcileDeviceCapabilities — a retired connection must not stay pinned to a
 * device that has dropped out of the fleet. Integration test, real Postgres.
 *
 * An org holds one connection PER DEVICE
 * (`idx_connections_org_connector_device_live`), but the fast path resolves only
 * ONE of them (`GROUP BY … LIMIT 1`, no ORDER BY) and pins that one. When it
 * returns the row that is already correctly pinned, the pin UPDATE no-ops — its
 * WHERE requires `device_worker_id IS DISTINCT FROM target` — and the sibling
 * stays bound to a worker that will never poll again. Nothing revisits it.
 *
 * Silent since #2286 stopped the 23505 crash: no error, just a connection
 * pointing at a vanished Mac, claimable by nobody.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileDeviceCapabilities } from '../../worker-api/device-reconcile';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization, createTestUser } from '../setup/test-fixtures';

const sql = getTestDb();

const CONNECTOR = 'test.pin_sweep';
const CAPABILITY = 'test_pin_sweep';

/** Bundled connectors come from the on-disk catalog (empty in tests), so the
 * connector must arrive as a device manifest to reach the wire pass at all. */
const MANIFEST = {
  key: CONNECTOR,
  version: '1.0.0',
  name: 'Test Pin Sweep',
  required_capability: CAPABILITY,
  runtime: { platforms: ['macos'] },
  feeds_schema: {},
};

async function seedDefinition(orgId: string) {
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, status, required_capability,
      runtime, feeds_schema, auth_schema, actions_schema, options_schema
    ) VALUES (
      ${orgId}, ${CONNECTOR}, 'Test Pin Sweep', '1.0.0', 'active', ${CAPABILITY},
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

async function seedWorker(userId: string, orgId: string, fresh: boolean): Promise<string> {
  const workerId = `mac-${Math.random().toString(36).slice(2, 10)}`;
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
      ${orgId}, ${CONNECTOR}, ${slug}, 'Test Pin Sweep', 'active',
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

describe('device pin stale sweep', () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const org = await createTestOrganization();
    orgId = org.id;
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

  it('clears a retired pin even when the fast path selects the already-correct row', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    // The CURRENT connection is inserted first, so it holds the lower id and an
    // unordered `LIMIT 1` tends to return it — the pin UPDATE then no-ops and,
    // before the sweep, the retired row below is never touched.
    const current = await seedConn(orgId, userId, freshDevice);
    const retired = await seedConn(orgId, userId, staleDevice);
    expect(current).toBeLessThan(retired);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retired)).toBeNull();
  });

  it('clears the retired pin in the other selection order too', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    const retired = await seedConn(orgId, userId, staleDevice);
    const current = await seedConn(orgId, userId, freshDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retired)).toBeNull();
  });

  it('leaves every pin alone when several devices are fresh', async () => {
    // Two fresh devices means `matchingDeviceIds.length !== 1`, so nothing is
    // auto-pinned and BOTH existing pins are deliberate — the sweep must not
    // treat either as stale.
    const deviceA = await seedWorker(userId, orgId, true);
    const deviceB = await seedWorker(userId, orgId, true);
    const connA = await seedConn(orgId, userId, deviceA);
    const connB = await seedConn(orgId, userId, deviceB);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(connA)).toBe(deviceA);
    expect(await pinOf(connB)).toBe(deviceB);
  });

  it('only unpins workers that are absent or stale at mutation time', async () => {
    // `matchingDeviceIds` is snapshotted BEFORE the advisory lock, so a poll on
    // another replica can refresh a device between this pass's snapshot and its
    // commit; sweeping from the stale list alone would unpin a device that is
    // live again. The sweep therefore re-checks `device_workers` in the same
    // statement, and this asserts that predicate directly — the true
    // snapshot-vs-commit interleaving is not reachable from outside
    // `reconcileDeviceCapabilities`, which takes its fleet read internally.
    const live = await seedWorker(userId, orgId, true);
    const gone = await seedWorker(userId, orgId, false);
    const liveConn = await seedConn(orgId, userId, live);
    const goneConn = await seedConn(orgId, userId, gone);

    // Drive the sweep predicate with a deliberately WRONG (empty) snapshot —
    // exactly the stale-list case. Only the genuinely stale worker may lose its
    // pin; the fresh one must survive on the mutation-time re-check alone.
    await sql`
      UPDATE connections c
      SET device_worker_id = NULL, updated_at = NOW()
      WHERE c.organization_id = ${orgId}
        AND c.connector_key = ${CONNECTOR}
        AND c.deleted_at IS NULL
        AND c.device_worker_id IS NOT NULL
        AND NOT (c.device_worker_id::text = ANY(ARRAY[]::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM device_workers dw
          WHERE dw.id = c.device_worker_id
            AND dw.user_id = ${userId}
            AND dw.last_seen_at > now() - '7 days'::interval
        )
    `;

    expect(await pinOf(liveConn)).toBe(live);
    expect(await pinOf(goneConn)).toBeNull();
  });

  it('unpins a device that is alive but no longer advertises the capability', async () => {
    // Freshness alone is not "still serving". A device can keep heartbeating
    // after an app update or a revoked permission drops the capability; polling
    // is capability-gated, so leaving that pin in place strands the connection
    // on a worker that will never claim its runs.
    const serving = await seedWorker(userId, orgId, true);
    const lapsed = await seedWorker(userId, orgId, true);
    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${lapsed}::uuid
    `;
    const servingConn = await seedConn(orgId, userId, serving);
    const lapsedConn = await seedConn(orgId, userId, lapsed);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(servingConn)).toBe(serving);
    expect(await pinOf(lapsedConn)).toBeNull();
  });

  it('still repairs a lone stale pin to the sole fresh device', async () => {
    const staleDevice = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);
    const only = await seedConn(orgId, userId, staleDevice);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(only)).toBe(freshDevice);
  });
});
