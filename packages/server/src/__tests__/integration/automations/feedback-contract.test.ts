/**
 * Compact automation feedback contract.
 *
 * High-value coverage retained from the deleted feedback suite: the feedback
 * API is the durable human-correction path for automation outputs, so it must
 * store field-level mutations transactionally, return scoped feedback, validate
 * malformed corrections, and block cross-org writes.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { manageAutomations } from '../../../tools/admin/manage_automations';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { isUniqueViolation } from '../../../utils/pg-errors';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createCanvasWindow, createTestAgent, createTestEntity } from '../../setup/test-fixtures';
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

async function seedAutomation(
  workspace: TestWorkspace,
  suffix: string,
  // Defaults to a window that has already closed. Pass a future instant to get
  // the shape prod is in for most of the day: a window still OPEN, whose
  // `window_end` has not happened yet.
  windowEnd: Date = new Date()
) {
  const entity = await createTestEntity({
    name: `Feedback Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: `feedback-automation-${suffix}`,
    name: `Feedback Automation ${suffix}`,
    prompt: 'Analyze inputs.',
    agent_id: agent.agentId,
  })) as { automation_id: string };

  // Canvas-on-events: the window is a canvas_state chain root; its event id is
  // the window_id the feedback API keys on.
  const windowId = await createCanvasWindow({
    automationId: Number(automation.automation_id),
    organizationId: workspace.org.id,
    granularity: 'weekly',
    windowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    windowEnd,
    extractedData: { problems: [{ name: 'A', severity: 'low' }] },
    createdBy: workspace.users.owner.id,
    entityIds: [entity.id],
  });

  return { automationId: automation.automation_id, windowId };
}

describe('automation feedback contract', () => {
  let workspace: TestWorkspace;
  let automationId: string;
  let windowId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Feedback Contract Org' });
    const seeded = await seedAutomation(workspace, 'primary');
    automationId = seeded.automationId;
    windowId = seeded.windowId;
  });

  beforeEach(async () => {
    // Corrections are now append-only 'correction' events; use the documented
    // escape hatch to isolate each test (the dedicated feedback table was
    // retired in the P1 consolidation).
    await getTestDb().begin(async (tx) => {
      await tx`SET LOCAL lobu.allow_event_delete = 'on'`;
      await tx`
        DELETE FROM events
        WHERE semantic_type = 'correction'
          AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
      `;
    });
  });

  it('stores set/remove/add field corrections from one batch as separate correction events', async () => {
    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        window_id: windowId,
        corrections: [
          {
            field_path: 'problems[0].severity',
            value: 'high',
            note: 'misclassified',
          },
          { field_path: 'problems[0]', mutation: 'remove' },
          {
            field_path: 'problems',
            mutation: 'add',
            value: { name: 'B', severity: 'medium' },
          },
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
      WHERE semantic_type = 'correction' AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
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

  it('feedback ids are the correction event ids; historical wwff_ origin_ids still parse', async () => {
    // After the dedicated feedback sequence was dropped, a new correction's
    // feedback id IS its event id (origin_id NULL). Historical rows carry
    // origin_id 'wwff_<seq>' and the reader recovers the legacy id from it.
    const sql = getTestDb();
    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        window_id: windowId,
        corrections: [{ field_path: 'summary', value: 'id-contract', note: 'id check' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback_ids: number[] };
    expect(result.feedback_ids).toHaveLength(1);
    const [ev] = await sql`
      SELECT id, origin_id FROM events
      WHERE semantic_type = 'correction'
        AND (metadata->>'automation_id')::bigint = ${Number(automationId)}
        AND metadata->>'field_path' = 'summary'
    `;
    expect(Number(ev.id)).toBe(result.feedback_ids[0]);
    expect(ev.origin_id).toBeNull();

    // Seed a historical (pre-3b) correction row with a wwff_ origin_id.
    await sql`
      INSERT INTO events (organization_id, semantic_type, entity_ids, origin_id, metadata, occurred_at, created_at)
      VALUES (${workspace.org.id}, 'correction', '{}'::bigint[], 'wwff_424242',
        ${sql.json({ window_id: Number(windowId), automation_id: Number(automationId), field_path: 'legacy.field', mutation: 'set', corrected_value: 'old', note: null })},
        NOW(), NOW())
    `;
    const feedback = (await manageAutomations(
      {
        action: 'get_feedback',
        automation_id: automationId,
        window_id: windowId,
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback: Array<{ id: number; field_path: string }> };
    const legacy = feedback.feedback.find((f) => f.field_path === 'legacy.field');
    const fresh = feedback.feedback.find((f) => f.field_path === 'summary');
    expect(legacy?.id).toBe(424242);
    expect(fresh?.id).toBe(result.feedback_ids[0]);
  });

  it('returns scoped feedback and honors window filters', async () => {
    const otherWindowId = await createCanvasWindow({
      automationId: Number(automationId),
      organizationId: workspace.org.id,
      granularity: 'weekly',
      windowStart: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      windowEnd: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      extractedData: { problems: [] },
      createdBy: workspace.users.owner.id,
    });

    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        window_id: windowId,
        corrections: [{ field_path: 'current', value: 1 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );
    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: automationId,
        window_id: otherWindowId,
        corrections: [{ field_path: 'other', value: 2 }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    const filtered = (await manageAutomations(
      {
        action: 'get_feedback',
        automation_id: automationId,
        window_id: otherWindowId,
      } as never,
      {} as never,
      ownerCtx(workspace)
    )) as { feedback: Array<{ field_path: string }> };

    expect(filtered.feedback).toHaveLength(1);
    expect(filtered.feedback[0].field_path).toBe('other');
  });

  it('rejects malformed corrections and cross-org automation/window ids', async () => {
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: automationId,
          window_id: windowId,
          corrections: [],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/non-empty array/);

    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: automationId,
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
    const foreign = await seedAutomation(other, 'foreign');
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: foreign.automationId,
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
  // Canvas-on-events: seedAutomation already creates the canvas chain ROOT (its id
  // IS seeded.windowId), so no separate seeding is needed — the root is the
  // event submit_feedback supersedes.

  it('materializes a superseding canvas_state with the correction applied AND still writes advisory events', async () => {
    const seeded = await seedAutomation(workspace, `materialize-${Date.now()}`);
    const rootId = seeded.windowId;

    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
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
        AND (metadata->>'automation_id')::bigint = ${Number(seeded.automationId)}
        AND metadata->>'field_path' = 'problems[0].severity'
    `;
    expect(advisory).toHaveLength(1);

    // A superseding canvas_state event exists with the correction applied.
    const head = await getTestDb()`
      SELECT e.id, e.payload_data, e.supersedes_event_id,
             (e.metadata->>'root_event_id')::bigint AS root_event_id, e.created_by
      FROM events e
      WHERE e.semantic_type = 'canvas_state'
        AND (e.metadata->>'automation_id')::bigint = ${Number(seeded.automationId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(head).toHaveLength(1);
    expect(Number(head[0].supersedes_event_id)).toBe(rootId);
    expect(Number(head[0].root_event_id)).toBe(rootId);
    expect(head[0].created_by).toBe(workspace.users.owner.id);
    const problems = (head[0].payload_data as { problems: Array<{ severity: string }> }).problems;
    expect(problems[0].severity).toBe('high');
  });

  /**
   * The correction is the SECOND writer of this chain. `complete_window` clamps
   * its head to `min(window_end, now())`; if the correction keeps stamping a
   * flat `window_end`, then on a window that is still open the uncorrected head
   * is visible and the corrected one is not — correcting today's canvas makes
   * it disappear until the window closes. Both writers go through
   * `automationOutputOccurredAt` for exactly this reason.
   */
  it('stamps a correction when it was made, not at a still-future window_end', async () => {
    const windowEnd = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const seeded = await seedAutomation(workspace, `open-window-${Date.now()}`, windowEnd);

    // Precondition, not decoration: a window that has already closed makes the
    // clamp a no-op and this test's green would mean nothing.
    expect(windowEnd.getTime()).toBeGreaterThan(Date.now());

    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
        window_id: seeded.windowId,
        corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
      } as never,
      {} as never,
      ownerCtx(workspace)
    );

    const head = await getTestDb()`
      SELECT e.occurred_at, e.created_at
      FROM events e
      WHERE e.semantic_type = 'canvas_state'
        AND (e.metadata->>'automation_id')::bigint = ${Number(seeded.automationId)}
        AND e.supersedes_event_id IS NOT NULL
    `;
    expect(head).toHaveLength(1);
    expect(new Date(head[0].occurred_at as string).getTime()).toBeLessThanOrEqual(
      Date.now()
    );
    // The stamp is the moment of correction, strictly before the window end it
    // used to be pinned to.
    expect(new Date(head[0].occurred_at as string).getTime()).toBeLessThan(
      windowEnd.getTime()
    );
  });

  it('concurrent supersede of the same head loses with 409', async () => {
    const seeded = await seedAutomation(workspace, `concurrent-${Date.now()}`);
    const rootId = seeded.windowId;

    // First correction supersedes the root → becomes the head.
    await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
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
          metadata: {
            automation_id: Number(seeded.automationId),
            root_event_id: rootId,
          },
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
        AND (e.metadata->>'automation_id')::bigint = ${Number(seeded.automationId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(heads).toHaveLength(1);
  });

  it('a prototype-polluting field_path is inert (advisory recorded, payload and prototypes untouched)', async () => {
    const seeded = await seedAutomation(workspace, `pollute-${Date.now()}`);
    // seedAutomation already created the canvas root (payload { problems: [...] }).

    // field_path is caller input — a path through the prototype chain must not
    // assign onto Object.prototype (CodeQL js/prototype-polluting-assignment)
    // and must not become an own key of the payload either.
    const result = (await manageAutomations(
      {
        action: 'submit_feedback',
        automation_id: seeded.automationId,
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
        AND (e.metadata->>'automation_id')::bigint = ${Number(seeded.automationId)}
        AND NOT EXISTS (SELECT 1 FROM events n WHERE n.supersedes_event_id = e.id)
    `;
    expect(head).toHaveLength(1);
    const payload = head[0].payload_data as Record<string, unknown>;
    // The seedAutomation root payload is unchanged; the forbidden paths were no-ops.
    expect(payload.problems).toEqual([{ name: 'A', severity: 'low' }]);
    expect(Object.keys(payload)).not.toContain('polluted');
    expect(Object.keys(payload)).not.toContain('polluted2');
  });

  it('rejects a window_id that is not a live canvas chain root', async () => {
    // Canvas-on-events: window_id must resolve to a live canvas_state chain root
    // (the identity row). A non-existent / non-root id is scoped out by the
    // window check, so submit_feedback throws "Window not found" before writing
    // anything — the old "skip materialization when no chain" path is now
    // architecturally unreachable (window_id IS the root event id).
    const seeded = await seedAutomation(workspace, `nochain-${Date.now()}`);
    await expect(
      manageAutomations(
        {
          action: 'submit_feedback',
          automation_id: seeded.automationId,
          window_id: 999_999_999,
          corrections: [{ field_path: 'problems[0].severity', value: 'high' }],
        } as never,
        {} as never,
        ownerCtx(workspace)
      )
    ).rejects.toThrow(/not found/i);
  });
});
