/**
 * Scheduled Job: Check Stalled Runs
 *
 * Runs every 5 minutes to detect runs that:
 * 1. Were started by a worker but never sent a heartbeat (5+ minutes)
 * 2. Stopped sending heartbeats (5+ minutes since last heartbeat)
 *
 * Marks them as 'timeout' and creates new pending run for retry (sync only).
 */

import { getDb } from '../db/client';
import type { Env } from '../index';
import { expireStaleConnectTokens } from '../utils/connect-tokens';
import logger from '../utils/logger';
import { isUniqueViolation } from '../utils/pg-errors';
import { createWatcherRun } from '../utils/queue-helpers';
import {
  EXECUTING_RUN_STATUSES,
  isExecutingRunStatus,
  runStatusLiteral,
} from '../utils/run-statuses';
import {
  findWatcherWindowIdForPayload,
  parseWatcherRunPayload,
  reconcileWatcherRuns,
} from '../watchers/automation';

export async function checkStalledExecutions(_env: Env) {
  const sql = getDb();

  await reconcileWatcherRuns(sql);

    // Find stalled runs that are still considered executing, including legacy claimed rows.
    const timedOut = await sql`
      SELECT id, feed_id, connection_id, run_type, claimed_by, last_heartbeat_at, claimed_at,
             organization_id, connector_key, connector_version, watcher_id, approved_input
      FROM runs
      WHERE status = ANY(${runStatusLiteral(EXECUTING_RUN_STATUSES)}::text[])
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

            if (run.run_type === 'watcher') {
              const payload = parseWatcherRunPayload(run.approved_input);
              if (!payload) {
                await tx`
                  UPDATE runs
                  SET status = 'failed',
                      completed_at = current_timestamp,
                      error_message = 'Watcher run timed out with an invalid dispatch payload.'
                  WHERE id = ${run.id}
                `;
                return;
              }

              const existingWindowId = await findWatcherWindowIdForPayload(tx, payload);
              if (existingWindowId) {
                await tx`
                  UPDATE runs
                  SET status = 'completed',
                      window_id = ${existingWindowId},
                      completed_at = current_timestamp,
                      error_message = NULL
                  WHERE id = ${run.id}
                `;
                return;
              }
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

            if (run.run_type === 'watcher' && run.watcher_id) {
              const payload = parseWatcherRunPayload(run.approved_input);
              if (!payload) {
                return;
              }

              try {
                const retryResult = await createWatcherRun(
                  {
                    organizationId: run.organization_id,
                    watcherId: run.watcher_id,
                    agentId: payload.agent_id,
                    windowStart: payload.window_start,
                    windowEnd: payload.window_end,
                    dispatchSource: payload.dispatch_source,
                  },
                  tx
                );

                if (retryResult.created) {
                  logger.info(
                    `[StalledRuns] Created retry watcher run ${retryResult.runId} for watcher ${run.watcher_id}`
                  );
                } else {
                  logger.info(
                    `[StalledRuns] Reused watcher run ${retryResult.runId} for watcher ${run.watcher_id}`
                  );
                }
              } catch (retryError) {
                if (isUniqueViolation(retryError, 'idx_runs_active_watcher_per_watcher')) {
                  logger.info(
                    `[StalledRuns] Skipped watcher retry for watcher ${run.watcher_id} - another active watcher run exists`
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
