/**
 * createAutomationRun catch handling for
 * idx_runs_pending_non_event_per_automation.
 *
 * Index (db/migrations/20260717121025): unique on runs(automation_id) WHERE
 *   run_type = 'automation'
 *   AND automation_id IS NOT NULL
 *   AND status = 'pending'
 *   AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
 *
 * So only one pending non-event (scheduled/manual/legacy) automation run per
 * automation. Event deliveries are excluded. Manual + scheduled inserts with
 * different windows produce different idempotency keys, so
 * runs_idempotency_key_uniq does not fire — only this partial index does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import {
  createAutomationRun,
  createAutomationRunInTransaction,
} from '../../../runs/queue-service';
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

async function setupAutomation() {
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

  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: 'pending-uniq-automation',
    name: 'Pending Uniq Automation',
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { automation_id: string };

  return {
    sql,
    workspace,
    automationId: Number(automation.automation_id),
    agentId: agent.agentId,
  };
}

describe('createAutomationRun pending non-event unique index', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('reuses existing pending scheduled run when manual insert hits idx_runs_pending_non_event_per_automation', async () => {
    const { sql, workspace, automationId, agentId } = await setupAutomation();

    // Seed a pending scheduled run via createAutomationRun (different window from
    // the manual attempt so runs_idempotency_key_uniq cannot absorb the conflict).
    const scheduled = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-02T00:00:00.000Z',
      dispatchSource: 'scheduled',
    });
    expect(scheduled.created).toBe(true);
    expect(scheduled.status).toBe('pending');

    // Soft-check path: sequential createAutomationRun reuses without INSERT.
    // That does not exercise the catch. Force the TOCTOU path the bug needs:
    // hold an uncommitted pending non-event row so findActiveAutomationRun misses
    // it, then let createAutomationRun's INSERT collide with the partial unique index.
    await sql`DELETE FROM runs WHERE id = ${scheduled.runId}`;

    const held = deferred();
    const release = deferred();
    let heldRunId = 0;

    const holder = (sql as unknown as DbClient).begin(async (tx) => {
      const payload = {
        automation_id: automationId,
        agent_id: agentId,
        window_start: '2026-01-01T00:00:00.000Z',
        window_end: '2026-01-02T00:00:00.000Z',
        dispatch_source: 'scheduled',
        version_id: null,
        device_worker_id: null,
        agent_kind: null,
      };
      const idempotencyKey = [
        'automation',
        automationId,
        'scheduled',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ].join(':');
      const inserted = await tx`
        INSERT INTO runs (
          organization_id,
          run_type,
          automation_id,
          approval_status,
          status,
          approved_input,
          idempotency_key,
          created_at
        ) VALUES (
          ${workspace.org.id},
          'automation',
          ${automationId},
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
    // Keep the conflicting insert inside a caller-owned transaction. Recovery
    // must roll the unique violation back to a savepoint before querying the
    // winning row; otherwise PostgreSQL leaves this outer transaction aborted.
    const manualPromise = (sql as unknown as DbClient).begin((tx) =>
      createAutomationRunInTransaction(
        {
          organizationId: workspace.org.id,
          automationId,
          agentId,
          windowStart: '2026-06-01T00:00:00.000Z',
          windowEnd: '2026-06-02T00:00:00.000Z',
          dispatchSource: 'manual',
        },
        tx
      )
    );

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
      WHERE automation_id = ${automationId}
        AND run_type = 'automation'
        AND status = 'pending'
        AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event'
    `;
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].id)).toBe(heldRunId);
    const source = (runs[0].approved_input as { dispatch_source?: string }).dispatch_source;
    expect(source).toBe('scheduled');
  });
});
