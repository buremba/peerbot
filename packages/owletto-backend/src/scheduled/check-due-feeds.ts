/**
 * Scheduled Job: Check Due Feeds
 *
 * Runs every minute to find active feeds where next_run_at <= NOW()
 * and creates pending sync runs for them.
 *
 * Primary feed scheduler for the V1 integration platform.
 */

import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { createSyncRun } from '../utils/queue-helpers';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

interface CheckDueFeedsResult {
  dueFeeds: number;
  runsCreated: number;
  skipped: number;
}

interface DueFeedRow {
  id: number;
  organization_id: string;
  connection_id: number;
  feed_key: string;
  connector_key: string;
}

export async function materializeDueFeeds(env: Env, db?: DbClient): Promise<CheckDueFeedsResult> {
  const sql = db ?? getDb();

  const dueFeedRows = await sql<DueFeedRow>`
    SELECT f.id, f.organization_id, f.connection_id, f.feed_key, c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.status = 'active'
      AND c.status = 'active'
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.next_run_at <= current_timestamp
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.feed_id = f.id
          AND r.run_type = 'sync'
          AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      )
    ORDER BY f.next_run_at ASC
    LIMIT 100
  `;

  if (dueFeedRows.length === 0) {
    return { dueFeeds: 0, runsCreated: 0, skipped: 0 };
  }

  logger.info(`[CheckDueFeeds] Found ${dueFeedRows.length} due feeds`);

  let runsCreated = 0;
  let skipped = 0;

  for (const feed of dueFeedRows) {
    try {
      const runId = await createSyncRun(feed.id, env, sql);
      if (runId === null) {
        skipped++;
      } else {
        runsCreated++;
        logger.debug(
          `[CheckDueFeeds] Created run ${runId} for feed ${feed.id} (${feed.connector_key}/${feed.feed_key})`
        );
      }
    } catch (error) {
      logger.error({ error, feedId: feed.id }, '[CheckDueFeeds] Failed to create run');
    }
  }

  if (runsCreated > 0) {
    logger.info(`[CheckDueFeeds] Created ${runsCreated} runs (${skipped} skipped due to race)`);
  }

  return { dueFeeds: dueFeedRows.length, runsCreated, skipped };
}

