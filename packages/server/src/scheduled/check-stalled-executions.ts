/**
 * Scheduled Job: Check Stalled Runs
 *
 * Runs every 5 minutes to detect stalled sync/embed-backfill runs driven by the
 * out-of-process connector-worker daemon. Watcher runs are driven in-process by
 * the embedded Lobu gateway; their lifecycle is handled by WatcherRunTracker
 * and startup reconciliation (see automation.ts and lobu/gateway.ts), with a
 * coarse backstop in sweepStaleWatcherRuns below.
 */

import { getDb } from '../db/client';
import type { Env } from '../index';
import { expireStaleConnectTokens } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import {
  EXECUTING_RUN_STATUSES,
  isExecutingRunStatus,
  runStatusLiteral,
} from '../utils/run-statuses';
import { reconcileWatcherRuns, sweepStaleWatcherRuns } from '../watchers/automation';

export async function checkStalledExecutions(_env: Env) {
  const sql = getDb();

  await reconcileWatcherRuns(sql);
  await sweepStaleWatcherRuns(sql);

    // Find stalled sync/embed_backfill runs (driven by out-of-process workers).
    // Watcher runs are excluded — they run in-process and use tracker-based lifecycle.
    const timedOut = await sql`
      SELECT id, feed_id, connection_id, run_type, claimed_by, last_heartbeat_at, claimed_at,
             organization_id, connector_key, connector_version, watcher_id, approved_input
      FROM runs
      WHERE run_type IN ('sync', 'embed_backfill')
        AND status = ANY(${runStatusLiteral(EXECUTING_RUN_STATUSES)}::text[])
        AND (
          (last_heartbeat_at IS NULL AND COALESCE(claimed_at, created_at) < current_timestamp - INTERVAL '5 minutes')
          OR
          (last_heartbeat_at < current_timestamp - INTERVAL '5 minutes')
        )
    `;

    if (timedOut.length > 0) {
      logger.warn(`[StalledRuns] Detected ${timedOut.length} stalled runs`);

      for (const run of timedOut) {
        const errorMessage =
          run.last_heartbeat_at == null
            ? 'Worker claimed run but never sent heartbeat (5+ minutes)'
            : `Worker heartbeat stopped (last: ${String(run.last_heartbeat_at)})`;

        logger.warn(
          `[StalledRuns] Run ${run.id} (feed ${run.feed_id}, worker ${run.claimed_by}): ${errorMessage}`
        );

        try {
          // Wrap timeout + retry in a transaction so a crash between them
          // cannot leave the run in 'timeout' without a retry being created.
          await sql.begin(async (tx) => {
            // Re-check status inside the transaction to guard against concurrent updates
            const current = await tx`
              SELECT status FROM runs WHERE id = ${run.id} FOR UPDATE
            `;
            if (current.length === 0 || !isExecutingRunStatus(current[0].status)) {
              return; // Already handled by another process
            }

            await tx`
              UPDATE runs
              SET status = 'timeout',
                  completed_at = current_timestamp,
                  error_message = ${errorMessage}
              WHERE id = ${run.id}
            `;

            // Create retry run for sync runs
            if (run.run_type === 'sync' && run.feed_id) {
              try {
                await tx`
                  INSERT INTO runs (
                    organization_id, run_type, feed_id, connection_id,
                    connector_key, connector_version, status, approval_status, created_at
                  ) VALUES (
                    ${run.organization_id}, 'sync', ${run.feed_id}, ${run.connection_id},
                    ${run.connector_key}, ${run.connector_version}, 'pending', 'auto', current_timestamp
                  )
                `;
                logger.info(`[StalledRuns] Created retry run for feed ${run.feed_id}`);
              } catch (retryError) {
                if (isUniqueViolation(retryError, 'idx_runs_active_sync_per_feed')) {
                  logger.info(
                    `[StalledRuns] Skipped retry for feed ${run.feed_id} - another active sync run exists`
                  );
                } else {
                  throw retryError;
                }
              }
            }
          });
        } catch (txError) {
          logger.error({ error: txError, runId: run.id }, '[StalledRuns] Failed to timeout run');
        }

        // Retry embed_backfill runs (scheduler will pick up remaining events next tick)
        if (run.run_type === 'embed_backfill') {
          logger.info(`[StalledRuns] Embed backfill run ${run.id} timed out, scheduler will retry`);
        }
      }
    }

    // Expire stale connect tokens and revoke associated pending_auth connections
    try {
      const expiredCount = await expireStaleConnectTokens();
      if (expiredCount > 0) {
        logger.info(`[StalledRuns] Expired ${expiredCount} stale connect tokens`);
      }
    } catch (connectTokenError) {
      logger.error({ error: connectTokenError }, '[StalledRuns] Error expiring connect tokens');
    }

    // Clean up old completed runs (keep last 30 days).
    // Delete in bounded batches to avoid long-held locks.
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
