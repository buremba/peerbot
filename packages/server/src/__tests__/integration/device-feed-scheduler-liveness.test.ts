/**
 * Scheduled feed materialization must respect the liveness of a connection's
 * pinned device. An offline device cannot claim the run, so queueing one only
 * creates a worker_claim_timeout failure episode. The feed stays overdue while
 * the device is offline and is materialized as soon as that device polls again.
 *
 * Only EXECUTION pins defer. A chrome-extension pin on a non-chrome connector
 * is browser affinity — worker-api/poll.ts keeps that parent sync on the fleet
 * and refuses it on the extension's own claim lane — so those feeds keep
 * syncing while the browser is closed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { materializeDueFeeds } from '../../scheduled/check-due-feeds';
import { getSchedulerHealth } from '../../scheduled/scheduler-health';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../../utils/device-liveness';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

describe('scheduled feed device liveness', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('defers only an offline execution pin, and only until that device polls again', async () => {
    const sql = getTestDb();
    const { org, user } = await seedOwnerContext({
      orgName: 'Device Feed Scheduler Org',
    });

    async function createDevice(
      label: string,
      staleSeconds: number,
      platform: 'macos' | 'chrome-extension' | null = 'macos'
    ): Promise<string> {
      const [device] = (await sql`
        INSERT INTO device_workers (
          user_id, worker_id, platform, capabilities, label,
          organization_id, last_seen_at
        ) VALUES (
          ${user.id}, ${`worker-${label}`}, ${platform}, ${sql.json([])},
          ${label}, ${org.id},
          current_timestamp - make_interval(secs => ${staleSeconds})
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      return device.id;
    }

    async function createDueFeed(connectorKey: string, deviceId?: string): Promise<number> {
      await createTestConnectorDefinition({
        key: connectorKey,
        name: connectorKey,
        feeds_schema: { items: { description: 'Items' } },
        organization_id: org.id,
      });
      const connection = await createTestConnection({
        organization_id: org.id,
        connector_key: connectorKey,
        created_by: user.id,
        createDefaultFeed: false,
      });
      if (deviceId) {
        await sql`
          UPDATE connections
          SET device_worker_id = ${deviceId}::uuid
          WHERE id = ${connection.id}
        `;
      }
      const [feed] = (await sql`
        INSERT INTO feeds (
          organization_id, connection_id, feed_key, status, kind, virtual,
          schedule, next_run_at, created_at, updated_at
        ) VALUES (
          ${org.id}, ${connection.id}, 'items', 'active', 'collected', false,
          '* * * * *', current_timestamp - INTERVAL '5 minutes',
          current_timestamp, current_timestamp
        )
        RETURNING id
      `) as unknown as Array<{ id: number }>;
      return Number(feed.id);
    }

    const staleDeviceId = await createDevice('Stale Mac', DEVICE_ONLINE_WINDOW_SECONDS + 60);
    const onlineDeviceId = await createDevice('Online Mac', 5);
    const staleBrowserId = await createDevice(
      'Closed Chrome',
      DEVICE_ONLINE_WINDOW_SECONDS + 60,
      'chrome-extension'
    );
    const staleLegacyDeviceId = await createDevice(
      'Legacy Device',
      DEVICE_ONLINE_WINDOW_SECONDS + 60,
      null
    );
    const staleFeedId = await createDueFeed('test.scheduler-stale-device', staleDeviceId);
    const onlineFeedId = await createDueFeed('test.scheduler-online-device', onlineDeviceId);
    const affinityFeedId = await createDueFeed('test.scheduler-affinity', staleBrowserId);
    await createDueFeed('test.scheduler-legacy-device', staleLegacyDeviceId);
    const unpinnedFeedId = await createDueFeed('test.scheduler-unpinned');
    const [staleBefore] = await sql`
      SELECT next_run_at FROM feeds WHERE id = ${staleFeedId}
    `;

    const firstPass = await materializeDueFeeds({} as Env, sql);
    expect(firstPass).toEqual({ dueFeeds: 3, runsCreated: 3, skipped: 0 });

    const firstRuns = (await sql`
      SELECT feed_id FROM runs
      WHERE run_type = 'sync'
      ORDER BY feed_id
    `) as unknown as Array<{ feed_id: number }>;
    expect(firstRuns.map((run) => Number(run.feed_id))).toEqual(
      [onlineFeedId, affinityFeedId, unpinnedFeedId].sort((a, b) => a - b)
    );

    const [staleDeferred] = await sql`
      SELECT next_run_at, last_sync_status
      FROM feeds
      WHERE id = ${staleFeedId}
    `;
    expect(new Date(String(staleDeferred.next_run_at)).getTime()).toBe(
      new Date(String(staleBefore.next_run_at)).getTime()
    );
    expect(staleDeferred.last_sync_status).toBeNull();

    // A deferred feed sits past next_run_at for as long as its device is away,
    // so /health/scheduler must not read that as a stalled scheduler. Keep an
    // online-pinned feed equally overdue to prove the filter does not hide
    // genuine scheduler lag along with intentional device deferrals.
    await sql`
      UPDATE feeds
      SET next_run_at = current_timestamp - INTERVAL '2 hours'
      WHERE id IN (${staleFeedId}, ${onlineFeedId})
    `;
    const health = await getSchedulerHealth({} as Env);
    expect(health.metrics.overdueFeeds).toBe(1);
    expect(health.metrics.overdueByHours).toBeGreaterThan(1);
    expect(health.issues.filter((issue) => issue.includes('overdue'))).toHaveLength(1);

    // Restore the online feed's materialized schedule before checking that the
    // newly-live stale device alone becomes eligible on the next pass.
    await sql`
      UPDATE feeds
      SET next_run_at = current_timestamp + INTERVAL '1 hour'
      WHERE id = ${onlineFeedId}
    `;

    await sql`
      UPDATE device_workers
      SET last_seen_at = current_timestamp
      WHERE id = ${staleDeviceId}::uuid
    `;
    const refreshedPass = await materializeDueFeeds({} as Env, sql);
    expect(refreshedPass).toEqual({ dueFeeds: 1, runsCreated: 1, skipped: 0 });

    const finalRuns = (await sql`
      SELECT feed_id, COUNT(*)::int AS count
      FROM runs
      WHERE run_type = 'sync'
      GROUP BY feed_id
      ORDER BY feed_id
    `) as unknown as Array<{ feed_id: number; count: number }>;
    expect(
      Object.fromEntries(finalRuns.map((run) => [Number(run.feed_id), Number(run.count)]))
    ).toEqual({
      [staleFeedId]: 1,
      [onlineFeedId]: 1,
      [affinityFeedId]: 1,
      [unpinnedFeedId]: 1,
    });
  });
});
