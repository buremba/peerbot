/**
 * TaskScheduler boot + periodic platform-internal jobs.
 *
 * Each job is a standalone task with its own cron schedule, durable as a row
 * in `public.runs` (run_type='task'). Cross-pod coordination is the
 * runs-queue claim path — no per-job advisory locks.
 */

import type { Env } from '@lobu/owletto-sdk';
import type { CoreServices } from '../gateway/services/core-services';
import { cleanupExpiredMcpSessions } from '../mcp-handler';
import logger from '../utils/logger';
import {
  dispatchPendingWatcherRuns,
  materializeDueWatcherRuns,
  reconcileWatcherRuns,
  resetOrphanedWatcherRuns,
} from '../watchers/automation';
import { checkStalledExecutions } from './check-stalled-executions';
import { runClassificationReconciliation } from './classification-reconciliation';
import { TaskScheduler } from './task-scheduler';
import { triggerEmbedBackfill } from './trigger-embed-backfill';

/**
 * Construct the TaskScheduler, register every periodic task, start dispatch,
 * and wire the lazy at-use-time refresh hooks into AuthProfilesManager.
 * Single call site for both `server.ts` (prod) and `start-local.ts` (PGlite).
 */
export async function bootTaskScheduler(
  coreServices: CoreServices,
  env: Env,
): Promise<TaskScheduler> {
  const scheduler = new TaskScheduler(coreServices.getQueue());
  registerMaintenanceTasks(scheduler, env, coreServices);
  await scheduler.start();

  // AuthProfilesManager.ensureFreshCredential is a no-op until these hooks
  // are wired; during the brief startup window before scheduler.start()
  // returns, the periodic safety-net is the only refresh path.
  const authProfilesManager = coreServices.getAuthProfilesManager();
  if (authProfilesManager) {
    authProfilesManager.setLazyRefreshHooks({
      triggerAsync: async (userId, agentId) => {
        await scheduler.spawn(
          'refresh-token-for-user-agent',
          { userId, agentId },
          { idempotencyKey: `refresh-token:${userId}:${agentId}` },
        );
      },
      refreshNow: (userId, agentId) =>
        coreServices.getTokenRefreshJob().refreshForUserAgent(userId, agentId),
    });
  }

  return scheduler;
}

function registerMaintenanceTasks(
  scheduler: TaskScheduler,
  env: Env,
  coreServices: CoreServices,
): void {
  // OAuth token refresh — periodic safety-net at 30min intervals. The hot path
  // is at-use-time lazy refresh in AuthProfilesManager.ensureFreshCredential,
  // which spawns `refresh-token-for-user-agent` per-user when a soon-expiring
  // token is read. This periodic scan only catches users who haven't accessed
  // the system in a while.
  scheduler.register(
    'token-refresh',
    () => coreServices.getTokenRefreshJob().runOnce(),
    { cron: '*/30 * * * *' },
  );

  // Lazy refresh handler — spawned by AuthProfilesManager when a soon-expiring
  // OAuth token is read. Idempotency-keyed by (userId, agentId) so concurrent
  // reads collapse to one refresh.
  scheduler.register('refresh-token-for-user-agent', async (ctx) => {
    const { userId, agentId } = ctx.payload as {
      userId: string;
      agentId: string;
    };
    if (!userId || !agentId) {
      logger.warn(
        { payload: ctx.payload },
        '[task] refresh-token-for-user-agent missing userId/agentId',
      );
      return;
    }
    await coreServices.getTokenRefreshJob().refreshForUserAgent(userId, agentId);
  });

  // MCP session cleanup — drops expired session rows from the DB. Lives here
  // (cross-pod-coordinated) instead of as an mcp-handler module-level
  // setInterval. The IN-MEMORY part stays per-pod (see mcp-handler.ts).
  scheduler.register(
    'mcp-session-cleanup',
    () => cleanupExpiredMcpSessions(),
    { cron: '*/10 * * * *' },
  );

  // Hygiene sweep — drops expired rows from oauth_states, rate_limits,
  // grants, and archives completed runs.
  scheduler.register(
    'sweep-ephemeral-tables',
    () => coreServices.sweepEphemeralTables(),
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'check-stalled-executions',
    async () => {
      await checkStalledExecutions(env);
      logger.info('[task] check-stalled-executions completed');
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'trigger-embed-backfill',
    async () => {
      const result = await triggerEmbedBackfill(env);
      if (result.runsCreated > 0) {
        logger.info({ ...result }, '[task] trigger-embed-backfill enqueued runs');
      }
    },
    { cron: '*/5 * * * *' },
  );

  scheduler.register(
    'classification-reconciliation',
    async () => {
      const result = await runClassificationReconciliation(env);
      logger.info({ ...result }, '[task] classification-reconciliation completed');
    },
    { cron: '*/5 * * * *' },
  );

  // Watcher automation: reconcile in-flight runs, materialize newly-due runs,
  // dispatch pending runs. The orphaned-runs reset is bounded and idempotent
  // so it runs every tick — no per-pod first-tick latch needed.
  scheduler.register(
    'watcher-automation',
    async () => {
      const { reset } = await resetOrphanedWatcherRuns();
      if (reset > 0) {
        logger.info({ reset }, '[task] watcher-automation: reset orphaned runs');
      }
      const reconciliation = await reconcileWatcherRuns();
      const materialize = await materializeDueWatcherRuns(env);
      const dispatch = await dispatchPendingWatcherRuns(env);

      logger.info(
        {
          reconciled: reconciliation.reconciled,
          dueWatchers: materialize.dueWatchers,
          runsCreated: materialize.runsCreated,
          skipped: materialize.skipped,
          claimed: dispatch.claimed,
          dispatched: dispatch.dispatched,
          dispatchReconciled: dispatch.reconciled,
          failed: dispatch.failed,
        },
        '[task] watcher-automation completed',
      );
    },
    { cron: '* * * * *' },
  );
}
