/**
 * Correction-events (P1) phase 3 — the WRITE flip. When FEEDBACK_WRITE_VIA_CORRECTIONS is set,
 * handleSubmitFeedback emits the correction event DIRECTLY (id from the table's own sequence so
 * origin_id stays 'wwff_<id>') and SKIPS the watcher_window_field_feedback INSERT. This proves
 * the direct-emitted event is IDENTICAL in shape to the phase-1 trigger path, and that no table
 * row is written — the precondition for phase-4 DROP TABLE.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleSubmitFeedback } from '../../../tools/admin/manage_watchers/feedback';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('feedback write flip (P1 phase 3)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.FEEDBACK_WRITE_VIA_CORRECTIONS;
  });

  it('direct-emits a correction event identical to the trigger path and skips the table', async () => {
    const org = await createTestOrganization({ name: 'FWF Org' });
    const user = await createTestUser({ email: 'fwf@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const watcherId = 952000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-fwf', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 952001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    const ctx = { organizationId: org.id, userId: user.id } as ToolContext;
    const corr = (fp: string) => ({
      watcher_id: watcherId,
      window_id: windowId,
      corrections: [{ field_path: fp, mutation: 'set', value: 'v', note: 'n' }],
    });

    // Field 'x' via the TABLE path (trigger mirrors it). Field 'y' via the DIRECT path.
    delete process.env.FEEDBACK_WRITE_VIA_CORRECTIONS;
    await handleSubmitFeedback(corr('x') as never, ctx);
    process.env.FEEDBACK_WRITE_VIA_CORRECTIONS = '1';
    // 'y' = set; 'z' = remove (NULL corrected_value — exercises the ::jsonb param cast).
    await handleSubmitFeedback(
      {
        watcher_id: watcherId,
        window_id: windowId,
        corrections: [
          { field_path: 'y', mutation: 'set', value: 'v', note: 'n' },
          { field_path: 'z', mutation: 'remove' },
        ],
      } as never,
      ctx
    );

    const events = (await sql`
      SELECT semantic_type, entity_ids, created_by, metadata, origin_id
      FROM events WHERE semantic_type = 'correction' AND organization_id = ${org.id}
      ORDER BY (metadata->>'field_path')
    `) as Array<{
      semantic_type: string;
      entity_ids: number[] | string | null;
      created_by: string | null;
      metadata: Record<string, unknown>;
      origin_id: string;
    }>;

    expect(events).toHaveLength(3); // trigger ('x') + direct set ('y') + direct remove ('z')
    const byField = Object.fromEntries(events.map((e) => [e.metadata.field_path as string, e]));
    const x = byField.x;
    const y = byField.y;

    // The direct-emitted 'y' event matches the trigger-emitted 'x' event in every shared field.
    for (const e of [x, y]) {
      expect(e.semantic_type).toBe('correction');
      expect(e.created_by).toBe(user.id);
      expect(e.origin_id).toMatch(/^wwff_\d+$/);
      expect(e.entity_ids === '{}' || (Array.isArray(e.entity_ids) && e.entity_ids.length === 0)).toBe(true);
      expect(e.metadata.watcher_id).toBe(watcherId);
      expect(e.metadata.window_id).toBe(windowId);
      expect(e.metadata.mutation).toBe('set');
      expect(e.metadata.corrected_value).toBe('v');
      expect(e.metadata.note).toBe('n');
    }

    // The 'remove' correction direct-emitted with a NULL corrected_value (the ::jsonb-cast path).
    expect(byField.z.metadata.mutation).toBe('remove');
    expect(byField.z.metadata.corrected_value).toBeNull();

    // The DIRECT path wrote NO table row; only the table path ('x') did.
    const tableRows = (await sql`
      SELECT field_path FROM watcher_window_field_feedback WHERE watcher_id = ${watcherId}
    `) as Array<{ field_path: string }>;
    expect(tableRows.map((r) => r.field_path)).toEqual(['x']);
  });
});
