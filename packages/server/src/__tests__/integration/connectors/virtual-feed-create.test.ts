/**
 * manage_feeds create_feed — VIRTUAL feed creation (PR #1702).
 *
 * A virtual feed is read LIVE and never synced, so create_feed must:
 *  - require config.query (the pushdown predicate readVirtualFeed reads);
 *  - persist kind='virtual', virtual=true, and schedule/next_run_at = NULL;
 *  - NOT validate the (irrelevant) sync schedule — a bad/absent schedule string
 *    must not gate a virtual feed's creation. This is the ordering fix: schedule
 *    validation used to run before the isVirtual branch, wrongly rejecting
 *    create_feed({ virtual:true, schedule:'not-a-cron' }).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { materializeDueFeeds } from '../../../scheduled/check-due-feeds';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection, createTestOrganization, createTestUser } from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('manage_feeds create_feed (virtual)', () => {
  let owner: TestApiClient;
  let orgId: string;
  let connectionId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Virtual Create Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'vcreate@test.com' });
    owner = await TestApiClient.for({ organizationId: org.id, userId: user.id, memberRole: 'owner' });
    const conn = await createTestConnection({
      organization_id: orgId,
      connector_key: 'github',
      created_by: user.id,
      createDefaultFeed: false,
    });
    connectionId = Number(conn.id);
  });

  it('creates a virtual feed with schedule/next_run_at NULL and kind=virtual', async () => {
    const result = (await owner.feeds.create({
      connection_id: connectionId,
      feed_key: 'issues',
      virtual: true,
      config: { query: 'is:issue is:open' },
    })) as { error?: string; feed?: { id: number; kind: string; virtual: boolean; schedule: string | null; next_run_at: string | null } };

    expect(result.error).toBeUndefined();
    expect(result.feed?.kind).toBe('virtual');
    expect(result.feed?.virtual).toBe(true);
    expect(result.feed?.schedule).toBeNull();
    expect(result.feed?.next_run_at).toBeNull();
  });

  it('rejects a virtual feed with no config.query', async () => {
    const result = (await owner.feeds.create({
      connection_id: connectionId,
      feed_key: 'issues',
      virtual: true,
    })) as { error?: string; feed?: unknown };

    expect(result.error).toMatch(/requires config\.query/i);
    expect(result.feed).toBeUndefined();
  });

  it('does NOT validate the sync schedule for a virtual feed (ordering fix)', async () => {
    // A malformed schedule string that validateSchedule would reject — it must be
    // ignored because a virtual feed persists schedule = NULL.
    const result = (await owner.feeds.create({
      connection_id: connectionId,
      feed_key: 'issues',
      virtual: true,
      schedule: 'not-a-cron-expression',
      config: { query: 'is:issue' },
    })) as { error?: string; feed?: { schedule: string | null } };

    expect(result.error).toBeUndefined();
    expect(result.feed?.schedule).toBeNull();
  });

  it('still validates the schedule for a NON-virtual feed', async () => {
    const result = (await owner.feeds.create({
      connection_id: connectionId,
      feed_key: 'issues',
      schedule: 'not-a-cron-expression',
    })) as { error?: string };

    expect(result.error).toBeTruthy();
  });

  it('materializeDueFeeds never creates a sync run for the virtual feed', async () => {
    const created = (await owner.feeds.create({
      connection_id: connectionId,
      feed_key: 'issues',
      virtual: true,
      config: { query: 'is:issue is:open' },
    })) as { feed?: { id: number } };
    const feedId = Number(created.feed?.id);

    // Force the virtual feed "due" (past next_run_at) so the `virtual` guard —
    // not a NULL schedule — is what excludes it, then run the scheduler.
    const sql = getTestDb();
    await sql`UPDATE feeds SET next_run_at = NOW() - INTERVAL '1 minute' WHERE id = ${feedId}`;
    await materializeDueFeeds({} as Env, sql);

    const [runs] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM runs WHERE feed_id = ${feedId} AND run_type = 'sync'
    `;
    expect(Number(runs?.n)).toBe(0);
  });
});
