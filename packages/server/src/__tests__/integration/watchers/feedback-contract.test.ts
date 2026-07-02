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
import { insertEvent } from '../../../utils/insert-event';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

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
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: `feedback-watcher-${suffix}`,
    name: `Feedback Watcher ${suffix}`,
    prompt: 'Analyze inputs.',
    agent_id: agent.agentId,
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
    // Corrections are now append-only 'correction' events; use the documented escape hatch to
    // isolate each test (watcher_window_field_feedback was retired in the P1 consolidation).
    await getTestDb().begin(async (tx) => {
      await tx`SET LOCAL lobu.allow_event_delete = 'on'`;
      await tx`
        DELETE FROM events
        WHERE semantic_type = 'correction'
          AND (metadata->>'watcher_id')::bigint = ${Number(watcherId)}
      `;
    });
  });

  it('stores set/remove/add field corrections from one batch as separate correction events', async () => {
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
      SELECT metadata->>'field_path' AS field_path, metadata->>'mutation' AS mutation,
             metadata->'corrected_value' AS corrected_value, metadata->>'note' AS note
      FROM events
      WHERE semantic_type = 'correction' AND (metadata->>'watcher_id')::bigint = ${Number(watcherId)}
      ORDER BY metadata->>'field_path' ASC
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
      // Boundary validation rejects the bad enum before the handler's own
      // "unsupported mutation" check — both name the offending field.
    ).rejects.toThrow(/mutation/);

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

  // ============================================
  // Materialized corrections (canvas-on-events)
  // ============================================

  /**
   * Seed a canvas_state ROOT event for a window's period so submit_feedback has a
   * chain HEAD to supersede. Mirrors what complete_window would have written.
   */
  async function seedCanvasRoot(
    orgId: string,
    wId: string,
    winId: number,
    payload: Record<string, unknown>
  ): Promise<number> {
    const sql = getTestDb();
    const [win] = await sql`
      SELECT granularity, window_start, window_end FROM watcher_windows WHERE id = ${winId}
    `;
    const [row] = await sql`
      INSERT INTO events (
        organization_id, origin_id, payload_type, payload_data, semantic_type,
        metadata, occurred_at, created_at
      ) VALUES (
        ${orgId}, ${`canvas_seed_${winId}`}, 'json_template', ${sql.json(payload)}, 'canvas_state',
        ${sql.json({
          watcher_id: Number(wId),
          granularity: win.granularity,
          window_start: new Date(win.window_start as string).toISOString(),
          window_end: new Date(win.window_end as string).toISOString(),
        })},
        ${new Date(win.window_end as string)}, NOW()
      )
      RETURNING id
    `;
    return Number(row.id);
  }

  it('materializes a superseding canvas_state with the correction applied AND still writes advisory events', async () => {
    const seeded = await seedWatcher(workspace, `materialize-${Date.now()}`);
    const rootId = await seedCanvasRoot(workspace.org.id, seeded.watcherId, seeded.windowId, {
      problems: [{ name: 'A', severity: 'low' }],
    });

    const result = (await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: seeded.watcherId,
        window_id: seeded.windowId,
        corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };

    // Advisory correction event still written.
    expect(result.feedback_ids).toHaveLength(1);
    const advisory = await getTestDb()`
      SELECT 1 FROM events
      WHERE semantic_type = 'correction'
        AND (metadata->>'watcher_id')::bigint = ${Number(seeded.watcherId)}
        AND metadata->>'field_path' = 'problems[0].severity'
    `;
    expect(advisory).toHaveLength(1);

    // A superseding canvas_state event exists with the correction applied.
    const head = await getTestDb()`
      SELECT e.id, e.payload_data, e.supersedes_event_id,
             (e.metadata->>'root_event_id')::bigint AS root_event_id, e.created_by
      FROM events e
      WHERE e.semantic_type = 'canvas_state'
        AND (e.metadata->>'watcher_id')::bigint = ${Number(seeded.watcherId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(head).toHaveLength(1);
    expect(Number(head[0].supersedes_event_id)).toBe(rootId);
    expect(Number(head[0].root_event_id)).toBe(rootId);
    expect(head[0].created_by).toBe(workspace.users.owner.id);
    const problems = (head[0].payload_data as { problems: Array<{ severity: string }> }).problems;
    expect(problems[0].severity).toBe('high');
  });

  it('concurrent supersede of the same head loses with 409', async () => {
    const seeded = await seedWatcher(workspace, `concurrent-${Date.now()}`);
    const rootId = await seedCanvasRoot(workspace.org.id, seeded.watcherId, seeded.windowId, {
      problems: [{ name: 'A', severity: 'low' }],
    });

    // First correction supersedes the root → becomes the head.
    await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: seeded.watcherId,
        window_id: seeded.windowId,
        corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    // Simulate a second replica that read the SAME (now-stale) root as its head
    // and tries to supersede it concurrently. The partial unique index
    // idx_events_superseded_by rejects the second superseder of the same target
    // with 23505; the write path maps it to a clean 409 (mirrors save_content.ts).
    let raised: unknown;
    try {
      await insertEvent(
        {
          entityIds: [],
          organizationId: workspace.org.id,
          originId: `canvas_conflict_${Date.now()}`,
          payloadType: 'json_template',
          payloadData: { problems: [{ name: 'A', severity: 'critical' }] },
          semanticType: 'canvas_state',
          metadata: { watcher_id: Number(seeded.watcherId), root_event_id: rootId },
          supersedesEventId: rootId,
        },
        { sql: getTestDb() as never }
      );
    } catch (err) {
      raised = err;
    }
    expect(isUniqueViolation(raised, 'idx_events_superseded_by')).toBe(true);

    // Still exactly one HEAD (the first correction).
    const heads = await getTestDb()`
      SELECT e.id FROM events e
      WHERE e.semantic_type = 'canvas_state'
        AND (e.metadata->>'watcher_id')::bigint = ${Number(seeded.watcherId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(heads).toHaveLength(1);
  });

  it('a prototype-polluting field_path is inert (advisory recorded, payload and prototypes untouched)', async () => {
    const seeded = await seedWatcher(workspace, `pollute-${Date.now()}`);
    await seedCanvasRoot(workspace.org.id, seeded.watcherId, seeded.windowId, {
      summary: 'clean',
    });

    // field_path is caller input — a path through the prototype chain must not
    // assign onto Object.prototype (CodeQL js/prototype-polluting-assignment)
    // and must not become an own key of the payload either.
    const result = (await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: seeded.watcherId,
        window_id: seeded.windowId,
        corrections: [
          { field_path: '__proto__.polluted', value: 'evil' },
          { field_path: 'constructor.prototype.polluted2', value: 'evil' },
        ],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };

    // Advisory events still record the intent (they're inert data, not applied).
    expect(result.feedback_ids).toHaveLength(2);

    // No global prototype pollution.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();

    // The head payload is unchanged: the forbidden paths were no-ops, so no
    // superseding canvas_state was needed OR the head has no polluted keys.
    const head = await getTestDb()`
      SELECT e.payload_data FROM events e
      WHERE e.semantic_type = 'canvas_state'
        AND (e.metadata->>'watcher_id')::bigint = ${Number(seeded.watcherId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(head).toHaveLength(1);
    const payload = head[0].payload_data as Record<string, unknown>;
    expect(payload.summary).toBe('clean');
    expect(Object.keys(payload)).not.toContain('polluted');
    expect(Object.keys(payload)).not.toContain('polluted2');
  });

  it('skips materialization gracefully when the window has no canvas chain yet', async () => {
    const seeded = await seedWatcher(workspace, `nochain-${Date.now()}`);
    // No canvas_state seeded → materialization must skip, advisory event still written.
    const result = (await manageWatchers(
      {
        action: 'submit_feedback',
        watcher_id: seeded.watcherId,
        window_id: seeded.windowId,
        corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };
    expect(result.feedback_ids).toHaveLength(1);

    const canvas = await getTestDb()`
      SELECT 1 FROM events
      WHERE semantic_type = 'canvas_state'
        AND (metadata->>'watcher_id')::bigint = ${Number(seeded.watcherId)}
    `;
    expect(canvas).toHaveLength(0);
  });
});
