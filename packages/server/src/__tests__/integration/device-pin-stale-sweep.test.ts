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

  it('clears EVERY retired pin, which one selected row never could', async () => {
    // Deterministic by construction, not by scan order: with TWO stale
    // connections the single-row path can clear at most the one row the
    // unordered `GROUP BY … LIMIT 1` happened to return, so without the sweep
    // at least one stale pin survives no matter which row that is.
    const staleA = await seedWorker(userId, orgId, false);
    const staleB = await seedWorker(userId, orgId, false);
    const freshDevice = await seedWorker(userId, orgId, true);

    const current = await seedConn(orgId, userId, freshDevice);
    const retiredA = await seedConn(orgId, userId, staleA);
    const retiredB = await seedConn(orgId, userId, staleB);

    await reconcileDeviceCapabilities(userId);

    expect(await pinOf(current)).toBe(freshDevice);
    expect(await pinOf(retiredA)).toBeNull();
    expect(await pinOf(retiredB)).toBeNull();
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

  it('pauses only auth-free feeds when the fleet stops serving the capability', async () => {
    // When no fresh device advertises the capability, the connector routes to
    // `pauseStaleDeviceFeeds` instead of the wire pass. That statement carries
    // the same credential filter: an auth- or app-auth-backed connection is
    // user-created, so pausing its feeds would break a connection auto-wire
    // never made.
    // A FRESH device is needed for the manifest to load at all (byKey is built
    // from fresh workers), but it must NOT advertise the capability — that is
    // what routes the connector to the pause path instead of the wire pass.
    const dead = await seedWorker(userId, orgId, false);
    const freshNoCap = await seedWorker(userId, orgId, true);
    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${freshNoCap}::uuid
    `;

    const [prof] = (await sql`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key, profile_kind, created_by
      ) VALUES (
        ${orgId}, ${`prof-${Math.random().toString(36).slice(2, 8)}`}, 'Test Profile',
        ${CONNECTOR}, 'env', ${userId}
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;

    const autoWired = await seedConn(orgId, userId, dead);
    const authBacked = await seedConn(orgId, userId, null);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`UPDATE connections SET auth_profile_id = ${prof.id} WHERE id = ${authBacked}`;
    await sql`UPDATE connections SET app_auth_profile_id = ${prof.id} WHERE id = ${appAuthBacked}`;

    const feedOf = async (connId: number) => {
      const [row] = (await sql`
        INSERT INTO feeds (organization_id, connection_id, feed_key, display_name, status)
        VALUES (${orgId}, ${connId}, 'items', 'Items', 'active')
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(row.id);
    };
    const autoFeed = await feedOf(autoWired);
    const authFeed = await feedOf(authBacked);
    const appAuthFeed = await feedOf(appAuthBacked);

    // No FRESH device serves the capability, so the pause path runs.
    await reconcileDeviceCapabilities(userId);

    const statusOf = async (id: number) => {
      const [row] = (await sql`
        SELECT status FROM feeds WHERE id = ${id}
      `) as unknown as Array<{ status: string }>;
      return row.status;
    };
    expect(await statusOf(autoFeed)).toBe('paused');
    expect(await statusOf(authFeed)).toBe('active');
    expect(await statusOf(appAuthFeed)).toBe('active');
  });

  it('never touches an auth-backed connection, even on a dead device', async () => {
    // Auto-wire owns auth-FREE rows only — every other query in the wire pass
    // filters `auth_profile_id IS NULL`. An auth-backed connection is
    // user-created; unpinning it would hand it to any capable device while the
    // poll withholds credentials from unpinned connections, breaking a
    // connection this pass never created.
    const dead = await seedWorker(userId, orgId, false);
    const fresh = await seedWorker(userId, orgId, true);
    const authBacked = await seedConn(orgId, userId, dead);
    await sql`
      INSERT INTO auth_profiles (
        organization_id, slug, display_name, connector_key, profile_kind, created_by
      ) VALUES (
        ${orgId}, ${`prof-${Math.random().toString(36).slice(2, 8)}`}, 'Test Profile',
        ${CONNECTOR}, 'env', ${userId}
      )
    `;
    const [prof] = (await sql`
      SELECT id FROM auth_profiles WHERE organization_id = ${orgId} ORDER BY id DESC LIMIT 1
    `) as unknown as Array<{ id: number }>;
    await sql`
      UPDATE connections SET auth_profile_id = ${prof.id} WHERE id = ${authBacked}
    `;
    // Same protection for an APP-auth-backed row: auto-wire's own INSERT writes
    // NULL to both profile columns, so either one being set means the row is
    // credential-backed and user-created.
    const dead2 = await seedWorker(userId, orgId, false);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`
      UPDATE connections SET app_auth_profile_id = ${prof.id}, device_worker_id = ${dead2}::uuid
      WHERE id = ${appAuthBacked}
    `;
    const autoWired = await seedConn(orgId, userId, fresh);

    await reconcileDeviceCapabilities(userId);

    // Stale pins, but not ours to clear.
    expect(await pinOf(authBacked)).toBe(dead);
    expect(await pinOf(appAuthBacked)).toBe(dead2);
    expect(await pinOf(autoWired)).toBe(fresh);
  });

});
