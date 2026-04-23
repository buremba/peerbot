import type { Env } from '@lobu/owletto-sdk';
import logger from '../utils/logger';
import { withAdvisoryLock } from './advisory-lock';

const MAINTENANCE_LOCK_KEY = 71002;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

async function runMaintenanceTasks(env: Env): Promise<void> {
  logger.info('Running scheduled maintenance tasks');
  let failures = 0;

  try {
    const { checkStalledExecutions } = await import('./check-stalled-executions');
    await checkStalledExecutions(env);
    logger.info('Scheduled: Stalled execution check completed');
  } catch (error) {
    failures++;
    logger.error({ error }, 'Scheduled: Stalled execution check failed');
  }

  try {
    const { triggerEmbedBackfill } = await import('./trigger-embed-backfill');
    const backfillResult = await triggerEmbedBackfill(env);
    if (backfillResult.runsCreated > 0) {
      logger.info({ ...backfillResult }, 'Scheduled: Embedding backfill triggered');
    }
  } catch (error) {
    failures++;
    logger.error({ error }, 'Scheduled: Embedding backfill failed');
  }

  try {
    const { runClassificationReconciliation } = await import('./classification-reconciliation');
    const classificationResult = await runClassificationReconciliation(env);
    logger.info({ ...classificationResult }, 'Scheduled: Classification reconciliation completed');
  } catch (error) {
    failures++;
    logger.error({ error }, 'Scheduled: Classification reconciliation failed');
  }

  try {
    const { dispatchPendingWatcherRuns, materializeDueWatcherRuns, reconcileWatcherRuns } =
      await import('../watchers/automation');

    const reconciliationResult = await reconcileWatcherRuns();
    const materializeResult = await materializeDueWatcherRuns(env);
    const dispatchResult = await dispatchPendingWatcherRuns(env);

    logger.info(
      {
        reconciled: reconciliationResult.reconciled,
        dueWatchers: materializeResult.dueWatchers,
        runsCreated: materializeResult.runsCreated,
        skipped: materializeResult.skipped,
        claimed: dispatchResult.claimed,
        dispatched: dispatchResult.dispatched,
        dispatchReconciled: dispatchResult.reconciled,
        failed: dispatchResult.failed,
      },
      'Scheduled: Watcher automation maintenance completed'
    );
  } catch (error) {
    failures++;
    logger.error({ error }, 'Scheduled: Watcher automation maintenance failed');
  }

  if (failures === 4) {
    throw new Error('All maintenance subtasks failed');
  }
}

async function runMaintenanceTick(env: Env): Promise<void> {
  const { acquired } = await withAdvisoryLock(MAINTENANCE_LOCK_KEY, 'maintenance', () =>
    runMaintenanceTasks(env)
  );

  if (!acquired) {
    logger.debug('[scheduler] Skipping maintenance tick; another replica owns the lock');
  }
}

export function startMaintenanceScheduler(env: Env): () => void {
  const timer = setInterval(() => {
    void runMaintenanceTick(env).catch((error) => {
      logger.error({ error }, 'Scheduled: Maintenance tick failed');
    });
  }, MAINTENANCE_INTERVAL_MS);

  void runMaintenanceTick(env).catch((error) => {
    logger.error({ error }, 'Scheduled: Initial maintenance tick failed');
  });

  logger.info('[scheduler] Maintenance scheduler started');

  return () => {
    clearInterval(timer);
    logger.info('[scheduler] Maintenance scheduler stopped');
  };
}
