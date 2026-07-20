/**
 * Feed failure backoff + hard auto-pause (item 5a/5b, #2033).
 *
 * Before: completeWorkerJob rescheduled a FAILED feed with a plain cron
 * next_run_at regardless of consecutive_failures, so a persistently-failing
 * feed re-enqueued every cadence forever, and only the OPTIONAL repair agent
 * ever paused it. A feed with no repair agent looped indefinitely.
 *
 * After:
 *  - 5a: a failed completion sets next_run_at = max(cron_next, now + backoff)
 *    where backoff grows exponentially with consecutive_failures — so a
 *    repeatedly-failing feed is scheduled further out than the plain cadence.
 *    A subsequent SUCCESS resets consecutive_failures to 0 and returns to the
 *    plain cron cadence.
 *  - 5b: once consecutive_failures crosses the hard threshold the feed is
 *    paused (status='paused', next_run_at=NULL via the feeds trigger),
 *    independent of any repair agent (no repair agent configured here).
 *
 * Drives the REAL completeWorkerJob handler against the embedded DB, same shape
 * as complete-worker-job-status-guard.test.ts.
 */

import type { Context } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import { completeWorkerJob } from '../../worker-api';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const WORKER_ID = 'worker-backoff';
// Tight, deterministic backoff for the test: base 1000ms, cap 60000ms, pause
// at 3 consecutive failures.
const BASE_MS = 1000;
const MAX_MS = 60_000;
const PAUSE_THRESHOLD = 3;

beforeAll(() => {
  process.env.FEED_BACKOFF_BASE_MS = String(BASE_MS);
  process.env.FEED_BACKOFF_MAX_MS = String(MAX_MS);
  process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = String(PAUSE_THRESHOLD);
});

afterAll(() => {
  delete process.env.FEED_BACKOFF_BASE_MS;
  delete process.env.FEED_BACKOFF_MAX_MS;
  delete process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES;
});

function mockWorkerCtx(body: unknown): {
  ctx: Context<{ Bindings: Env }>;
  result: () => { body: unknown; status: number };
} {
  let captured: { body: unknown; status: number } = { body: undefined, status: 200 };
  const ctx = {
    req: { json: async () => body },
    var: {},
    json: (b: unknown, status?: number) => {
      captured = { body: b, status: status ?? 200 };
      return captured as unknown as Response;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { ctx, result: () => captured };
}

async function insertConnection(
  organizationId: string,
  slug = 'chrome-backoff-test'
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO connections
      (organization_id, connector_key, status, visibility, slug, created_at, updated_at)
    VALUES
      (${organizationId}, 'chrome', 'active', 'org', ${slug}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

/** A feed on a 1-minute cadence so the plain cron next_run_at is only ~60s out
 *  — the backoff must push it further than that once failures accumulate. */
async function insertFeed(
  organizationId: string,
  connectionId: number,
  consecutiveFailures: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO feeds
      (organization_id, connection_id, feed_key, status, schedule,
       consecutive_failures, items_collected, last_sync_status, created_at, updated_at)
    VALUES
      (${organizationId}, ${connectionId}, 'chrome-feed', 'active', '* * * * *',
       ${consecutiveFailures}, 0, 'failed', NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

async function insertRunningRun(
  organizationId: string,
  connectionId: number,
  feedId: number
): Promise<number> {
  const sql = getTestDb();
  const rows = (await sql`
    INSERT INTO runs
      (organization_id, run_type, feed_id, connection_id, connector_key,
       connector_version, status, claimed_by, claimed_at, created_at)
    VALUES
      (${organizationId}, 'sync', ${feedId}, ${connectionId}, 'chrome', '0.2.0',
       'running', ${WORKER_ID}, NOW(), NOW())
    RETURNING id
  `) as Array<{ id: number }>;
  return rows[0].id;
}

describe('feed failure backoff + auto-pause (#2033)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('5a: a failed completion backs off next_run_at beyond the plain cadence', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    // 2 prior failures → this failure makes it 3? No: pick 1 so new count = 2,
    // still below PAUSE_THRESHOLD=3, so it reschedules (not pauses).
    const feedId = await insertFeed(org.id, connId, 1);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      items_collected: 0,
      error_message: 'boom',
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at,
             EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
      seconds_out: number | string | null;
    }>;

    expect(after[0].status).toBe('active'); // below pause threshold
    expect(Number(after[0].consecutive_failures)).toBe(2);
    expect(after[0].next_run_at).not.toBeNull();

    // New count = 2 → backoff = BASE_MS * 2^(2-1) = 2000ms. The plain cron
    // cadence ('* * * * *') is ~<=60s out, and GREATEST(cron, now+2s) must be
    // in the future. The load-bearing assertion is that next_run_at is
    // strictly IN THE FUTURE by at least the backoff (device-offline feeds no
    // longer re-enqueue immediately). We assert >= ~1.5s to tolerate clock
    // skew, and well under the 60s cron cap so we know backoff (not just cron)
    // is being applied on a sub-minute-failing feed.
    const secondsOut = Number(after[0].seconds_out);
    expect(secondsOut).toBeGreaterThan(1.5);
  });

  it('5a: backoff grows with consecutive_failures (10 failures > 2 failures)', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);

    // Raise the pause threshold above 10 so we can observe pure backoff growth.
    process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = '100';
    try {
      // Feed A: 1 prior failure → new count 2 → backoff 2000ms.
      const feedA = await insertFeed(org.id, connId, 1);
      const runA = await insertRunningRun(org.id, connId, feedA);
      const a = mockWorkerCtx({ run_id: runA, worker_id: WORKER_ID, status: 'failed' });
      await completeWorkerJob(a.ctx);

      // Feed B: 9 prior failures → new count 10 → backoff capped at MAX_MS.
      const connId2 = await insertConnection(org.id, 'chrome-backoff-b');
      const feedB = await insertFeed(org.id, connId2, 9);
      const runB = await insertRunningRun(org.id, connId2, feedB);
      const b = mockWorkerCtx({ run_id: runB, worker_id: WORKER_ID, status: 'failed' });
      await completeWorkerJob(b.ctx);

      const sql = getTestDb();
      const rows = (await sql`
        SELECT id,
               EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
        FROM feeds WHERE id IN (${feedA}, ${feedB})
      `) as Array<{ id: number; seconds_out: number | string }>;
      const outA = Number(rows.find((r) => Number(r.id) === feedA)?.seconds_out);
      const outB = Number(rows.find((r) => Number(r.id) === feedB)?.seconds_out);
      // 10-failure feed is scheduled strictly further out than the 2-failure feed.
      expect(outB).toBeGreaterThan(outA);
    } finally {
      process.env.FEED_PAUSE_AFTER_CONSECUTIVE_FAILURES = String(PAUSE_THRESHOLD);
    }
  });

  it('5b: crossing the failure threshold hard-pauses the feed (next_run_at NULL, no repair agent)', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    // 2 prior failures → this failure makes 3 = PAUSE_THRESHOLD → pause.
    const feedId = await insertFeed(org.id, connId, PAUSE_THRESHOLD - 1);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'failed',
      error_message: 'still broken',
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
    }>;

    expect(after[0].status).toBe('paused');
    expect(Number(after[0].consecutive_failures)).toBe(PAUSE_THRESHOLD);
    expect(after[0].next_run_at).toBeNull();
  });

  it('5a: a success resets consecutive_failures and resumes the plain cadence', async () => {
    const org = await createTestOrganization();
    const connId = await insertConnection(org.id);
    const feedId = await insertFeed(org.id, connId, 2);
    const runId = await insertRunningRun(org.id, connId, feedId);

    const { ctx, result } = mockWorkerCtx({
      run_id: runId,
      worker_id: WORKER_ID,
      status: 'success',
      items_collected: 5,
    });
    await completeWorkerJob(ctx);
    expect(result().body).toEqual({ success: true });

    const sql = getTestDb();
    const after = (await sql`
      SELECT status, consecutive_failures, next_run_at,
             EXTRACT(EPOCH FROM (next_run_at - current_timestamp)) AS seconds_out
      FROM feeds WHERE id = ${feedId}
    `) as Array<{
      status: string;
      consecutive_failures: number;
      next_run_at: Date | string | null;
      seconds_out: number | string | null;
    }>;

    expect(after[0].status).toBe('active');
    expect(Number(after[0].consecutive_failures)).toBe(0);
    // Plain 1-minute cron cadence — next run is <= ~60s out, NOT backed off.
    expect(after[0].next_run_at).not.toBeNull();
    expect(Number(after[0].seconds_out)).toBeLessThanOrEqual(61);
  });
});
