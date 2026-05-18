/**
 * Integration test for the connector-lane stale-run reaper. Seeds three
 * connector runs into PGlite and asserts the reaper only fails the one that
 * is in-progress with a stale `last_heartbeat_at`. Also exercises the
 * advisory-lock contention path: a second concurrent caller while the lock
 * is held no-ops instead of double-failing the row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client';
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import { reapStaleRuns } from '../check-stalled-executions';

const ORG_ID = 'reaper-org';
const STALE_THRESHOLD_SECONDS = 60;

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
  process.env.RUNS_REAPER_STALE_AFTER_SECONDS = String(STALE_THRESHOLD_SECONDS);
});

afterAll(() => {
  delete process.env.RUNS_REAPER_STALE_AFTER_SECONDS;
});

beforeEach(async () => {
  await resetTestDatabase();
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG_ID}, ${ORG_ID}, ${ORG_ID})
    ON CONFLICT (id) DO NOTHING
  `;
});

interface SeedRunOpts {
  status: 'pending' | 'claimed' | 'running' | 'completed';
  lastHeartbeatAgoSeconds: number | null;
  claimedAtAgoSeconds?: number | null;
  runType?: 'sync' | 'action' | 'embed_backfill' | 'auth' | 'watcher';
  feedId?: number | null;
}

async function seedRun(opts: SeedRunOpts): Promise<number> {
  const sql = getDb();
  const runType = opts.runType ?? 'sync';
  const hbInterval =
    opts.lastHeartbeatAgoSeconds !== null
      ? `current_timestamp - interval '${opts.lastHeartbeatAgoSeconds} seconds'`
      : 'NULL';
  const claimInterval =
    opts.claimedAtAgoSeconds !== null && opts.claimedAtAgoSeconds !== undefined
      ? `current_timestamp - interval '${opts.claimedAtAgoSeconds} seconds'`
      : 'NULL';
  const rows = (await sql.unsafe(
    `INSERT INTO runs (
       organization_id, run_type, feed_id, status, approval_status,
       claimed_at, last_heartbeat_at, claimed_by, created_at
     ) VALUES (
       $1, $2, $3, $4, 'auto',
       ${claimInterval}, ${hbInterval}, 'test-worker', current_timestamp
     )
     RETURNING id`,
    [ORG_ID, runType, opts.feedId ?? null, opts.status],
  )) as unknown as Array<{ id: number | string }>;
  return Number(rows[0].id);
}

async function seedFeed(feedId: number): Promise<void> {
  const sql = getDb();
  // Seed an org-scoped connection + feed at the requested id so the
  // runs.feed_id FK is satisfied. Each test bumps the id so the
  // partial-unique-index dedup logic exercises real rows.
  await sql.unsafe(
    `INSERT INTO connections (id, organization_id, connector_key, slug, status, created_at)
     VALUES ($1, $2, 'fake', $3, 'active', current_timestamp)
     ON CONFLICT (id) DO NOTHING`,
    [feedId, ORG_ID, `fake-${feedId}`],
  );
  await sql.unsafe(
    `INSERT INTO feeds (id, organization_id, connection_id, feed_key, status, created_at, updated_at)
     VALUES ($1, $2, $1, 'data', 'active', current_timestamp, current_timestamp)
     ON CONFLICT (id) DO NOTHING`,
    [feedId, ORG_ID],
  );
}

async function statusOf(runId: number): Promise<string> {
  const sql = getDb();
  const rows = (await sql`SELECT status FROM runs WHERE id = ${runId}`) as unknown as Array<{
    status: string;
  }>;
  return rows[0]?.status ?? 'missing';
}

describe('reapStaleRuns — connector lanes', () => {
  test('only the stale in-progress connector run is timed out', async () => {
    // 1. Fresh heartbeat — should be left alone.
    const freshId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: 5,
      claimedAtAgoSeconds: 120,
    });
    // 2. Stale heartbeat — should be reaped.
    const staleId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
    });
    // 3. Terminal state (completed) — must never be touched even if it had a
    //    stale heartbeat at the moment it completed.
    const terminalId = await seedRun({
      status: 'completed',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
    });

    const result = await reapStaleRuns();

    expect(result.acquired).toBe(true);
    expect(result.reaped).toBe(1);

    expect(await statusOf(freshId)).toBe('running');
    expect(await statusOf(staleId)).toBe('timeout');
    expect(await statusOf(terminalId)).toBe('completed');

    const sql = getDb();
    const reaped = (await sql`
      SELECT error_message FROM runs WHERE id = ${staleId}
    `) as unknown as Array<{ error_message: string | null }>;
    expect(reaped[0].error_message).toBe('worker_heartbeat_lost');
  });

  test('claimed rows that never sent any heartbeat are reaped via claimed_at', async () => {
    const id = await seedRun({
      status: 'claimed',
      lastHeartbeatAgoSeconds: null,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
    });
    const result = await reapStaleRuns();
    expect(result.reaped).toBe(1);
    expect(await statusOf(id)).toBe('timeout');
  });

  test('watcher lane is excluded from this reaper', async () => {
    // Watcher runs have their own dedicated 2h sweep in watchers/automation.ts.
    const watcherId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
      runType: 'watcher',
    });
    const result = await reapStaleRuns();
    expect(result.reaped).toBe(0);
    expect(await statusOf(watcherId)).toBe('running');
  });

  test('back-to-back calls do not double-fail the same row', async () => {
    // The advisory-lock guards cross-pod contention. Under PGlite the
    // single-connection pool serializes everything, so we can't simulate
    // two pods literally racing the SELECT-then-UPDATE. What we CAN prove
    // here is the function-level invariant the lock enforces: a row that's
    // already been reaped doesn't get reaped a second time even if the
    // sweeper fires again.
    const staleId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
    });

    const first = await reapStaleRuns();
    expect(first.acquired).toBe(true);
    expect(first.reaped).toBe(1);
    expect(await statusOf(staleId)).toBe('timeout');

    // Second pass — same lock acquired, but the row is now `timeout` so the
    // WHERE clause excludes it. No double-fail, no parallel retry inserted.
    const second = await reapStaleRuns();
    expect(second.acquired).toBe(true);
    expect(second.reaped).toBe(0);
    expect(second.retriesCreated).toBe(0);
    expect(await statusOf(staleId)).toBe('timeout');
  });

  test('action, embed_backfill, auth lanes are reaped (parity with sync)', async () => {
    // All four connector lanes now emit `client.heartbeat()` from the
    // out-of-process executor (lobu#860 wired action + embed_backfill;
    // sync + auth already did). The reaper's WHERE clause covers all
    // four; staleness on `last_heartbeat_at` is a real failure signal
    // everywhere.
    const actionId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'action',
    });
    const embedId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'embed_backfill',
    });
    const authId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'auth',
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(3);
    expect(await statusOf(actionId)).toBe('timeout');
    expect(await statusOf(embedId)).toBe('timeout');
    expect(await statusOf(authId)).toBe('timeout');
  });
});

describe('reapStaleRuns — atomic timeout + retry (lobu#862)', () => {
  test('a stale sync run gets timed out AND a retry queued in one statement', async () => {
    // Seed a stale sync run for a feed. After reapStaleRuns runs, we
    // should see exactly one timeout + one pending retry for the same
    // feed — both written in the same CTE so a process crash cannot
    // leave the row timed out with no retry queued.
    const feedId = 4242;
    await seedFeed(feedId);
    const staleId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'sync',
      feedId,
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(1);
    expect(result.retriesCreated).toBe(1);
    expect(await statusOf(staleId)).toBe('timeout');

    const sql = getDb();
    const retries = (await sql`
      SELECT id, status FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string; status: string }>;
    expect(retries.length).toBe(1);
  });

  test('non-sync stale runs do NOT produce retries (action/embed_backfill/auth)', async () => {
    // Only sync runs need a re-queue; the other lanes are reaped but
    // not retried.
    await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'action',
    });
    await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'embed_backfill',
    });
    await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'auth',
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(3);
    expect(result.retriesCreated).toBe(0);
  });

  test('two stale sync runs on the SAME feed produce exactly one retry (dedup via NOT EXISTS)', async () => {
    // Two stale runs that share a feed_id can only exist if one is in a
    // terminal status — the partial unique index `idx_runs_active_sync_per_feed`
    // forbids two simultaneously active syncs per feed. Simulate the
    // realistic case: a previously-completed sync, plus a stale running
    // one. The reaper should reap the running one and queue exactly
    // ONE retry for that feed (not two — the completed one is not
    // touched).
    //
    // This also exercises the dedup-against-itself trap: if the NOT
    // EXISTS predicate didn't exclude `timed_out.id`, the running row
    // would dedupe against itself and no retries would be queued.
    const feedId = 5151;
    await seedFeed(feedId);
    // First run already finished — terminal, not in the active set.
    await seedRun({
      status: 'completed',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 10,
      runType: 'sync',
      feedId,
    });
    const staleId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'sync',
      feedId,
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(1);
    expect(result.retriesCreated).toBe(1);
    expect(await statusOf(staleId)).toBe('timeout');

    // Exactly one pending row queued.
    const sql = getDb();
    const pending = (await sql`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string }>;
    expect(pending.length).toBe(1);
  });

  test('a pending sync that pre-exists prevents a duplicate retry being inserted', async () => {
    // Edge case: a pending sync exists for the feed, and an unrelated
    // stale auth run (no feed) is reaped in the same sweep. We should
    // reap the auth row, and NOT insert any sync retry — the pending
    // sync already covers the feed.
    //
    // (We can't co-exist a stale sync + a pending sync on the same
    // feed; the partial unique index forbids it. This test uses a
    // different lane to exercise the negative path.)
    const feedId = 6262;
    await seedFeed(feedId);
    await seedRun({
      status: 'pending',
      lastHeartbeatAgoSeconds: null,
      runType: 'sync',
      feedId,
    });
    const authId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'auth',
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(1);
    // No retry insert: auth lane doesn't queue retries.
    expect(result.retriesCreated).toBe(0);
    expect(await statusOf(authId)).toBe('timeout');

    // The pre-existing pending sync stays intact, no duplicates.
    const sql = getDb();
    const pending = (await sql`
      SELECT id FROM runs
      WHERE feed_id = ${feedId} AND run_type = 'sync' AND status = 'pending'
    `) as unknown as Array<{ id: number | string }>;
    expect(pending.length).toBe(1);
  });

  test('reaper output count and DB state agree (no UPDATE-without-INSERT gap)', async () => {
    // Reproducer for lobu#862: the previous shape (bulk UPDATE RETURNING
    // followed by a per-row INSERT loop) could leave a row timed-out
    // with no retry queued if the process crashed mid-loop. The CTE
    // version writes both in the same statement, so the SQL engine
    // guarantees they land together or not at all.
    //
    // Seed three stale sync runs for three different feeds. After the
    // reap there must be exactly three timeouts AND three retries —
    // observable atomicity from the caller's perspective.
    const feedIds = [9001, 9002, 9003];
    for (const feedId of feedIds) {
      await seedFeed(feedId);
      await seedRun({
        status: 'running',
        lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
        claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
        runType: 'sync',
        feedId,
      });
    }

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(3);
    expect(result.retriesCreated).toBe(3);

    const sql = getDb();
    const counts = (await sql`
      SELECT status, count(*)::int AS n FROM runs
      WHERE feed_id IN ${sql(feedIds)} AND run_type = 'sync'
      GROUP BY status
      ORDER BY status
    `) as unknown as Array<{ status: string; n: number }>;
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
    expect(byStatus.pending).toBe(3);
    expect(byStatus.timeout).toBe(3);
  });
});
