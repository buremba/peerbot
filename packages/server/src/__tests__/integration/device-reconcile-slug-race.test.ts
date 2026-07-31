/**
 * Two device manifests sharing a display name must both wire.
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
 * Driven through the real poll endpoint rather than a hand-built
 * `device_workers` row — capabilities are stored in a shape poll owns, and a
 * fixture that guesses it wrong reconciles nothing and passes for the wrong
 * reason (observed: a hand-built row wired zero connectors and still went
 * green). A stubbed rejection would be worse: it would pass against any
 * wrapper and prove nothing about the path that actually fails.
 *
 * Asserts the OUTCOME (both wired, distinct slugs) rather than a log line,
 * because the fix makes the failure stop happening rather than merely become
 * visible.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const SHARED_NAME = 'Colliding Device Connector';

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

async function pollWithCollidingManifests() {
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

  const res = await post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'macos',
      app_version: '9.9.0',
      label: 'Colliding Mac',
      capabilities: { screentime: true, photos: true },
      connector_manifests: [
        manifestFor('apple.collide_one', 'screentime'),
        manifestFor('apple.collide_two', 'photos'),
      ],
    },
  });
  expect(res.status).toBe(200);
  return { userId, orgId };
}

describe('device connector slug race', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('wires both connectors when two manifests share a display name', async () => {
    const sql = getTestDb();

    // Repeated because the collision is probabilistic: the two wires must
    // interleave between ensureUniqueConnectionSlug and the INSERT. Every round
    // must succeed, so a round that happens not to collide is harmless — but
    // across 15 rounds the race is overwhelmingly likely to fire at least once,
    // and pre-fix it did so in roughly 1 run in 8.
    for (let round = 0; round < 15; round++) {
      const { orgId } = await pollWithCollidingManifests();

      const conns = (await sql`
        SELECT connector_key, slug FROM connections
        WHERE organization_id = ${orgId} AND deleted_at IS NULL
        ORDER BY connector_key
      `) as Array<{ connector_key: string; slug: string }>;

      // Both must be wired. Pre-fix the loser of the slug race was absent here
      // — that absence is the whole defect, and it is what made an unrelated
      // test flake ~1 run in 8.
      expect(
        conns.map((c) => c.connector_key),
        `round ${round}: a connector failed to wire`
      ).toEqual(['apple.collide_one', 'apple.collide_two']);

      // And the retry must resolve the collision by suffixing, not by
      // colliding again — two identical slugs would mean the unique index is
      // not actually enforcing what this test assumes.
      expect(new Set(conns.map((c) => c.slug)).size, `round ${round}: slugs collided`).toBe(2);
    }
  }, 180_000);
});
