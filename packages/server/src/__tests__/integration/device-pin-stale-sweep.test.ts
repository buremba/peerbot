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
import {
  deviceManifestHash,
  type DeviceConnectorManifest,
} from '../../worker-api/device-manifests';
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
      manifest_hash: deviceManifestHash(MANIFEST as DeviceConnectorManifest),
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

async function seedAuthProfile(orgId: string, userId: string): Promise<number> {
  const [row] = (await sql`
    INSERT INTO auth_profiles (
      organization_id, slug, display_name, connector_key, profile_kind, created_by
    ) VALUES (
      ${orgId}, ${`prof-${Math.random().toString(36).slice(2, 8)}`}, 'Test Profile',
      ${CONNECTOR}, 'env', ${userId}
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

/** Live connections carrying the device-connector identity: auto-wire's own
 * INSERT writes NULL to BOTH profile columns, so this is exactly the set the
 * wire pass owns — and exactly what a credential-backed row must stay out of. */
async function autoWiredConnections(
  orgId: string
): Promise<Array<{ id: number; device_worker_id: string | null }>> {
  const rows = (await sql`
    SELECT id, device_worker_id
    FROM connections
    WHERE organization_id = ${orgId}
      AND connector_key = ${CONNECTOR}
      AND auth_profile_id IS NULL
      AND app_auth_profile_id IS NULL
      AND deleted_at IS NULL
    ORDER BY id ASC
  `) as unknown as Array<{ id: number; device_worker_id: string | null }>;
  return rows.map((r) => ({ id: Number(r.id), device_worker_id: r.device_worker_id }));
}

/** Only the SLOW path re-runs `upsertConnectorDefinitionRecords`, and that
 * upsert always stamps `updated_at = NOW()`. So a definition whose stamp did not
 * move is proof the fast path was taken — the one externally visible difference
 * between the two branches. */
async function definitionUpdatedAt(orgId: string): Promise<string> {
  const [row] = (await sql`
    SELECT updated_at FROM connector_definitions
    WHERE organization_id = ${orgId} AND key = ${CONNECTOR} AND status = 'active'
  `) as unknown as Array<{ updated_at: string | Date }>;
  return new Date(row.updated_at).toISOString();
}

/**
 * Block until `reconcileDeviceCapabilities` has parked on the per-(user,
 * connector) autowire advisory lock. Two-int advisory locks surface in
 * `pg_locks` as classid=key1, objid=key2, objsubid=2; `hashtext` is int4 so the
 * keys are compared in their unsigned form. Throwing on timeout is deliberate —
 * a test that silently proceeds without the interleave would prove nothing.
 */
async function waitForAutowireLockWaiter(lockKey: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = (await sql`
      SELECT count(*)::int AS waiting
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND NOT granted
        AND objsubid = 2
        AND classid::text::bigint = (hashtext('lobu:autowire')::bigint & 4294967295)
        AND objid::text::bigint = (hashtext(${lockKey})::bigint & 4294967295)
    `) as unknown as Array<{ waiting: number }>;
    if (Number(row.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`reconcile never blocked on the autowire advisory lock for ${lockKey}`);
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

  it('clears a pin whose device is in the snapshot but has lost the capability', async () => {
    // `matchingDeviceIds` is captured before the advisory lock. A device present
    // in it can drop the capability before the sweep runs — an app update or a
    // revoked permission on another replica. Gating the sweep on that snapshot
    // would let such a pin survive, because the snapshot still says "serving"
    // and short-circuits the mutation-time check. Only the NOT EXISTS decides.
    const serving = await seedWorker(userId, orgId, true);
    const lapsing = await seedWorker(userId, orgId, true);
    const servingConn = await seedConn(orgId, userId, serving);
    const lapsingConn = await seedConn(orgId, userId, lapsing);

    // The interleave has to happen INSIDE reconcile — between its fleet read
    // and the sweep — or the snapshot never contains the stale-positive entry
    // and the test proves nothing. Hold the per-(user, connector) autowire lock
    // so reconcile snapshots BOTH devices as capable, then parks; drop the
    // capability while it waits; release. Its snapshot is now wrong in exactly
    // the way the blocker described.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${`${userId}:${CONNECTOR}`}))`;
      await held;
    });

    const reconciling = reconcileDeviceCapabilities(userId);
    await waitForAutowireLockWaiter(`${userId}:${CONNECTOR}`);

    await sql`
      UPDATE device_workers SET capabilities = ${sql.json([])} WHERE id = ${lapsing}::uuid
    `;
    release();
    await Promise.all([reconciling, holder]);

    expect(await pinOf(servingConn)).toBe(serving);
    expect(await pinOf(lapsingConn)).toBeNull();
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

    const profileId = await seedAuthProfile(orgId, userId);

    const autoWired = await seedConn(orgId, userId, dead);
    const authBacked = await seedConn(orgId, userId, null);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${authBacked}`;
    await sql`UPDATE connections SET app_auth_profile_id = ${profileId} WHERE id = ${appAuthBacked}`;

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
    const profileId = await seedAuthProfile(orgId, userId);
    await sql`
      UPDATE connections SET auth_profile_id = ${profileId} WHERE id = ${authBacked}
    `;
    // Same protection for an APP-auth-backed row: auto-wire's own INSERT writes
    // NULL to both profile columns, so either one being set means the row is
    // credential-backed and user-created.
    const dead2 = await seedWorker(userId, orgId, false);
    const appAuthBacked = await seedConn(orgId, userId, null);
    await sql`
      UPDATE connections SET app_auth_profile_id = ${profileId}, device_worker_id = ${dead2}::uuid
      WHERE id = ${appAuthBacked}
    `;
    const autoWired = await seedConn(orgId, userId, fresh);

    await reconcileDeviceCapabilities(userId);

    // Stale pins, but not ours to clear.
    expect(await pinOf(authBacked)).toBe(dead);
    expect(await pinOf(appAuthBacked)).toBe(dead2);
    expect(await pinOf(autoWired)).toBe(fresh);
  });

  it('fast path refuses to adopt an app-auth-backed connection', async () => {
    // The FAST path, not the slow one. Every case above runs against the
    // hand-seeded definition, which does not match the manifest source
    // (`definitionMatchesSource` is false), so they all fall through to the slow
    // path and never exercise the fast path's own credential filter.
    const fresh = await seedWorker(userId, orgId, true);
    const dead = await seedWorker(userId, orgId, false);

    // Arm the fast path by letting reconciliation write the definition itself:
    // its upsert stores exactly the metadata `definitionMatchesSource` compares
    // against. Deriving the match from production rather than transcribing it
    // into a fixture is what stops this test decaying into a no-op if the
    // manifest→metadata mapping ever changes.
    await reconcileDeviceCapabilities(userId);
    const [wired] = await autoWiredConnections(orgId);
    expect(wired).toBeDefined();

    // Turn that row into the connection under test: credential-backed, and
    // pinned to a device that has since dropped out. It is now the ONLY
    // connection, so the fast path's `LIMIT 1` has a single candidate — the
    // outcome is decided by the credential filter, not by scan order.
    const profileId = await seedAuthProfile(orgId, userId);
    const appAuthBacked = wired.id;
    await sql`
      UPDATE connections
      SET app_auth_profile_id = ${profileId}, device_worker_id = ${dead}::uuid
      WHERE id = ${appAuthBacked}
    `;
    // Read the stamp back rather than comparing against the literal: whether the
    // column is tz-aware decides how it round-trips, and a comparison that never
    // matches would pass this test for free.
    await sql`
      UPDATE connector_definitions SET updated_at = '2000-01-01T00:00:00Z'
      WHERE organization_id = ${orgId} AND key = ${CONNECTOR} AND status = 'active'
    `;
    const stamp = await definitionUpdatedAt(orgId);

    await reconcileDeviceCapabilities(userId);

    // The fast path found no connection it owns, so the wire pass fell through
    // to the slow path — which re-upserts the definition (moving the stamp) and
    // creates its OWN credential-free connection. Adopting the app-auth row
    // instead would have fast-pathed out: stamp frozen, no connection made.
    expect(await definitionUpdatedAt(orgId)).not.toBe(stamp);
    const autoWired = await autoWiredConnections(orgId);
    expect(autoWired).toHaveLength(1);
    expect(autoWired[0].id).not.toBe(appAuthBacked);
    expect(autoWired[0].device_worker_id).toBe(fresh);
    // ...and never re-pinned the credential-backed row it does not own.
    expect(await pinOf(appAuthBacked)).toBe(dead);
  });

  it('keeps a pin whose device came back between the fleet snapshot and the sweep', async () => {
    // `matchingDeviceIds` is snapshotted BEFORE the advisory lock, so on another
    // replica a device can heartbeat back into the fleet while this pass is
    // still parked on the lock holding a snapshot that says it is gone. Sweeping
    // from that snapshot would unpin a device that is live again; the sweep's
    // NOT EXISTS re-checks `device_workers` at mutation time instead.
    const fresh = await seedWorker(userId, orgId, true);
    const revived = await seedWorker(userId, orgId, false);
    // Lowest id — the row the wire pass resolves (`ORDER BY id ASC LIMIT 1`), so
    // the single-row repair lands here and the revived row is decided purely by
    // the sweep. Its pin is already correct, so that repair is a no-op.
    const currentConn = await seedConn(orgId, userId, fresh);
    const revivedConn = await seedConn(orgId, userId, revived);

    const lockKey = `${userId}:${CONNECTOR}`;
    let running!: Promise<void>;
    await sql.begin(async (tx) => {
      // Hold the wire pass's own lock, from a connection it does not own.
      await tx`SELECT pg_advisory_xact_lock(hashtext('lobu:autowire'), hashtext(${lockKey}))`;
      // Reads the fleet — `revived` is stale here — then parks on the lock.
      running = reconcileDeviceCapabilities(userId);
      await waitForAutowireLockWaiter(lockKey);
      // The device comes back while the pass is parked, exactly the window the
      // mutation-time re-check exists for.
      await sql`UPDATE device_workers SET last_seen_at = now() WHERE id = ${revived}::uuid`;
    });
    await running;

    expect(await pinOf(currentConn)).toBe(fresh);
    expect(await pinOf(revivedConn)).toBe(revived);
  });
});
