/**
 * Correction-events (P1) phase 2: the feedback readers (getRecentFeedbackSummary prompt summary +
 * handleGetFeedback list) read from the events mirror behind FEEDBACK_VIA_CORRECTIONS. This proves
 * the two paths are EQUIVALENT (same summary + same list), so the flag selects the source, not the
 * result. Flag-gated for a staged cutover before phase 3 drops watcher_window_field_feedback.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleGetFeedback } from '../../../tools/admin/manage_watchers/feedback';
import type { ToolContext } from '../../../tools/registry';
import { getRecentFeedbackSummary } from '../../../utils/watcher-feedback';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('feedback read flip equivalence (P1 phase 2)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.FEEDBACK_VIA_CORRECTIONS;
  });

  it('summary + list reads are identical from the table and the correction-events mirror', async () => {
    const org = await createTestOrganization({ name: 'FRF Org' });
    const user = await createTestUser({ email: 'frf@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const watcherId = 951000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-frf', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 951001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    // Two corrections on field 'a' (latest wins in the DISTINCT ON summary) + one on 'b'.
    await sql`
      INSERT INTO watcher_window_field_feedback
        (window_id, watcher_id, organization_id, field_path, mutation, corrected_value, note, created_by, created_at)
      VALUES
        (${windowId}, ${watcherId}, ${org.id}, 'a', 'set', '"v1"'::jsonb, NULL, ${user.id}, NOW() - interval '1 hour'),
        (${windowId}, ${watcherId}, ${org.id}, 'a', 'set', '"v2"'::jsonb, 'latest', ${user.id}, NOW()),
        (${windowId}, ${watcherId}, ${org.id}, 'b', 'remove', NULL, NULL, ${user.id}, NOW() - interval '30 minutes')
    `;

    delete process.env.FEEDBACK_VIA_CORRECTIONS;
    const summaryOff = await getRecentFeedbackSummary(watcherId);
    process.env.FEEDBACK_VIA_CORRECTIONS = '1';
    const summaryOn = await getRecentFeedbackSummary(watcherId);
    expect(summaryOn).toBe(summaryOff);
    expect(summaryOff).toContain('"a" → v2'); // latest correction won
    expect(summaryOff).toContain('drop "b"');

    const ctx = { organizationId: org.id, userId: user.id } as ToolContext;
    delete process.env.FEEDBACK_VIA_CORRECTIONS;
    const listOff = await handleGetFeedback({ watcher_id: watcherId } as never, ctx);
    process.env.FEEDBACK_VIA_CORRECTIONS = '1';
    const listOn = await handleGetFeedback({ watcher_id: watcherId } as never, ctx);

    const norm = (r: ManageGetFeedback) =>
      (r.feedback as Array<Record<string, unknown>>)
        .map((f) => ({
          id: Number(f.id),
          field_path: f.field_path,
          mutation: f.mutation,
          corrected_value: f.corrected_value ?? null,
          note: f.note ?? null,
          // created_by is asserted too: on the happy path (a valid user) both paths return the
          // user id. (They only diverge AFTER a user is deleted — the table keeps the dangling
          // id, the event shows NULL via its FK SET NULL; that edge is documented, not a bug.)
          created_by: f.created_by,
        }))
        .sort((a, b) => a.id - b.id);
    expect(norm(listOn)).toEqual(norm(listOff)); // identical rows incl. recovered id + created_by
    expect(norm(listOff)).toHaveLength(3);
    expect(norm(listOff)[0].created_by).toBe(user.id);
  });
});

type ManageGetFeedback = Awaited<ReturnType<typeof handleGetFeedback>>;
