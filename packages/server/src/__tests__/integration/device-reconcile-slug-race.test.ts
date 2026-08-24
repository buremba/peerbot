/**
 * A device connector whose slug is taken out from under it must still wire.
 *
 * `ensureDeviceConnectorWired` derives a connection slug from the manifest's
 * display NAME, and `connections_org_slug_unique` enforces uniqueness per ORG —
 * but the advisory lock meant to serialize the wire is keyed on
 * (userId, connectorKey). Lock scope and uniqueness scope are not the same
 * scope, so two DIFFERENT connector keys take two DIFFERENT locks, run
 * concurrently, compute the same free slug, and the loser's INSERT trips the
 * constraint. The source comment asserting this "can't be raced" was wrong.
 *
 * The loser was then absent from `connections` until the next poll. That is how
 * this was found: as an unexplained ~1-in-8 flake in
 * device-connector-manifests.test.ts, where a sibling intermittently failed to
 * install.
 *
 * The regression guard FORCES that interleaving instead of hoping for it: an
 * uncommitted transaction squats on the exact slug the wire is about to
 * compute, and is committed only once the wire's INSERT is observed parked on
 * the unique index. Two live sibling manifests would reproduce it only
 * probabilistically — a 15-round loop still left roughly a 1-in-8 chance of
 * every round missing the collision, i.e. of the pre-fix code passing its own
 * regression test.
 *
 * Driven through the real poll endpoint rather than a hand-built
 * `device_workers` row — capabilities are stored in a shape poll owns, and a
 * fixture that guesses it wrong reconciles nothing and passes for the wrong
 * reason (observed: a hand-built row wired zero connectors and still went
 * green). A stubbed rejection would be worse: it would pass against any
 * wrapper and prove nothing about the path that actually fails.
 *
 * Asserts the OUTCOME (wired, with the suffixed slug) rather than a log line,
 * because the fix makes the failure stop happening rather than merely become
 * visible.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { slugifyConnectionName } from '../../utils/connections';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const SHARED_NAME = 'Colliding Device Connector';
/** The slug the wire computes from `SHARED_NAME` when nothing has claimed it. */
const BASE_SLUG = slugifyConnectionName(SHARED_NAME);
const SQUATTER_KEY = 'apple.collide_squatter';

function manifestFor(key: string, capability: string) {
  return {
    key,
    version: '0.1.0',
    // Same display name on both — this is the collision under test.
    name: SHARED_NAME,
    description: 'Device manifest used to force a connection-slug collision.',
    required_capability: capability,
    runtime: { platforms: ['macos'] },
    auth_schema: { methods: [{ type: 'none' }] },
    feeds_schema: {
      snapshots: {
        key: 'snapshots',
        name: 'Snapshots',
        operations: ['sync'],
        configSchema: { type: 'object', properties: {} },
        eventKinds: {
          snapshot: {
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id'],
              properties: {
                source: { type: 'string' },
                origin_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}

/** A promise plus its resolver, for handing control between two live tasks. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function seedFleet() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-wirefail-${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;

  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'Wire Failure Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (
      ${orgId}, 'Wire Failure Org', ${orgId}, 'private',
      ${sql.json({ personal_org_for_user_id: userId })}, NOW()
    )
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, 'macos', '0.1.0', ${sql.json([])}, 'Colliding Mac', ${orgId})
  `;
  return { userId, orgId, workerId };
}

function pollManifests(
  workerId: string,
  manifests: Array<ReturnType<typeof manifestFor>>,
) {
  return post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'macos',
      app_version: '9.9.0',
      label: 'Colliding Mac',
      capabilities: { screentime: true, photos: true },
      connector_manifests: manifests,
    },
  });
}

/**
 * Resolve once a backend is parked on `blockerPid`'s uncommitted row while
 * inserting into `connections` — i.e. once the slug collision has actually
 * happened. Waiting on this condition rather than on a fixed delay is what
 * makes the collision deterministic: releasing the squatter any earlier would
 * let the wire see the committed row and suffix its slug on the first try,
 * exercising nothing.
 */
async function waitForWireBlockedOn(blockerPid: number): Promise<void> {
  const sql = getTestDb();
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = (await sql`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity a
      WHERE ${blockerPid}::int = ANY(pg_blocking_pids(a.pid))
        AND a.query ILIKE '%INSERT INTO connections%'
    `) as unknown as Array<{ blocked: number }>;
    if ((rows[0]?.blocked ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        'Timed out waiting for the device-connector wire to block on the squatted slug — ' +
          'the wire no longer computes it from the manifest display name, so this test ' +
          'is no longer forcing the collision it claims to force.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('device connector slug race', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('retries the wire when a concurrent insert takes the slug it computed', async () => {
    const sql = getTestDb();
    const { userId, orgId, workerId } = await seedFleet();

    const squatterReady = deferred<number>();
    const releaseSquatter = deferred<void>();

    // Hold an UNCOMMITTED connection on the slug the wire is about to compute.
    // `ensureUniqueConnectionSlug`'s SELECT cannot see it under READ COMMITTED,
    // so the wire computes BASE_SLUG and its INSERT parks on the unique index
    // until this transaction resolves — exactly the interleaving a sibling
    // manifest produces in the field, minus the coin flip.
    const squatter = sql.begin(async (tx) => {
      await tx`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility
        ) VALUES (
          ${orgId}, ${SQUATTER_KEY}, ${BASE_SLUG}, ${SHARED_NAME}, 'active',
          NULL, NULL, NULL, ${userId}, 'private'
        )
      `;
      const pidRows =
        (await tx`SELECT pg_backend_pid()::int AS pid`) as unknown as Array<{
        pid: number;
      }>;
      squatterReady.resolve(pidRows[0].pid);
      await releaseSquatter.promise;
    });

    let status: number;
    try {
      const squatterPid = await squatterReady.promise;
      const polled = pollManifests(workerId, [
        manifestFor('apple.collide_one', 'screentime'),
      ]);
      await waitForWireBlockedOn(squatterPid);
      releaseSquatter.resolve();
      // COMMIT: the parked INSERT wakes into the unique violation.
      await squatter;
      status = (await polled).status;
    } finally {
      // Never leave the squatter's transaction open if the wait above threw.
      releaseSquatter.resolve();
      await squatter.catch(() => {});
    }
    expect(status).toBe(200);

    const conns = (await sql`
      SELECT connector_key, slug FROM connections
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
      ORDER BY connector_key
    `) as unknown as Array<{ connector_key: string; slug: string }>;

    // The connector must be wired. Pre-fix the unique violation escaped the
    // wire and the row was simply absent — that absence is the whole defect,
    // and it is what made an unrelated test flake ~1 run in 8.
    expect(
      conns.map((c) => c.connector_key),
      'the wire lost the slug race and never retried',
    ).toEqual(['apple.collide_one', SQUATTER_KEY]);

    // And the retry must resolve the collision by suffixing against the now
    // visible winner, not by betting on the same slug again.
    expect(
      conns.find((c) => c.connector_key === 'apple.collide_one')?.slug,
    ).toBe(`${BASE_SLUG}-2`);
  }, 60_000);

  it('wires both connectors when two manifests share a display name', async () => {
    const sql = getTestDb();
    const { orgId, workerId } = await seedFleet();

    // The field scenario, end-to-end: two sibling manifests, one display name,
    // both expected to land with distinct slugs. Whether the two wires actually
    // interleave here is up to the scheduler, so this is a smoke check on the
    // real shape of the bug — the forced-collision test above is the guard.
    const res = await pollManifests(workerId, [
      manifestFor('apple.collide_one', 'screentime'),
      manifestFor('apple.collide_two', 'photos'),
    ]);
    expect(res.status).toBe(200);

    const conns = (await sql`
      SELECT connector_key, slug FROM connections
      WHERE organization_id = ${orgId} AND deleted_at IS NULL
      ORDER BY connector_key
    `) as unknown as Array<{ connector_key: string; slug: string }>;

    expect(
      conns.map((c) => c.connector_key),
      'a connector failed to wire',
    ).toEqual(['apple.collide_one', 'apple.collide_two']);
    expect(new Set(conns.map((c) => c.slug)).size, 'slugs collided').toBe(2);
  }, 60_000);
});
