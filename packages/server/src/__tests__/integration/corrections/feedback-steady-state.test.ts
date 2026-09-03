/**
 * Correction-events (P1) STEADY STATE (post phase-4 contract): the dedicated
 * window-feedback table is retired; every submit emits a correction event
 * directly and every read comes from the events spine
 * (semantic_type='correction'). No flags, no table. This is the end-state
 * round-trip.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  handleGetFeedback,
  handleSubmitFeedback,
} from '../../../tools/admin/manage_automations/feedback';
import type { ToolContext } from '../../../tools/registry';
import { getRecentFeedbackSummary } from '../../../utils/automation-feedback';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createAutomationResultRun,
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
    const automationId = 953000;
    await sql`
      INSERT INTO automations (id, name, slug, created_by, organization_id, managed_agent_id, automation_group_id)
      VALUES (${automationId}, 'w', 'w-fss', ${user.id}, ${org.id}, ${agent.agentId}, ${automationId})
    `;
    const runId = await createAutomationResultRun({
      automationId,
      organizationId: org.id,
      windowStart: new Date(),
      windowEnd: new Date(),
      createdBy: user.id,
    });
    const ctx = { organizationId: org.id, userId: user.id } as ToolContext;

    const submitted = await handleSubmitFeedback(
      {
        automation_id: automationId,
        run_id: runId,
        corrections: [
          { field_path: 'a', mutation: 'set', value: 'v', note: 'n' },
          { field_path: 'b', mutation: 'remove' },
        ],
      } as never,
      ctx
    );
    expect((submitted as { feedback_ids: number[] }).feedback_ids).toHaveLength(2);

    // The table is retired — the submit went entirely to events. Match the
    // structural name instead of naming the pre-cutover relation in live code.
    const reg = (await sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname LIKE '%window%field%feedback%'
    `) as Array<{ relname: string }>;
    expect(reg).toEqual([]);

    // get_feedback returns both, from events, with recovered ids + org scoping.
    const got = (await handleGetFeedback({ automation_id: automationId } as never, ctx)) as {
      feedback: Array<{ id: number; field_path: string; mutation: string; created_by: string }>;
    };
    expect(got.feedback).toHaveLength(2);
    expect(got.feedback.every((f) => Number.isFinite(f.id) && f.created_by === user.id)).toBe(true);
    expect(got.feedback.map((f) => f.field_path).sort()).toEqual(['a', 'b']);

    // The prompt summary renders the latest-per-field corrections from events.
    const summary = await getRecentFeedbackSummary(automationId);
    expect(summary).toContain('"a" → v');
    expect(summary).toContain('drop "b"');
  });
});
