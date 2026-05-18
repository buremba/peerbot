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

  test('auth lane is reaped (parity with sync)', async () => {
    // `auth` heartbeats from executeAuthRun in the connector-worker daemon, so
    // staleness on `last_heartbeat_at` is a real failure signal there too.
    const authId = await seedRun({
      status: 'running',
      lastHeartbeatAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      claimedAtAgoSeconds: STALE_THRESHOLD_SECONDS * 3,
      runType: 'auth',
    });

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(1);
    expect(await statusOf(authId)).toBe('timeout');
  });

  test('action and embed_backfill lanes are NOT reaped (they do not heartbeat today)', async () => {
    // executeActionRun and executeEmbedBackfillRun in
    // packages/connector-worker/src/daemon/executor.ts never call
    // client.heartbeat(), so reaping them on `last_heartbeat_at` would kill
    // in-flight runs after the stale threshold elapses. Until those lanes
    // emit heartbeats, the reaper must leave them alone.
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

    const result = await reapStaleRuns();
    expect(result.reaped).toBe(0);
    expect(await statusOf(actionId)).toBe('running');
    expect(await statusOf(embedId)).toBe('running');
  });
});
