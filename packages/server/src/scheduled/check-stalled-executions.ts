/**
 * Stale-run reaper for the connector lanes.
 *
 * `reapStaleRuns()` marks runs as `timeout` when they are never claimed before
 * the configured threshold, or are stuck `claimed`/`running` with a stale
 * liveness timestamp. Connector workers
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
 *    handled by the durable terminal-event resolution (run-completion.ts)
 *    + the dedicated `sweepStaleWatcherRuns` / `resetOrphanedWatcherRuns`
 *    helpers in watchers/automation.ts.
 *  - lobu-queue lanes (`chat_message`, `schedule`, `agent_run`, `internal`,
 *    `task`) — claimed by RunsQueue with its own per-claim heartbeat on
 *    `claimed_at` and own 5-min stale sweep. Not touched here.
 *
 * Multi-pod safety: wrapped in `pg_try_advisory_lock`. A second gateway pod
 * trying to reap concurrently no-ops instead of double-failing rows.
 *
 * Cadence: `reapStaleRuns()` is owned by exactly ONE caller — the 30s
 * `setInterval` started by `startStaleRunReaper` in the gateway boot path
 * (server-lifecycle.ts). The 5-minute `checkStalledExecutions` cron no longer
 * calls it (the two firing it was redundant); the cron now only does the
 * surrounding housekeeping (watcher reconcile/sweep, connect-token expiry,
 * 30-day retention).
 */

import type { ReservedSql } from 'postgres';
import { maybeEmitFeedAutoPausedAfterFailure } from '../behaviors/platform-events';
import { intervals } from '../config/intervals';
import { feedBackoff } from '../connectors/feed-backoff';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { classifyRunOutcome } from '../runs/run-outcome';
import {
  supersedeActionEvent,
  terminalizeApprovalRunCompleted,
} from '../tools/admin/approval-events';
import { expireStaleConnectTokens } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { reconcileWatcherRuns, sweepStaleWatcherRuns } from '../watchers/automation';
import { buildStaleRunWhereSql } from './stale-run-sweeper';

/** Advisory-lock key for cross-pod coordination of the stale-run reaper.
 *  Picked from the >2^31 range to avoid collisions with the queue-NOTIFY
 *  channel ids and the due-feeds lock; the high bits are arbitrary. */
const REAPER_ADVISORY_LOCK_KEY = 0x726e7372; // 'rnsr' — runs-reaper

interface ReapStaleRunsResult {
  /** Whether the advisory lock was acquired. False means another pod is
   *  already running the sweep; the caller should treat this as a no-op. */
  acquired: boolean;
  /** Rows transitioned to a terminal state (failed/timeout) this tick. */
  reaped: number;
  /** Retry rows inserted for stalled claimed/running sync runs (never pending). */
  retriesCreated: number;
}

/**
 * One pass of the stale-run reaper. Idempotent + cheap (single advisory-lock
 * SELECT plus one indexed UPDATE), safe to call on a 30s setInterval.
 */
export async function reapStaleRuns(): Promise<ReapStaleRunsResult> {
  const sql = getDb();
  const thresholdSeconds = intervals.runsReaperStaleAfterSeconds;

  // Shared staleness predicate (scheduled/stale-run-sweeper.ts). Connector
  // claims don't stamp a heartbeat, so any non-NULL `last_heartbeat_at` means
  // the executor beat at least once; rows with none are judged on
  // COALESCE(claimed_at, created_at). One threshold covers both paths.
  const staleWhereSql = buildStaleRunWhereSql({
    runTypes: ['sync', 'action', 'embed_backfill', 'auth'],
    heartbeatSemantics: 'any-heartbeat',
    heartbeatStaleInterval: `${thresholdSeconds} seconds`,
    coarseStaleInterval: `${thresholdSeconds} seconds`,
    includePending: true,
  });

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
      const heartbeatErrorMessage = 'worker_heartbeat_lost';
      const claimErrorMessage = 'worker_claim_timeout';
      // Failure-backoff / auto-pause policy shared with the completion path
      // (run-lifecycle.ts) so both apply identical math (item 5, #2033).
      const backoffBaseMs = feedBackoff.baseMs;
      const backoffMaxMs = feedBackoff.maxMs;
      const pauseThreshold = feedBackoff.pauseThreshold;

      // Approval-gated action runs have a durable card, so their timeout must
      // supersede that card in the SAME transaction as the runs write. Process
      // this rare lane separately from the bulk connector CTE below: one
      // corrupt/missing card then rolls back only its own run and cannot block
      // sync retries or other stale actions. The UPDATE reasserts the complete
      // staleness predicate, so a worker heartbeat/completion that wins after
      // the candidate read makes this a no-op rather than being overwritten.
      const approvedActionCandidates = (await reserved`
        SELECT id, organization_id, action_key, action_output
        FROM public.runs
        WHERE ${reserved.unsafe(staleWhereSql)}
          AND run_type = 'action'
          AND approval_status = 'approved'
        ORDER BY id
      `) as unknown as Array<{
        id: number | string;
        organization_id: string;
        action_key: string | null;
        action_output: Record<string, unknown> | null;
      }>;
      let approvalActionsReaped = 0;
      for (const candidate of approvedActionCandidates) {
        const runId = Number(candidate.id);
        try {
          // A claimed action run with a DURABLE action_output already persisted
          // is a terminalization-PENDING row: the external mutation succeeded
          // and only the 'completed' card write failed. Complete it from the
          // durable output — reporting a FALSE timeout here would mislabel an
          // already-successful mutation as a failure. The completion is guarded
          // (status='running' AND approval_status='approved') and shares its tx
          // with the card, so a concurrent human retry or another pod's reaper
          // tick cannot double-finalize, and a card failure rolls it back for
          // the next tick to retry.
          if (candidate.action_output != null) {
            const actionKey = candidate.action_key ?? 'Action';
            const eventId = await terminalizeApprovalRunCompleted(
              runId,
              candidate.organization_id,
              candidate.action_output,
              {
                title: `${actionKey} — completed`,
                content: `Operation completed: ${actionKey}`,
              },
              null,
              sql
            );
            if (eventId !== null) approvalActionsReaped += 1;
            continue;
          }

          const didReap = await sql.begin(async (tx) => {
            const rows = await tx.unsafe<{
              organization_id: string;
              action_key: string | null;
            }>(
              `UPDATE public.runs
               SET status = 'timeout',
                   outcome = $2,
                   completed_at = current_timestamp,
                   error_message = $3
               WHERE id = $1
                 AND run_type = 'action'
                 AND approval_status = 'approved'
                 AND ${staleWhereSql}
               RETURNING organization_id, action_key`,
              [
                runId,
                classifyRunOutcome({ status: 'timeout' }),
                heartbeatErrorMessage,
              ]
            );
            if (rows.length === 0) return false;

            const actionKey = rows[0].action_key ?? 'Action';
            const eventId = await supersedeActionEvent(
              runId,
              rows[0].organization_id,
              'failed',
              `${actionKey} — timed out`,
              `Action timed out: ${actionKey} — ${heartbeatErrorMessage}`,
              {
                error_message: heartbeatErrorMessage,
                run_status: 'timeout',
              },
              null,
              tx
            );
            if (eventId === undefined) {
              throw new Error(
                `Cannot time out approval run ${runId}: its approval card is missing`
              );
            }
            return true;
          });
          if (didReap) approvalActionsReaped += 1;
        } catch (error) {
          logger.error(
            { run_id: runId, error: String(error) },
            '[reaper] Failed to atomically time out approved action run'
          );
        }
      }

      // Reap + recover in a single statement using CTEs. Claimed/running sync
      // rows get one fresh retry; never-claimed rows are finalized on the feed
      // without a retry because another pending row would only repeat the same
      // unavailable-worker failure. Doing this in one statement makes
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
        WITH stale_candidates AS (
          SELECT id, status AS stale_status
          FROM public.runs
          WHERE ${reserved.unsafe(staleWhereSql)}
            AND NOT (run_type = 'action' AND approval_status = 'approved')
          FOR UPDATE SKIP LOCKED
        ),
        timed_out AS (
          UPDATE public.runs r
          SET status = 'timeout',
              outcome = ${classifyRunOutcome({ status: "timeout" })},
              completed_at = current_timestamp,
              error_message = CASE
                WHEN c.stale_status = 'pending' THEN ${claimErrorMessage}
                ELSE ${heartbeatErrorMessage}
              END
          FROM stale_candidates c
          WHERE r.id = c.id
          RETURNING r.id, r.run_type, r.feed_id, r.connection_id, r.connector_key,
                    r.connector_version, r.organization_id, r.dry_run, c.stale_status
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
            AND t.stale_status IN ('claimed', 'running')
            AND t.feed_id IS NOT NULL
            -- Never retry a dry run. This INSERT does not carry the dry_run
            -- flag, so a retried dry run would come back as a REAL sync that
            -- persists everything the operator asked to only preview. A dry
            -- run is also an interactive one-shot — reaping it as 'timeout'
            -- and letting the operator re-trigger is the correct outcome.
            AND NOT t.dry_run
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
        ),
        finalized_pending_feeds AS (
          -- Never-claimed sync runs (device/worker offline). Without a
          -- next_run_at backoff these feeds re-enqueue every plain cadence
          -- (check-due-feeds picks next_run_at <= now()), so an offline device
          -- gets hammered every 5 min forever. Apply the SAME exponential
          -- backoff as the completion path (feed-backoff.ts), computed from the
          -- post-increment failure count, and hard-pause past the threshold
          -- (the feeds trigger nulls next_run_at on status='paused').
          UPDATE public.feeds f
          SET last_sync_at = current_timestamp,
              last_sync_status = 'failed',
              last_error = ${claimErrorMessage},
              consecutive_failures = f.consecutive_failures + 1,
              first_failure_at = COALESCE(f.first_failure_at, current_timestamp),
              status = CASE
                WHEN f.consecutive_failures + 1 >= ${pauseThreshold} THEN 'paused'
                ELSE f.status
              END,
              next_run_at = CASE
                WHEN f.consecutive_failures + 1 >= ${pauseThreshold} THEN NULL
                ELSE GREATEST(
                  COALESCE(f.next_run_at, current_timestamp),
                  current_timestamp + (LEAST(
                    ${backoffBaseMs}::bigint * (2 ^ LEAST(f.consecutive_failures, 30))::bigint,
                    ${backoffMaxMs}::bigint
                  ) || ' milliseconds')::interval
                )
              END,
              updated_at = current_timestamp
          FROM timed_out t
          WHERE t.run_type = 'sync'
            AND t.stale_status = 'pending'
            -- A never-claimed dry run must not stamp the feed failed, back off
            -- next_run_at, or auto-pause — those record the outcome of REAL
            -- syncs, which a dry run leaves untouched (see runs.dry_run).
            AND NOT t.dry_run
            AND t.feed_id = f.id
          RETURNING f.id, f.consecutive_failures, f.status
        )
        SELECT
          (SELECT count(*)::int FROM timed_out) AS reaped,
          (SELECT count(*)::int FROM retries) AS retries_created,
          (SELECT count(*)::int FROM timed_out
            WHERE run_type = 'sync'
              AND stale_status IN ('claimed', 'running')
              AND feed_id IS NOT NULL
              -- Same NOT dry_run predicate as the retries CTE. A dry run is
              -- never eligible for retry, so counting it here would inflate
              -- skippedRetries below and attribute the skip to "another
              -- active sync run exists", which would be false.
              AND NOT dry_run) AS sync_eligible,
          (SELECT coalesce(
             json_agg(json_build_object(
               'id', id,
               'consecutive_failures', consecutive_failures
             )),
             '[]'::json
           )
           FROM finalized_pending_feeds
           WHERE status = 'paused'
             AND consecutive_failures = ${pauseThreshold}
          ) AS auto_paused_feeds
      `) as unknown as Array<{
        reaped: number;
        retries_created: number;
        sync_eligible: number;
        auto_paused_feeds: unknown;
      }>;

      const reapedRow = reaped[0];
      const reapedCount =
        approvalActionsReaped + (reapedRow?.reaped ?? 0);
      const retriesCreated = reapedRow?.retries_created ?? 0;
      const syncEligible = reapedRow?.sync_eligible ?? 0;

      if (reapedCount === 0) {
        return { acquired: true, reaped: 0, retriesCreated: 0 };
      }

      // Threshold-crossing hard pauses from the never-claimed path → Behavior signal.
      const autoPausedRaw = reapedRow?.auto_paused_feeds;
      const autoPausedList: Array<{ id: number; consecutive_failures: number }> =
        Array.isArray(autoPausedRaw)
          ? (autoPausedRaw as Array<{ id: number; consecutive_failures: number }>)
          : typeof autoPausedRaw === 'string'
            ? (JSON.parse(autoPausedRaw) as Array<{
                id: number;
                consecutive_failures: number;
              }>)
            : [];
      for (const paused of autoPausedList) {
        void maybeEmitFeedAutoPausedAfterFailure({
          feedId: Number(paused.id),
          consecutiveFailures: Number(paused.consecutive_failures),
          pauseThreshold,
        }).catch((err) => {
          logger.error(
            { feed_id: paused.id, error: String(err) },
            '[reaper] maybeEmitFeedAutoPausedAfterFailure threw',
          );
        });
      }

      logger.warn(
        {
          reaped: reapedCount,
          approvalActionsReaped,
          retriesCreated,
          thresholdSeconds,
        },
        '[reaper] Marked stale connector runs as timeout'
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
  activeInterval = setInterval(tick, intervals.runsReaperTickMs);
  if (typeof activeInterval.unref === 'function') {
    activeInterval.unref();
  }
  return stopStaleRunReaper;
}

function stopStaleRunReaper(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
}

/**
 * Periodic housekeeping run by the 5-minute `check-stalled-executions`
 * TaskScheduler cron: watcher reconcile + stale watcher sweep + connect-token
 * expiry + 30-day retention. These don't justify a dedicated interval each.
 *
 * Stale-run reaping is NOT done here — it is owned exclusively by the 30s
 * `startStaleRunReaper` setInterval (server-lifecycle.ts), which is the single
 * reaper cadence. Both calling `reapStaleRuns()` was redundant.
 */
export async function checkStalledExecutions(_env: Env): Promise<void> {
  const sql = getDb();

  // Isolate each phase so a throw in one (e.g. the `malformed array literal`
  // bug, lobu#1046) doesn't disable the rest of the housekeeping.
  try {
    await reconcileWatcherRuns(sql);
  } catch (error) {
    logger.error({ error }, '[StalledRuns] reconcileWatcherRuns failed');
  }
  try {
    await sweepStaleWatcherRuns(sql);
  } catch (error) {
    logger.error({ error }, '[StalledRuns] sweepStaleWatcherRuns failed');
  }

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
