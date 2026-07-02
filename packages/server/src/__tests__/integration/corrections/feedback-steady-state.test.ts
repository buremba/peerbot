/**
 * Correction-events (P1) STEADY STATE (post phase-4 contract): watcher_window_field_feedback is
 * retired; every submit emits a correction event directly and every read comes from the events
 * spine (semantic_type='correction'). No flags, no table. This is the end-state round-trip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleGetFeedback,
  handleSubmitFeedback,
} from '../../../tools/admin/manage_watchers/feedback';
import type { ToolContext } from '../../../tools/registry';
import { getRecentFeedbackSummary } from '../../../utils/watcher-feedback';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createCanvasWindow,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

describe('feedback correction-events steady state (P1 phase 4)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('submit -> get -> summary round-trips entirely through correction events (no table)', async () => {
    const org = await createTestOrganization({ name: 'FSS Org' });
    const user = await createTestUser({ email: 'fss@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const watcherId = 953000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-fss', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    // Canvas-on-events: the window is a canvas_state chain root; its event id is
    // the window_id submit_feedback keys on.
    const windowId = await createCanvasWindow({
      watcherId,
      organizationId: org.id,
      granularity: 'daily',
      windowStart: new Date(),
      windowEnd: new Date(),
      createdBy: user.id,
    });
    const ctx = { organizationId: org.id, userId: user.id } as ToolContext;

    const submitted = await handleSubmitFeedback(
      {
        watcher_id: watcherId,
        window_id: windowId,
        corrections: [
          { field_path: 'a', mutation: 'set', value: 'v', note: 'n' },
          { field_path: 'b', mutation: 'remove' },
        ],
      } as never,
      ctx
    );
    expect((submitted as { feedback_ids: number[] }).feedback_ids).toHaveLength(2);

    // The table is retired — this PR's migration drops it; the submit went entirely to events.
    const reg = (await sql`
      SELECT to_regclass('public.watcher_window_field_feedback') AS t
    `) as Array<{ t: string | null }>;
    expect(reg[0].t).toBeNull();

    // get_feedback returns both, from events, with recovered ids + org scoping.
    const got = (await handleGetFeedback({ watcher_id: watcherId } as never, ctx)) as {
      feedback: Array<{ id: number; field_path: string; mutation: string; created_by: string }>;
    };
    expect(got.feedback).toHaveLength(2);
    expect(got.feedback.every((f) => Number.isFinite(f.id) && f.created_by === user.id)).toBe(true);
    expect(got.feedback.map((f) => f.field_path).sort()).toEqual(['a', 'b']);

    // The prompt summary renders the latest-per-field corrections from events.
    const summary = await getRecentFeedbackSummary(watcherId);
    expect(summary).toContain('"a" → v');
    expect(summary).toContain('drop "b"');
  });
});
