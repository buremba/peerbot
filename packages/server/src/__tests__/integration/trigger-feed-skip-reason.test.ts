/**
 * `trigger_feed` must say WHY no run was queued.
 *
 * `createSyncRun` declines for five distinct reasons — an active run already
 * exists, the feed is gone, the connector is cloud-restricted, the connector was
 * uninstalled, or its version has no runnable code — and it used to signal all
 * five with a bare `null`. `handleTriggerFeed` rendered that as:
 *
 *     "Sync already pending or running for this feed"
 *
 * which is true for exactly one of them. For the other four an operator is told
 * to wait for a run that does not exist and never will. This is not
 * hypothetical: it cost a debugging cycle in this repo when a fixture created a
 * globally-scoped connector definition, `resolveActiveConnectorVersion` found
 * nothing for the org, the feed was soft-deleted as an orphan, and the tool
 * reported a pending sync.
 *
 * The uninstalled-connector case is the one asserted here because it is the one
 * that actually misled someone, and because it is reachable without stubbing
 * `createSyncRun` — the whole point is to exercise the real skip path rather
 * than a mocked return value.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { manageFeeds } from '../../tools/admin/manage_feeds';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  seedOwnerContext,
} from '../setup/test-fixtures';

async function seedFeed(opts: { orgScopedDefinition: boolean }) {
  const sql = getTestDb();
  const { org, ctx } = await seedOwnerContext();

  await createTestConnectorDefinition({
    key: 'rss',
    name: 'RSS',
    // The switch under test. Org-scoped resolves and the run queues; global-only
    // is invisible to resolveActiveConnectorVersion, which retires the feed as
    // an orphan and declines — the case that used to report "already pending".
    ...(opts.orgScopedDefinition ? { organization_id: org.id } : {}),
  });
  const conn = await createTestConnection({
    organization_id: org.id,
    connector_key: 'rss',
    slug: `rss-skip-${opts.orgScopedDefinition ? 'ok' : 'orphan'}`,
  });

  const feed = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, checkpoint, created_at, updated_at)
    VALUES
      (${org.id}, ${conn.id}, 'items', 'active', ${sql.json({ cursor: 'c0' })}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;

  return { feedId: Number(feed[0].id), ctx };
}

describe('trigger_feed skip reasons', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('does not claim a sync is pending when the connector is uninstalled', async () => {
    const { feedId, ctx } = await seedFeed({ orgScopedDefinition: false });

    const res = (await manageFeeds(
      { action: 'trigger_feed', feed_id: feedId },
      {} as Env,
      ctx
    )) as { action?: string; message?: string; triggered?: boolean };

    expect(res.triggered).toBeUndefined();
    // The actionable part: name the real cause.
    expect(res.message).toContain('no longer installed');
    // And explicitly NOT the old catch-all, which sent operators off to wait
    // for a run that was never created.
    expect(res.message).not.toContain('already pending');
  });

  it('still reports a genuine duplicate as already pending', async () => {
    const { feedId, ctx } = await seedFeed({ orgScopedDefinition: true });

    const first = (await manageFeeds(
      { action: 'trigger_feed', feed_id: feedId },
      {} as Env,
      ctx
    )) as { triggered?: boolean; run_id?: number };
    expect(first.triggered).toBe(true);

    // Second trigger while the first run is still active — this is the one
    // case the old message was right about, and it must stay right.
    const second = (await manageFeeds(
      { action: 'trigger_feed', feed_id: feedId },
      {} as Env,
      ctx
    )) as { message?: string; triggered?: boolean };

    expect(second.triggered).toBeUndefined();
    expect(second.message).toContain('already pending or running');
  });
});
