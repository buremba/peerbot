/**
 * Regression test: rollup complete_window must allocate its watcher_windows id
 * INSIDE the same transaction as the INSERT.
 *
 * getNextNumericId acquires a TRANSACTION-scoped advisory lock
 * (pg_advisory_xact_lock). The non-rollup completion path runs it inside
 * sql.begin(tx => ...), so the lock spans the INSERT and concurrent callers
 * serialize. The rollup path previously allocated the id with the pool client
 * OUTSIDE any transaction — the lock released the instant getNextNumericId's
 * implicit statement-transaction committed, before the separate INSERT ran. Two
 * concurrent device-worker rollup completions then both computed the same
 * MAX(id)+1 and collided on the watcher_windows primary key.
 *
 * Each rollup here is given a DISTINCT (window_start, granularity) so the
 * business-uniqueness constraints (idx_watcher_windows_unique_period applies
 * only to leaf rows; insight_windows_insight_id_granularity_window_start_key is
 * keyed on window_start) never trip. The ONLY shared column across the
 * concurrent inserts is the allocated `id`, so a failure isolates the PK race
 * the advisory lock is meant to prevent.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { generateWindowToken } from '../../../utils/jwt';
import { manageWatchers } from '../../../tools/admin/manage_watchers';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const TEST_ENV = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;

function ownerCtx(workspace: Awaited<ReturnType<typeof TestWorkspace.create>>): ToolContext {
  return {
    organizationId: workspace.org.id,
    userId: workspace.users.owner.id,
    memberRole: 'owner',
    agentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    scopedToOrg: true,
    allowCrossOrg: false,
  } as ToolContext;
}

describe('rollup complete_window id allocation race', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('serializes concurrent rollup completions (no watcher_windows PK collision)', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Rollup Race Org' });
    const ownerUserId = workspace.users.owner.id;

    const entity = await createTestEntity({
      name: 'Rollup Entity',
      organization_id: workspace.org.id,
      created_by: ownerUserId,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId,
      agentId: 'rollup-agent',
      name: 'Rollup Agent',
    });

    const watcher = (await workspace.owner.watchers.create({
      entity_id: entity.id,
      slug: 'rollup-watcher',
      name: 'Rollup Watcher',
      prompt: 'Summarize {{entities}}.',
      schedule: '0 9 * * *',
      agent_id: agent.agentId,
    })) as { watcher_id: string };
    const watcherId = Number(watcher.watcher_id);

    // Two leaf windows to act as the rollup's source_window_ids. These also
    // ensure MAX(id) is non-zero before the concurrent rollup inserts start.
    const leafIds: number[] = [];
    for (let i = 0; i < 2; i++) {
      const start = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
      const end = new Date(Date.UTC(2026, 0, 2 + i)).toISOString();
      const [row] = await sql`
        INSERT INTO watcher_windows (
          watcher_id, granularity, window_start, window_end,
          extracted_data, content_analyzed, model_used, run_metadata, created_at
        ) VALUES (
          ${watcherId}, 'daily', ${start}, ${end},
          ${sql.json({ summary: `leaf ${i}` })}, 0, 'test', ${sql.json({})}, NOW()
        )
        RETURNING id
      `;
      leafIds.push(Number(row.id));
    }

    // N concurrent rollup completions, each on a DISTINCT (window_start,
    // granularity) so only the allocated PK `id` can collide. With the bug,
    // the advisory lock releases before each INSERT and several callers
    // compute the same MAX(id)+1 → 23505 unique_violation on the PK.
    const N = 12;
    const ctx = ownerCtx(workspace);
    const completions = await Promise.allSettled(
      Array.from({ length: N }, async (_unused, i) => {
        const start = new Date(Date.UTC(2026, 1, 1 + i)).toISOString();
        const end = new Date(Date.UTC(2026, 1, 8 + i)).toISOString();
        const token = await generateWindowToken(
          {
            watcher_id: watcherId,
            window_start: start,
            window_end: end,
            granularity: `weekly-${i}`,
            content_count: 0,
            content_ids: [],
            is_rollup: true,
            source_window_ids: leafIds,
            depth: 1,
          },
          TEST_ENV
        );
        return manageWatchers(
          {
            action: 'complete_window',
            watcher_id: String(watcherId),
            window_token: token,
            extracted_data: { summary: `rollup ${i}` },
          } as never,
          TEST_ENV,
          ctx
        );
      })
    );

    const rejected = completions.filter((r) => r.status === 'rejected');
    const rejectionMessages = rejected.map((r) =>
      r.status === 'rejected'
        ? r.reason instanceof Error
          ? r.reason.message
          : String(r.reason)
        : ''
    );
    expect(rejectionMessages).toEqual([]);

    // Every rollup must have landed with a unique id.
    const windowIds = completions
      .filter((r): r is PromiseFulfilledResult<{ window_id: number }> => r.status === 'fulfilled')
      .map((r) => Number(r.value.window_id));
    expect(windowIds).toHaveLength(N);
    expect(new Set(windowIds).size).toBe(N);

    const stored = await sql`
      SELECT id FROM watcher_windows
      WHERE watcher_id = ${watcherId} AND is_rollup = true
    `;
    expect(stored).toHaveLength(N);
    const storedIds = stored.map((row) => Number(row.id));
    expect(new Set(storedIds).size).toBe(N);
  });
});
