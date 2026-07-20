/**
 * createWatcherRun catch handling for
 * idx_runs_pending_non_event_watcher_per_watcher.
 *
 * Index (db/migrations/20260717121025): unique on runs(watcher_id) WHERE
 *   run_type = 'watcher'
 *   AND watcher_id IS NOT NULL
 *   AND status = 'pending'
 *   AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
 *
 * So only one pending non-event (scheduled/manual/legacy) watcher run per
 * watcher. Event deliveries are excluded. Manual + scheduled inserts with
 * different windows produce different idempotency keys, so
 * runs_idempotency_key_uniq does not fire — only this partial index does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { createWatcherRun } from '../../../runs/queue-service';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForLockWait(sql: ReturnType<typeof getTestDb>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = (await sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `) as unknown as Array<{ n: number }>;
    if (Number(rows[0]?.n) > 0) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for INSERT lock wait on held pending run');
}

async function setupWatcher() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({
    name: 'Pending Non-Event Uniq Org',
  });

  const entity = await createTestEntity({
    name: 'Pending Uniq Entity',
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });

  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
    agentId: 'pending-uniq-agent',
    name: 'Pending Uniq Agent',
  });

  const watcher = (await workspace.owner.behaviors.create({
    entity_id: entity.id,
    slug: 'pending-uniq-watcher',
    name: 'Pending Uniq Watcher',
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { behavior_id: string };

  return {
    sql,
    workspace,
    watcherId: Number(watcher.behavior_id),
    agentId: agent.agentId,
  };
}

describe('createWatcherRun pending non-event unique index', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('reuses existing pending scheduled run when manual insert hits idx_runs_pending_non_event_watcher_per_watcher', async () => {
    const { sql, workspace, watcherId, agentId } = await setupWatcher();

    // Seed a pending scheduled run via createWatcherRun (different window from
    // the manual attempt so runs_idempotency_key_uniq cannot absorb the conflict).
    const scheduled = await createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-02T00:00:00.000Z',
      dispatchSource: 'scheduled',
    });
    expect(scheduled.created).toBe(true);
    expect(scheduled.status).toBe('pending');

    // Soft-check path: sequential createWatcherRun reuses without INSERT.
    // That does not exercise the catch. Force the TOCTOU path the bug needs:
    // hold an uncommitted pending non-event row so findActiveWatcherRun misses
    // it, then let createWatcherRun's INSERT collide with the partial unique index.
    await sql`DELETE FROM runs WHERE id = ${scheduled.runId}`;

    const held = deferred();
    const release = deferred();
    let heldRunId = 0;

    const holder = (sql as unknown as DbClient).begin(async (tx) => {
      const payload = {
        watcher_id: watcherId,
        agent_id: agentId,
        window_start: '2026-01-01T00:00:00.000Z',
        window_end: '2026-01-02T00:00:00.000Z',
        dispatch_source: 'scheduled',
        version_id: null,
        device_worker_id: null,
        agent_kind: null,
      };
      const idempotencyKey = [
        'behavior',
        watcherId,
        'scheduled',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ].join(':');
      const inserted = await tx`
        INSERT INTO runs (
          organization_id,
          run_type,
          watcher_id,
          approval_status,
          status,
          approved_input,
          idempotency_key,
          created_at
        ) VALUES (
          ${workspace.org.id},
          'watcher',
          ${watcherId},
          'auto',
          'pending',
          ${tx.json(payload)},
          ${idempotencyKey},
          current_timestamp
        )
        RETURNING id
      `;
      heldRunId = Number((inserted[0] as { id: unknown }).id);
      held.resolve();
      await release.promise;
    });

    await held.promise;

    // Different dispatch_source + window → different idempotency key; only the
    // partial pending-non-event index conflicts (status=pending, non-event).
    const manualPromise = createWatcherRun({
      organizationId: workspace.org.id,
      watcherId,
      agentId,
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-06-02T00:00:00.000Z',
      dispatchSource: 'manual',
    });

    await waitForLockWait(sql);
    release.resolve();
    await holder;

    const manual = await manualPromise;
    expect(manual.created).toBe(false);
    expect(manual.runId).toBe(heldRunId);
    expect(manual.status).toBe('pending');

    const runs = await sql`
      SELECT id, status, approved_input
      FROM runs
      WHERE watcher_id = ${watcherId}
        AND run_type = 'watcher'
        AND status = 'pending'
        AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
    `;
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].id)).toBe(heldRunId);
    const source = (runs[0].approved_input as { dispatch_source?: string }).dispatch_source;
    expect(source).toBe('scheduled');
  });
});
