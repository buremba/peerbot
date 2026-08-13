/**
 * Integration test: TaskScheduler.reconcileOrphanedTasks marks pending task
 * rows whose handler no longer exists as failed.
 *
 * The `product-ops-digest` incident (revert #2717) left a self-seeded cron row
 * in public.runs with no registered handler; every dispatch threw and fired
 * Sentry noise until the row exhausted retries. The reconcile runs at boot and
 * fails those rows so they never dispatch, while leaving registered tasks and
 * terminal rows untouched.
 *
 * DB-backed (public.runs), so it runs against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import { TaskScheduler } from '../../../scheduled/task-scheduler';
import { createTestOrganization } from '../../setup/test-fixtures';
import type { IMessageQueue, QueueJob, QueueOptions, QueueStats, JobHandler } from '../../../gateway/infrastructure/queue/types';

class NoopQueue implements IMessageQueue {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(): Promise<void> {}
  async send<T>(_queueName: string, _data: T, _options?: QueueOptions): Promise<string> {
    return '1';
  }
  async work<T>(_queueName: string, _handler: JobHandler<T>): Promise<void> {}
  async pauseWorker(): Promise<void> {}
  async resumeWorker(): Promise<void> {}
  async getQueueStats(): Promise<QueueStats> {
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }
  isHealthy(): boolean {
    return true;
  }
}

async function seedTaskRow(actionKey: string, status: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql<{ id: number }>`
    INSERT INTO public.runs (
      run_type, queue_name, action_key, status, run_at, priority
    ) VALUES (
      'task', 'task', ${actionKey}, ${status}, NOW(), 0
    )
    RETURNING id
  `;
  return row.id;
}

describe('TaskScheduler.reconcileOrphanedTasks', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    await createTestOrganization({ name: 'Task Reconcile Org' });
  });

  it('marks pending rows for unregistered tasks as failed and leaves registered ones', async () => {
    await cleanupTestDatabase();
    const sql = getDb();
    const orphanId = await seedTaskRow('product-ops-digest', 'pending');
    const liveId = await seedTaskRow('watcher-automation', 'pending');

    const scheduler = new TaskScheduler(new NoopQueue());
    scheduler.register('watcher-automation', async () => {});

    const count = await scheduler.reconcileOrphanedTasks();
    expect(count).toBe(1);

    const orphan = await sql<{ status: string }>`SELECT status FROM public.runs WHERE id = ${orphanId}`;
    expect(orphan[0]!.status).toBe('failed');

    const live = await sql<{ status: string }>`SELECT status FROM public.runs WHERE id = ${liveId}`;
    expect(live[0]!.status).toBe('pending');
  });

  it('leaves non-pending terminal rows untouched', async () => {
    await cleanupTestDatabase();
    const sql = getDb();
    const failedId = await seedTaskRow('ghost-task', 'failed');

    const scheduler = new TaskScheduler(new NoopQueue());
    const count = await scheduler.reconcileOrphanedTasks();
    expect(count).toBe(0);

    const row = await sql<{ status: string }>`SELECT status FROM public.runs WHERE id = ${failedId}`;
    expect(row[0]!.status).toBe('failed');
  });
});
