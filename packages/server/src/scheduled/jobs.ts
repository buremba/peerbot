/**
 * TaskScheduler boot + periodic platform-internal jobs.
 *
 * Each job is a standalone task with its own cron schedule, durable as a row
 * in `public.runs` (run_type='task'). Cross-pod coordination is the
 * runs-queue claim path — no per-job advisory locks.
 */

import type { Env } from '@lobu/connector-sdk';
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
import { registerScheduledJobsTicker } from './scheduled-jobs-service';
import { TaskScheduler } from './task-scheduler';
import { triggerEmbedBackfill } from './trigger-embed-backfill';
import { getDb, pgTextArray } from '../db/client';
import { createNotificationForUsers } from '../notifications/service';
import {
  createThreadForAgent,
  enqueueAgentMessage,
} from '../gateway/services/agent-threads';

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

  // scheduled_jobs ticker: scans the table every minute, spawns due rows
  // as task runs via this same scheduler. The actual firing handlers are
  // registered below so spawn() can find them.
  registerScheduledJobsTicker(scheduler);

  // Handler: send_notification. Payload mirrors the notify-tool shape;
  // resolves recipients to user_ids and inserts events + notification_targets.
  scheduler.register('send_notification', async (ctx) => {
    const sql = getDb();
    const p = ctx.payload as {
      __organization_id?: string;
      organization_id?: string;
      recipients?: string[] | 'admins' | 'all';
      type?: string;
      title?: string;
      body?: string | null;
      resource_url?: string | null;
    };
    const orgId = p.__organization_id ?? p.organization_id;
    const title = p.title;
    if (!orgId || !title) {
      logger.warn({ payload: ctx.payload }, '[task] send_notification missing org or title');
      return;
    }
    const recipients = p.recipients ?? 'admins';
    let userIds: string[];
    if (Array.isArray(recipients)) {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
          AND "userId" = ANY(${pgTextArray(recipients)}::text[])
      `;
      userIds = rows.map((r) => r.userId);
    } else if (recipients === 'all') {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId}
      `;
      userIds = rows.map((r) => r.userId);
    } else {
      const rows = await sql<{ userId: string }>`
        SELECT "userId" FROM "member"
        WHERE "organizationId" = ${orgId} AND role IN ('admin', 'owner')
      `;
      userIds = rows.map((r) => r.userId);
    }
    if (userIds.length === 0) return;
    await createNotificationForUsers(userIds, {
      organizationId: orgId,
      type: (p.type as 'agent_message') ?? 'agent_message',
      title,
      body: p.body ?? null,
      resourceUrl: p.resource_url ?? null,
    });
  });

  // Handler: wake_agent. Creates a thread for the agent (or reuses one
  // supplied by the caller) and enqueues the prompt as a user message.
  // Lets an agent schedule its own follow-up wake-ups via manage_schedules.
  scheduler.register('wake_agent', async (ctx) => {
    const p = ctx.payload as {
      __organization_id?: string;
      organization_id?: string;
      agent_id?: string;
      prompt?: string;
      thread_id?: string | null;
      created_by_user?: string | null;
      reason?: string | null;
    };
    const orgId = p.__organization_id ?? p.organization_id;
    if (!orgId || !p.agent_id || !p.prompt) {
      logger.warn({ payload: ctx.payload }, '[task] wake_agent missing org/agent/prompt');
      return;
    }
    const sessionManager = coreServices.getSessionManager();
    const queueProducer = coreServices.getQueueProducer();
    let threadId = p.thread_id ?? null;
    if (!threadId) {
      const result = await createThreadForAgent(
        { sessionManager },
        {
          agentId: p.agent_id,
          organizationId: orgId,
          createdByUserId: p.created_by_user ?? undefined,
          reason: p.reason ?? 'scheduled-wake',
        }
      );
      threadId = result.threadId;
    }
    await enqueueAgentMessage(
      { sessionManager, queueProducer },
      {
        threadId,
        messageText: p.prompt,
        source: 'scheduled-job',
      }
    );
  });
}
