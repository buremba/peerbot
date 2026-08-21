/**
 * Auto-wire of a manifest feed declared `virtual: true`.
 *
 * `feeds.kind` is IMMUTABLE — nothing converts a collected feed to virtual in
 * place — so a connector that wants both a durable history and a live read must
 * declare TWO feed keys, and reconcile has to create each with the right kind at
 * INSERT time. Before this, every declared feed was inserted `collected` with a
 * due time, so a virtual feed would have been scheduled for syncs no device can
 * serve while its live-read path stayed unreachable.
 *
 * The second thing pinned here is the `recall` seed. A JSON Schema `default` is
 * documentation: validation never writes it back, so `feeds.config` stays NULL —
 * and `search_memory`'s virtual fan-out selects on `config->>'recall' = 'true'`
 * off the COLUMN. Without materializing the default at create, ambient recall
 * would silently never reach the Mac, however the manifest advertises itself.
 *
 * Driven through the real `/api/workers/poll` with the SHIPPING manifest, so a
 * manifest edit that drops `virtual` or the `recall` default fails here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecureToken } from '../../auth/oauth/utils';
import type { Env } from '../../index';
import { materializeDueFeeds } from '../../scheduled/check-due-feeds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { post } from '../setup/test-helpers';

const CONNECTOR_KEY = 'whatsapp.local';
const COLLECTED_FEED = 'messages';
const VIRTUAL_FEED = 'messages_live';

const MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../owletto/apps/mac/Owletto/ConnectorManifests/whatsapp_local.json'
);

/**
 * The owletto submodule is a private repo, so contributor sandboxes without
 * access cannot init it. Skip there — but in CI (which checks it out) a missing
 * manifest must FAIL, not skip, or a broken checkout silently drops coverage.
 */
const itWithManifest = existsSync(MANIFEST_PATH) ? it : process.env.CI ? it : it.skip;

function shippingManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
}

async function seedDeviceOwner() {
  const sql = getTestDb();
  const userId = `user_${generateSecureToken(4)}`;
  const orgId = `org-wa-virtual-${generateSecureToken(4)}`;
  const workerId = `wk-${generateSecureToken(6)}`;
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, 'WA Owner', ${`${userId}@test.local`}, true, NOW(), NOW())
  `;
  await sql`
    INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
    VALUES (${orgId}, 'WA Org', ${orgId}, 'private',
            ${sql.json({ personal_org_for_user_id: userId })}, NOW())
  `;
  await sql`
    INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
    VALUES (${`mem_${generateSecureToken(4)}`}, ${orgId}, ${userId}, 'owner', NOW())
  `;
  await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, app_version, capabilities, label, organization_id)
    VALUES (${userId}, ${workerId}, 'macos', '9.9.0', ${sql.json([])}, 'Test Mac', ${orgId})
  `;
  return { userId, orgId, workerId };
}

async function pollWithManifest(workerId: string, manifests: unknown[]) {
  const response = await post('/api/workers/poll', {
    body: {
      worker_id: workerId,
      platform: 'macos',
      app_version: '9.9.0',
      label: 'Test Mac',
      capabilities: { whatsapp_local: true },
      connector_manifests: manifests,
    },
  });
  expect(response.status).toBe(200);
  return response;
}

interface FeedRow {
  display_name: string | null;
  feed_key: string;
  kind: string;
  virtual: boolean;
  schedule: string | null;
  next_run_at: Date | string | null;
  config: Record<string, unknown> | null;
}

async function readFeeds(orgId: string): Promise<Record<string, FeedRow>> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT f.feed_key, f.display_name, f.kind, f.virtual, f.schedule, f.next_run_at, f.config
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE c.organization_id = ${orgId} AND c.connector_key = ${CONNECTOR_KEY}
      AND f.deleted_at IS NULL
    ORDER BY f.feed_key
  `) as unknown as FeedRow[];
  return Object.fromEntries(rows.map((row) => [row.feed_key, row]));
}

/** Feed keys the sync scheduler has minted a run for in this org. */
async function syncedFeedKeys(orgId: string): Promise<string[]> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT DISTINCT f.feed_key
    FROM runs r
    JOIN feeds f ON f.id = r.feed_id
    WHERE r.organization_id = ${orgId} AND r.run_type = 'sync'
    ORDER BY f.feed_key
  `) as unknown as Array<{ feed_key: string }>;
  return rows.map((row) => row.feed_key);
}

describe('device manifest auto-wire — virtual feeds', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.LOBU_CLOUD_MODE;
    delete process.env.WORKER_API_TOKEN;
  });
  afterEach(async () => {
    await cleanupTestDatabase();
  });

  itWithManifest(
    'wires the shipping manifest into a collected feed AND a virtual feed opted into recall',
    async () => {
      const { orgId, workerId } = await seedDeviceOwner();
      await pollWithManifest(workerId, [shippingManifest()]);

      const feeds = await readFeeds(orgId);
      expect(Object.keys(feeds).sort()).toEqual([COLLECTED_FEED, VIRTUAL_FEED]);

      // The existing collected feed is untouched by any of this: it keeps its
      // durable events + person attribution, and it stays schedulable.
      const collected = feeds[COLLECTED_FEED];
      expect(collected.kind).toBe('collected');
      expect(collected.virtual).toBe(false);
      // `recall` is seeded for the LIVE feed only — turning ambient recall on
      // for a collected feed would mean nothing (it is already indexed) and the
      // seed must not leak across feed keys.
      expect(collected.config ?? {}).not.toHaveProperty('recall');

      // Two feeds on one connector need two LEGIBLE names. Falling back to the
      // connector's own name (`WhatsApp (this Mac)`) for both would leave the
      // user two identical rows and no way to tell which one is live — and the
      // manifest already declares the distinguishing names.
      expect(collected.display_name).toBe('Messages');

      const live = feeds[VIRTUAL_FEED];
      expect(live.display_name).toBe('Messages (live)');
      expect(live.kind).toBe('virtual');
      expect(live.virtual).toBe(true);
      expect(live.schedule).toBeNull();
      expect(live.next_run_at).toBeNull();
      // The gate search_memory actually reads, materialized onto the column.
      expect(live.config?.recall).toBe(true);

      // The property the NULL due time exists for: the scheduler picks up the
      // collected feed and never the virtual one. A virtual feed with a due
      // time would mint sync runs no device can serve, failing the feed on
      // every tick.
      await materializeDueFeeds({} as Env, getTestDb());
      expect(await syncedFeedKeys(orgId)).toEqual([COLLECTED_FEED]);
    }
  );

  itWithManifest('is idempotent — a second poll does not give the virtual feed a due time', async () => {
    const { orgId, workerId } = await seedDeviceOwner();
    await pollWithManifest(workerId, [shippingManifest()]);
    await pollWithManifest(workerId, [shippingManifest()]);

    const feeds = await readFeeds(orgId);
    expect(feeds[VIRTUAL_FEED].next_run_at).toBeNull();
    expect(feeds[VIRTUAL_FEED].kind).toBe('virtual');
    expect(feeds[VIRTUAL_FEED].config?.recall).toBe(true);
    // The seed is CREATE-only: a user who turns recall off keeps it off.
    const sql = getTestDb();
    await sql`
      UPDATE feeds SET config = ${sql.json({ recall: false })}
      WHERE feed_key = ${VIRTUAL_FEED}
        AND connection_id IN (
          SELECT id FROM connections
          WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
        )
    `;
    await pollWithManifest(workerId, [shippingManifest()]);
    expect((await readFeeds(orgId))[VIRTUAL_FEED].config?.recall).toBe(false);
  });

  itWithManifest(
    'leaves an existing feed alone when its kind disagrees with the manifest',
    async () => {
      const { orgId, workerId } = await seedDeviceOwner();
      await pollWithManifest(workerId, [shippingManifest()]);

      // Simulate a row created before the manifest declared this key virtual:
      // it has collected history and a scheduled time. Keep that time in the
      // future so this test isolates manifest reconciliation from the poller's
      // separate responsibility to materialize genuinely due collected feeds.
      // Reconcile must not convert it
      // (that would strand its events behind a live-read path) and must not
      // clear its schedule while leaving it collected (that would freeze it).
      const sql = getTestDb();
      const dueAt = new Date('2099-08-19T00:00:00Z');
      await sql`
        UPDATE feeds SET kind = 'collected', virtual = false, next_run_at = ${dueAt}
        WHERE feed_key = ${VIRTUAL_FEED}
          AND connection_id IN (
            SELECT id FROM connections
            WHERE organization_id = ${orgId} AND connector_key = ${CONNECTOR_KEY}
          )
      `;

      await pollWithManifest(workerId, [shippingManifest()]);

      const feeds = await readFeeds(orgId);
      expect(feeds[VIRTUAL_FEED].kind).toBe('collected');
      expect(feeds[VIRTUAL_FEED].virtual).toBe(false);
      expect(new Date(feeds[VIRTUAL_FEED].next_run_at as string).toISOString()).toBe(
        dueAt.toISOString()
      );
    }
  );
});
