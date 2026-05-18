/**
 * Stale-run reaper for the connector lanes.
 *
 * `reapStaleRuns()` marks runs as `failed` (or `timeout`, see below) when they
 * are stuck in an in-progress state (`claimed`/`running`) with a
 * `last_heartbeat_at` older than the configured threshold. Connector workers
 * heartbeat every 30s via `/api/workers/heartbeat`; a missed heartbeat means
 * the worker crashed, was OOM-killed, or was scaled down mid-run. Without the
 * reaper those rows sit "running" forever and the feed never gets a retry.
 *
 * Scope:
 *  - `sync`, `action`, `embed_backfill`, `auth` — all driven by the
 *    out-of-process connector-worker daemon and all emit
 *    `client.heartbeat()` from their executors in
 *    packages/connector-worker/src/daemon/executor.ts. PR lobu#859
 *    temporarily narrowed this set to `sync` + `auth` because the action
 *    and embed_backfill executors were silent; lobu#860 wired heartbeats
 *    into both, so the WHERE clause + partial index widen back to the
 *    full four-lane set here. The browser-worker (Chrome) lane runs out
 *    of a service-worker and also heartbeats now (owletto#186) but uses
 *    its own `chrome.alarms` cadence — it shares this WHERE clause.
 *  - `watcher` — driven in-process by the embedded gateway. Lifecycle is
 *    handled by WatcherRunTracker + the dedicated `sweepStaleWatcherRuns` /
 *    `resetOrphanedWatcherRuns` helpers in watchers/automation.ts.
 *  - lobu-queue lanes (`chat_message`, `schedule`, `agent_run`, `internal`,
 *    `task`) — claimed by RunsQueue with its own per-claim heartbeat on
 *    `claimed_at` and own 5-min stale sweep. Not touched here.
 *
 * Multi-pod safety: wrapped in `pg_try_advisory_lock`. A second gateway pod
 * (or the legacy `check-stalled-executions` cron tick) trying to reap
 * concurrently no-ops instead of double-failing rows.
 *
 * The legacy `checkStalledExecutions(env)` entry point is preserved and now
 * delegates to `reapStaleRuns()` so the existing 5-minute TaskScheduler cron
 * still works — the 30s `setInterval` registered in the gateway boot path is
 * the primary cadence.
 */

import type { ReservedSql } from 'postgres';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { expireStaleConnectTokens } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { reconcileWatcherRuns, sweepStaleWatcherRuns } from '../watchers/automation';

/** Advisory-lock key for cross-pod coordination of the stale-run reaper.
 *  Picked from the >2^31 range to avoid collisions with the queue-NOTIFY
 *  channel ids and the due-feeds lock; the high bits are arbitrary. */
const REAPER_ADVISORY_LOCK_KEY = 0x726e7372; // 'rnsr' — runs-reaper

/** Default stale threshold in seconds; override via RUNS_REAPER_STALE_AFTER_SECONDS.
 *  120s leaves room for the 30s worker heartbeat to miss ~3 ticks before
 *  the reaper writes the row off — a real worker stutter (GC pause, network
 *  blip) gets a grace window, but a crashed worker frees the feed within
 *  a couple of minutes instead of five. */
const DEFAULT_STALE_AFTER_SECONDS = 120;

function staleAfterSeconds(): number {
  const raw = Number(process.env.RUNS_REAPER_STALE_AFTER_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_AFTER_SECONDS;
}

export interface ReapStaleRunsResult {
  /** Whether the advisory lock was acquired. False means another pod is
   *  already running the sweep; the caller should treat this as a no-op. */
  acquired: boolean;
  /** Rows transitioned to a terminal state (failed/timeout) this tick. */
  reaped: number;
  /** Retry rows inserted for stalled `sync` runs (one per stalled feed). */
  retriesCreated: number;
}

/**
 * One pass of the stale-run reaper. Idempotent + cheap (single advisory-lock
 * SELECT plus one indexed UPDATE), safe to call on a 30s setInterval.
 */
export async function reapStaleRuns(): Promise<ReapStaleRunsResult> {
  const sql = getDb();
  const thresholdSeconds = staleAfterSeconds();

  // pg_try_advisory_lock is session-scoped — the connection holds the lock
  // until we explicitly release. With postgres.js any random pool connection
  // could serve the lock SELECT and the unlock; we wrap in a single
  // .reserve() so both run on the same physical connection. DbClient doesn't
  // type `reserve()` (it's only on the raw postgres.js surface), so we cast
  // through `unknown` to the postgres.js ReservedSql shape.
  const reserved = (await (
    sql as unknown as { reserve: () => Promise<ReservedSql> }
  ).reserve()) as ReservedSql;
  try {
    const lockRows = (await reserved`
      SELECT pg_try_advisory_lock(${REAPER_ADVISORY_LOCK_KEY}) AS acquired
    `) as unknown as Array<{ acquired: boolean }>;
    const acquired = !!lockRows[0]?.acquired;
    if (!acquired) {
      return { acquired: false, reaped: 0, retriesCreated: 0 };
    }

    try {
      const errorMessage = 'worker_heartbeat_lost';
      // Reap + re-queue in a single statement using a CTE: the UPDATE
      // writes the timeout, and `INSERT ... SELECT ... FROM timed_out`
      // queues a fresh `pending` sync retry for every reaped `sync` row
      // that still has a `feed_id`. Doing both in one statement makes
      // the timeout + retry atomic — if the process crashes after the
      // statement returns, both writes are durable; if it crashes
      // before, neither is. The previous shape (bulk UPDATE RETURNING +
      // per-row INSERT loop) could leave a row in `timeout` with no
      // retry queued when a crash landed between the two writes (lobu#862).
      //
      // The retry INSERT uses `WHERE NOT EXISTS (SELECT 1 FROM runs ...)`
      // to dedupe against any currently-active sync run on the same
      // feed. The partial unique index `idx_runs_active_sync_per_feed`
      // still backs this (it's the same predicate, and the index is
      // what makes the check cheap); the NOT EXISTS shape avoids
      // PostgreSQL `ON CONFLICT` inference quirks against partial
      // unique indexes inside a CTE — which can throw the constraint
      // violation instead of DO NOTHING. NOT EXISTS evaluates the
      // dedup predicate against the same snapshot as the surrounding
      // CTE, so the cross-CTE visibility rule that breaks ON CONFLICT
      // doesn't apply here.
      //
      // The advisory lock still serialises cross-pod sweeps — the CTE
      // narrows the window to "one transaction tick" but doesn't replace
      // the lock.
      const reaped = (await reserved`
        WITH timed_out AS (
          UPDATE public.runs
          SET status = 'timeout',
              completed_at = current_timestamp,
              error_message = ${errorMessage}
          WHERE run_type IN ('sync', 'action', 'embed_backfill', 'auth')
            AND status IN ('claimed', 'running')
            AND (
              (last_heartbeat_at IS NULL
               AND COALESCE(claimed_at, created_at)
                   < current_timestamp - (${thresholdSeconds}::int * interval '1 second'))
              OR
              (last_heartbeat_at IS NOT NULL
               AND last_heartbeat_at
                   < current_timestamp - (${thresholdSeconds}::int * interval '1 second'))
            )
          RETURNING id, run_type, feed_id, connection_id, connector_key, connector_version, organization_id
        ),
        retries AS (
          INSERT INTO public.runs (
            organization_id, run_type, feed_id, connection_id,
            connector_key, connector_version, status, approval_status, created_at
          )
          SELECT
            t.organization_id, 'sync', t.feed_id, t.connection_id,
            t.connector_key, t.connector_version, 'pending', 'auto', current_timestamp
          FROM timed_out t
          WHERE t.run_type = 'sync'
            AND t.feed_id IS NOT NULL
            AND NOT EXISTS (
              -- Look for an unrelated active sync run on the same feed.
              -- Exclude timed_out.id because in PostgreSQL the sibling
              -- CTE UPDATE is not visible here (all CTEs see the same
              -- snapshot), so the row we just reaped still appears as
              -- running. Without this exclusion, every reap would
              -- dedupe against itself and no retries would ever land.
              SELECT 1 FROM public.runs r
              WHERE r.feed_id = t.feed_id
                AND r.run_type = 'sync'
                AND r.status IN ('pending', 'claimed', 'running')
                AND r.id NOT IN (SELECT id FROM timed_out)
            )
          RETURNING id, feed_id
        )
        SELECT
          (SELECT count(*)::int FROM timed_out) AS reaped,
          (SELECT count(*)::int FROM retries) AS retries_created,
          (SELECT count(*)::int FROM timed_out
            WHERE run_type = 'sync' AND feed_id IS NOT NULL) AS sync_eligible
      `) as unknown as Array<{
        reaped: number;
        retries_created: number;
        sync_eligible: number;
      }>;

      const reapedRow = reaped[0];
      const reapedCount = reapedRow?.reaped ?? 0;
      const retriesCreated = reapedRow?.retries_created ?? 0;
      const syncEligible = reapedRow?.sync_eligible ?? 0;

      if (reapedCount === 0) {
        return { acquired: true, reaped: 0, retriesCreated: 0 };
      }

      logger.warn(
        { reaped: reapedCount, retriesCreated, thresholdSeconds },
        '[reaper] Marked stale connector runs as timeout (worker_heartbeat_lost)'
      );

      // Surface the conflict-dedup count so operators can spot when two
      // pods are competing for the same stale row across an advisory-
      // lock release boundary (the only case where `ON CONFLICT DO
      // NOTHING` should fire on the partial unique index). The delta is
      // sync-eligible reaped rows that did not produce a retry insert.
      const skippedRetries = syncEligible - retriesCreated;
      if (skippedRetries > 0) {
        logger.info(
          { count: skippedRetries },
          '[reaper] Skipped sync retries — another active sync run exists (ON CONFLICT DO NOTHING)'
        );
      }

      return { acquired: true, reaped: reapedCount, retriesCreated };
    } finally {
      await reserved`SELECT pg_advisory_unlock(${REAPER_ADVISORY_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}

/** How often the gateway-boot setInterval calls `reapStaleRuns`. */
const REAP_INTERVAL_MS = 30_000;

/**
 * Start the 30s reaper interval. Returns a teardown function — call it from
 * the gateway's shutdown path so the interval doesn't keep the process alive.
 * Repeat invocations are a no-op; one interval per process.
 */
let activeInterval: ReturnType<typeof setInterval> | null = null;

export function startStaleRunReaper(): () => void {
  if (activeInterval) {
    return () => stopStaleRunReaper();
  }
  const tick = async () => {
    try {
      await reapStaleRuns();
    } catch (err) {
      logger.warn({ err }, '[reaper] tick failed');
    }
  };
  // Fire once on boot so a crash-recovered gateway clears the queue without
  // waiting a full interval.
  void tick();
  activeInterval = setInterval(tick, REAP_INTERVAL_MS);
  if (typeof activeInterval.unref === 'function') {
    activeInterval.unref();
  }
  return stopStaleRunReaper;
}

export function stopStaleRunReaper(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
}

/**
 * Legacy entry point used by the 5-minute `check-stalled-executions`
 * TaskScheduler cron. Delegates to `reapStaleRuns` and keeps the surrounding
 * housekeeping (watcher reconcile + stale watcher sweep + connect-token
 * expiry + 30-day retention) that the cron has owned all along. The 30s
 * setInterval handles the hot path; the cron is the periodic backstop for
 * the housekeeping that doesn't justify a separate interval.
 *
 * Returns the legacy "stalled count" only so existing log lines / metrics
 * downstream of the cron keep their shape.
 */
export async function checkStalledExecutions(_env: Env): Promise<void> {
  const sql = getDb();

  await reconcileWatcherRuns(sql);
  await sweepStaleWatcherRuns(sql);

  await reapStaleRuns();

  try {
    const expiredCount = await expireStaleConnectTokens();
    if (expiredCount > 0) {
      logger.info(`[StalledRuns] Expired ${expiredCount} stale connect tokens`);
    }
  } catch (connectTokenError) {
    logger.error({ error: connectTokenError }, '[StalledRuns] Error expiring connect tokens');
  }

  // Clean up old completed runs (keep last 30 days). Delete in bounded
  // batches to avoid long-held locks.
  const deleted = await sql`
    DELETE FROM runs
    WHERE id IN (
      SELECT id FROM runs
      WHERE status IN ('completed', 'failed', 'timeout', 'cancelled')
        AND completed_at < current_timestamp - INTERVAL '30 days'
      LIMIT 1000
    )
  `;
  if (deleted.count > 0) {
    logger.info(`[StalledRuns] Cleaned up ${deleted.count} old runs (> 30 days)`);
  }
}
