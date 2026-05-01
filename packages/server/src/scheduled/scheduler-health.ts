/**
 * Scheduler Health Check
 *
 * Provides metrics and health status for the feed/run scheduling system.
 * Used for monitoring and alerting when the scheduler stops working.
 */

import { getDb } from '../db/client';
import type { Env } from '../index';
import logger from '../utils/logger';
import { EXECUTING_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

interface SchedulerHealthStatus {
  healthy: boolean;
  issues: string[];
  metrics: {
    activeFeeds: number;
    overdueFeeds: number;
    overdueByHours: number;
    pendingRuns: number;
    runningRuns: number;
    lastRunCreatedAt: string | null;
    lastSuccessfulRun: string | null;
    runsLast24h: {
      success: number;
      failed: number;
      timeout: number;
    };
  };
}

const OVERDUE_THRESHOLD_HOURS = 1; // Alert if feeds are overdue by more than 1 hour
const EXECUTION_GAP_THRESHOLD_HOURS = 2; // Alert if no runs are created in 2 hours

export async function getSchedulerHealth(_env: Env): Promise<SchedulerHealthStatus> {
  const sql = getDb();
  const issues: string[] = [];

  try {
    // Get feed counts
    const feedStats = await sql`
      SELECT
        CAST(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS INTEGER) as active_feeds,
        CAST(SUM(CASE WHEN status = 'active' AND next_run_at < current_timestamp THEN 1 ELSE 0 END) AS INTEGER) as overdue_feeds,
        MAX(CASE
          WHEN status = 'active' AND next_run_at < current_timestamp
            THEN EXTRACT(EPOCH FROM (current_timestamp - next_run_at)) / 3600.0
          ELSE NULL
        END) as max_overdue_hours
      FROM feeds
      WHERE deleted_at IS NULL
    `;

    const activeFeeds = Number(feedStats[0]?.active_feeds || 0);
    const overdueFeeds = Number(feedStats[0]?.overdue_feeds || 0);
    const overdueByHours = Number(feedStats[0]?.max_overdue_hours || 0);

    // Get run counts
    const runStats = await sql`
      SELECT
        CAST(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS INTEGER) as pending,
        CAST(SUM(CASE WHEN status = ANY(${runStatusLiteral(EXECUTING_RUN_STATUSES)}::text[]) THEN 1 ELSE 0 END) AS INTEGER) as running,
        MAX(CASE WHEN status = 'pending' THEN created_at ELSE NULL END) as last_pending_created,
        MAX(CASE WHEN status = 'completed' THEN completed_at ELSE NULL END) as last_success
      FROM runs
      WHERE run_type = 'sync'
    `;

    const pendingRuns = Number(runStats[0]?.pending || 0);
    const runningRuns = Number(runStats[0]?.running || 0);
    const lastPendingRaw = runStats[0]?.last_pending_created;
    const lastSuccessRaw = runStats[0]?.last_success;
    const lastRunCreatedAt = lastPendingRaw ? String(lastPendingRaw) : null;
    const lastSuccessfulRun = lastSuccessRaw ? String(lastSuccessRaw) : null;

    // Get run counts for last 24 hours
    const recentStats = await sql`
      SELECT
        CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS INTEGER) as success,
        CAST(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS INTEGER) as failed,
        CAST(SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS INTEGER) as timeout
      FROM runs
      WHERE run_type = 'sync'
        AND completed_at > current_timestamp - INTERVAL '24 hours'
    `;

    const runsLast24h = {
      success: Number(recentStats[0]?.success || 0),
      failed: Number(recentStats[0]?.failed || 0),
      timeout: Number(recentStats[0]?.timeout || 0),
    };

    // Check for issues
    if (overdueByHours > OVERDUE_THRESHOLD_HOURS) {
      issues.push(`${overdueFeeds} feeds overdue by up to ${overdueByHours.toFixed(1)} hours`);
    }

    if (lastRunCreatedAt) {
      const hoursSinceLastRun =
        (Date.now() - new Date(lastRunCreatedAt).getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastRun > EXECUTION_GAP_THRESHOLD_HOURS && overdueFeeds > 0) {
        issues.push(
          `No new runs created in ${hoursSinceLastRun.toFixed(1)} hours despite ${overdueFeeds} overdue feeds`
        );
      }
    } else if (overdueFeeds > 0) {
      issues.push(`No pending runs exist despite ${overdueFeeds} overdue feeds`);
    }

    if (runsLast24h.timeout > runsLast24h.success) {
      issues.push(
        `More timeouts (${runsLast24h.timeout}) than successes (${runsLast24h.success}) in last 24h`
      );
    }

    const healthy = issues.length === 0;

    if (!healthy) {
      logger.warn({ issues }, '[SchedulerHealth] Health check failed');
    }

    return {
      healthy,
      issues,
      metrics: {
        activeFeeds,
        overdueFeeds,
        overdueByHours: Math.round(overdueByHours * 10) / 10,
        pendingRuns,
        runningRuns,
        lastRunCreatedAt,
        lastSuccessfulRun,
        runsLast24h,
      },
    };
  } catch (error) {
    logger.error({ error }, '[SchedulerHealth] Failed to get health status');
    return {
      healthy: false,
      issues: [`Failed to query scheduler health: ${(error as Error).message}`],
      metrics: {
        activeFeeds: 0,
        overdueFeeds: 0,
        overdueByHours: 0,
        pendingRuns: 0,
        runningRuns: 0,
        lastRunCreatedAt: null,
        lastSuccessfulRun: null,
        runsLast24h: { success: 0, failed: 0, timeout: 0 },
      },
    };
  }
}
