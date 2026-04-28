/**
 * Compact watcher feedback contract.
 *
 * High-value coverage retained from the deleted feedback suite: the feedback
 * API is the durable human-correction path for watcher outputs, so it must
 * store field-level mutations transactionally, return scoped feedback, validate
 * malformed corrections, and block cross-org writes.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { manageWatchers } from '../../../tools/admin/manage_watchers';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-workspace';

function ownerCtx(workspace: TestWorkspace): ToolContext {
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
  };
}

async function seedWatcher(workspace: TestWorkspace, suffix: string) {
  const entity = await createTestEntity({
    name: `Feedback Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: `feedback-watcher-${suffix}`,
    name: `Feedback Watcher ${suffix}`,
    prompt: 'Analyze inputs.',
    extraction_schema: {
      type: 'object',
      properties: {
        problems: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, severity: { type: 'string' } },
          },
        },
      },
    },
  })) as { watcher_id: string };

  const [window] = await getTestDb()`
    INSERT INTO watcher_windows (
      watcher_id, granularity, window_start, window_end,
      extracted_data, content_analyzed, model_used, created_at
    ) VALUES (
      ${Number(watcher.watcher_id)}, 'weekly',
      ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)}, ${new Date()},
      ${getTestDb().json({ problems: [{ name: 'A', severity: 'low' }] })},
      0, 'test-model', NOW()
    )
    RETURNING id
  `;

  return { watcherId: watcher.watcher_id, windowId: Number(window.id) };
}

describe('watcher feedback contract', () => {
  let workspace: TestWorkspace;
  let watcherId: string;
  let windowId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Feedback Contract Org' });
    const seeded = await seedWatcher(workspace, 'primary');
    watcherId = seeded.watcherId;
    windowId = seeded.windowId;
  });

  beforeEach(async () => {
    await getTestDb()`DELETE FROM watcher_window_field_feedback WHERE watcher_id = ${Number(watcherId)}`;
  });

  it('stores set/remove/add field corrections from one batch as separate rows', async () => {
    const result = (await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: watcherId,
        window_id: windowId,
        corrections: [
          { field_path: 'problems[0].severity', value: 'high', note: 'misclassified' },
          { field_path: 'problems[0]', mutation: 'remove' },
          { field_path: 'problems', mutation: 'add', value: { name: 'B', severity: 'medium' } },
        ],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };

    expect(result.feedback_ids).toHaveLength(3);

    const rows = await getTestDb()`
      SELECT field_path, mutation, corrected_value, note
      FROM watcher_window_field_feedback
      WHERE watcher_id = ${Number(watcherId)}
      ORDER BY field_path ASC
    `;
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => `${row.field_path}:${row.mutation}`)).toEqual([
      'problems:add',
      'problems[0]:remove',
      'problems[0].severity:set',
    ]);
    expect(rows.find((row) => row.field_path === 'problems[0].severity')?.corrected_value).toBe(
      'high'
    );
    expect(rows.find((row) => row.field_path === 'problems')?.corrected_value).toEqual({
      name: 'B',
      severity: 'medium',
    });
  });

  it('returns scoped feedback and honors window filters', async () => {
    const otherWindow = await getTestDb()`
      INSERT INTO watcher_windows (
        watcher_id, granularity, window_start, window_end,
        extracted_data, content_analyzed, model_used, created_at
      ) VALUES (
        ${Number(watcherId)}, 'weekly', ${new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)},
        ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)}, ${getTestDb().json({ problems: [] })},
        0, 'test-model', NOW()
      )
      RETURNING id
    `;

    await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: watcherId,
        window_id: windowId,
        corrections: [{ field_path: 'current', value: 1 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );
    await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: watcherId,
        window_id: Number(otherWindow[0].id),
        corrections: [{ field_path: 'other', value: 2 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    const filtered = (await manageWatchers(
      { action: 'get_feedback', watcher_id: watcherId, window_id: Number(otherWindow[0].id) } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback: Array<{ field_path: string }> };

    expect(filtered.feedback).toHaveLength(1);
    expect(filtered.feedback[0].field_path).toBe('other');
  });

  it('rejects malformed corrections and cross-org watcher/window ids', async () => {
    await expect(
      manageWatchers(
        { action: 'submit_feedback', watcher_id: watcherId, window_id: windowId, corrections: [] } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/non-empty array/);

    await expect(
      manageWatchers(
        {
          action: 'submit_feedback',
          watcher_id: watcherId,
          window_id: windowId,
          corrections: [{ field_path: 'problems[0]', mutation: 'patch', value: 'x' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/unsupported mutation/);

    const other = await TestWorkspace.create({ name: 'Feedback Stranger Org' });
    const foreign = await seedWatcher(other, 'foreign');
    await expect(
      manageWatchers(
        {
          action: 'submit_feedback',
          watcher_id: foreign.watcherId,
          window_id: foreign.windowId,
          corrections: [{ field_path: 'problems[0]', value: 'x' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/not found|access/i);
  });
});
