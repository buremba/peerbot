/**
 * Correction-events (P1) phase 1: watcher_window_field_feedback (append-only window-field
 * corrections) is mirrored into the events spine as semantic_type='correction' by a trigger.
 * Additive — nothing reads the correction events yet. Pollution-safe (entity_ids=[], no
 * payload_text, semantic_type='correction'); FK-safe created_by (NULL if not a valid user).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

async function seedWatcherWindow(orgId: string, userId: string, agentId: string) {
  const watcherId = 950000;
  await sql`
    INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
    VALUES (${watcherId}, 'w', 'w-fc', ${userId}, ${orgId}, ${agentId}, ${watcherId})
  `;
  const windowId = 950001;
  await sql`
    INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
    VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
  `;
  return { watcherId, windowId };
}

describe('feedback -> correction-event mirror (P1 phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('mirrors a feedback row into a pollution-safe correction event', async () => {
    const org = await createTestOrganization({ name: 'FC Org' });
    const user = await createTestUser({ email: 'fc@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const { watcherId, windowId } = await seedWatcherWindow(org.id, user.id, agent.agentId);

    const [fb] = (await sql`
      INSERT INTO watcher_window_field_feedback
        (window_id, watcher_id, organization_id, field_path, mutation, corrected_value, note, created_by)
      VALUES (${windowId}, ${watcherId}, ${org.id}, 'a.b', 'set', '"v"'::jsonb, 'note1', ${user.id})
      RETURNING id
    `) as Array<{ id: number }>;
    const fbId = Number(fb.id);

    const [ev] = (await sql`
      SELECT organization_id, semantic_type, entity_ids, payload_text, created_by, metadata
      FROM events WHERE origin_id = ${`wwff_${fbId}`}
    `) as Array<{
      organization_id: string;
      semantic_type: string;
      entity_ids: number[] | string | null;
      payload_text: string | null;
      created_by: string | null;
      metadata: Record<string, unknown>;
    }>;

    expect(ev).toBeDefined();
    expect(ev.semantic_type).toBe('correction');
    expect(ev.organization_id).toBe(org.id);
    // pollution-safe: not entity-linked (empty bigint[] — driver returns it as '{}' or [])
    const eids = ev.entity_ids;
    expect(eids === '{}' || (Array.isArray(eids) && eids.length === 0)).toBe(true);
    expect(ev.payload_text).toBeNull(); // pollution-safe: not embedded/searchable
    expect(ev.created_by).toBe(user.id);
    expect(ev.metadata.window_id).toBe(windowId);
    expect(ev.metadata.watcher_id).toBe(watcherId);
    expect(ev.metadata.field_path).toBe('a.b');
    expect(ev.metadata.mutation).toBe('set');
    expect(ev.metadata.corrected_value).toBe('v');
    expect(ev.metadata.note).toBe('note1');
  });

  it('correction events do NOT pollute the org-root content count or recent list (Spike F)', async () => {
    const org = await createTestOrganization({ name: 'FC Noise Org' });
    const user = await createTestUser({ email: 'fcn@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const { watcherId, windowId } = await seedWatcherWindow(org.id, user.id, agent.agentId);

    // A normal content event (counted) + a correction (mirrored from feedback, must NOT count).
    await sql`
      INSERT INTO events (organization_id, semantic_type, origin_id, payload_text, created_by)
      VALUES (${org.id}, 'content', 'real_1', 'hello', ${user.id})
    `;
    await sql`
      INSERT INTO watcher_window_field_feedback
        (window_id, watcher_id, organization_id, field_path, mutation, corrected_value, note, created_by)
      VALUES (${windowId}, ${watcherId}, ${org.id}, 'x', 'set', '"v"'::jsonb, NULL, ${user.id})
    `;

    // The resolve_path bootstrap queries, with the Spike F exclusion.
    const [{ total_content }] = (await sql`
      SELECT COUNT(*)::int AS total_content FROM current_event_records ev
      WHERE ev.organization_id = ${org.id} AND ev.semantic_type <> 'correction'
    `) as Array<{ total_content: number }>;
    expect(total_content).toBe(1); // only the content event, not the correction

    const recent = (await sql`
      SELECT ev.id, ev.semantic_type FROM current_event_records ev
      WHERE ev.organization_id = ${org.id} AND ev.semantic_type <> 'correction'
      ORDER BY COALESCE(ev.occurred_at, ev.created_at) DESC
    `) as Array<{ semantic_type: string }>;
    expect(recent).toHaveLength(1);
    expect(recent[0].semantic_type).toBe('content');
  });
});
