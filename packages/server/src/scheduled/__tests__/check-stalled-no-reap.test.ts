/**
 * F15: the 5-minute `checkStalledExecutions` cron must NOT reap stale runs.
 *
 * Stale-run reaping used to fire from BOTH the 30s `startStaleRunReaper`
 * setInterval AND this cron. The cron's `reapStaleRuns()` call was removed so
 * the 30s interval is the single reaper cadence. This test pins that:
 *
 *   - a stale in-progress run is NOT failed/timed-out by checkStalledExecutions
 *     (the cron no longer reaps), but
 *   - the cron's OTHER housekeeping still runs — an old completed run past the
 *     30-day retention window IS deleted.
 *
 * `reapStaleRuns()` itself is covered by stale-run-reaper.test.ts; here we only
 * assert the cron stopped owning the reap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup';
import { checkStalledExecutions } from '../check-stalled-executions';

const ORG_ID = 'no-reap-org';
const STALE_THRESHOLD_SECONDS = 60;

beforeAll(async () => {
  await ensureDbForGatewayTests();
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

async function statusOf(runId: number): Promise<string> {
  const sql = getDb();
  const rows = (await sql`SELECT status FROM runs WHERE id = ${runId}`) as unknown as Array<{
    status: string;
  }>;
  return rows[0]?.status ?? 'missing';
}

describe('checkStalledExecutions — no longer reaps (F15)', () => {
  test('leaves a stale in-progress run running, but still deletes runs past 30-day retention', async () => {
    const sql = getDb();

    // A stale, in-progress sync run — old enough that reapStaleRuns WOULD fail
    // it, but the cron must NOT touch it anymore.
    const staleRows = (await sql.unsafe(
      `INSERT INTO runs (
         organization_id, run_type, status, approval_status,
         claimed_at, last_heartbeat_at, claimed_by, created_at
       ) VALUES (
         $1, 'sync', 'running', 'auto',
         current_timestamp - interval '600 seconds',
         current_timestamp - interval '600 seconds',
         'test-worker', current_timestamp - interval '600 seconds'
       )
       RETURNING id`,
      [ORG_ID],
    )) as unknown as Array<{ id: number | string }>;
    const staleRunId = Number(staleRows[0].id);

    // An old, completed run past the 30-day retention window — the cron's
    // housekeeping delete should still remove it.
    const oldRows = (await sql.unsafe(
      `INSERT INTO runs (
         organization_id, run_type, status, approval_status,
         completed_at, created_at
       ) VALUES (
         $1, 'sync', 'completed', 'auto',
         current_timestamp - interval '40 days',
         current_timestamp - interval '40 days'
       )
       RETURNING id`,
      [ORG_ID],
    )) as unknown as Array<{ id: number | string }>;
    const oldRunId = Number(oldRows[0].id);

    await checkStalledExecutions({} as Env);

    // The stale in-progress run is UNTOUCHED — the cron no longer reaps.
    expect(await statusOf(staleRunId)).toBe('running');

    // Housekeeping preserved: the >30-day completed run is gone.
    const oldStatus = await statusOf(oldRunId);
    expect(oldStatus).toBe('missing');
  });
});
