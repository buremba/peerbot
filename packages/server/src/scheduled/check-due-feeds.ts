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
import { createSyncRun } from '../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { materializeDueItems } from './due-materializer';

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

  const counts = await materializeDueItems<DueFeedRow>({
    label: 'CheckDueFeeds',
    fetchDue: () => sql<DueFeedRow>`
      SELECT f.id, f.organization_id, f.connection_id, f.feed_key, c.connector_key
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE f.status = 'active'
        AND c.status = 'active'
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
        -- Virtual feeds are read LIVE at request time (query()/search()), never
        -- synced — exclude them from the sync scheduler entirely.
        AND f.virtual IS NOT TRUE
        AND f.next_run_at <= current_timestamp
        AND NOT EXISTS (
          SELECT 1 FROM runs r
          WHERE r.feed_id = f.id
            AND r.run_type = 'sync'
            AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        )
      ORDER BY f.next_run_at ASC
      LIMIT 100
    `,
    onFound: (feeds) => {
      logger.info(`[CheckDueFeeds] Found ${feeds.length} due feeds`);
    },
    createRun: async (feed) => {
      const runId = await createSyncRun(feed.id, env, sql);
      if (runId === null) return 'skipped';
      logger.debug(
        `[CheckDueFeeds] Created run ${runId} for feed ${feed.id} (${feed.connector_key}/${feed.feed_key})`
      );
      return 'created';
    },
    onError: (feed, error) => {
      logger.error({ error, feedId: feed.id }, '[CheckDueFeeds] Failed to create run');
    },
    onDone: ({ runsCreated, skipped }) => {
      if (runsCreated > 0) {
        logger.info(`[CheckDueFeeds] Created ${runsCreated} runs (${skipped} skipped due to race)`);
      }
    },
  });

  return { dueFeeds: counts.due, runsCreated: counts.runsCreated, skipped: counts.skipped };
}

