/**
 * Windows-as-events (P6) phase 1: a trigger populates event_edges 'membership' edges from
 * watcher_window_events inserts, resolving org via window -> watcher_windows.watcher_id ->
 * watchers.organization_id (the window's owning watcher; NOT NULL, FK-backed, so always
 * resolvable — the defensive org-NULL skip is belt-and-suspenders). watcher_id_hint = the
 * window's watcher_id, matching the exclude_watcher_id consumer filter. Additive — nothing
 * reads event_edges yet (reads flip in staging-gated phases 2-4).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

async function seed(suffix: string, base: number) {
  const org = await createTestOrganization({ name: `Edge Org ${suffix}` });
  const user = await createTestUser({ email: `edge-${suffix}@test.com` });
  const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
  const event = await createTestEvent({ content: `c-${suffix}`, organization_id: org.id });
  const watcherId = base;
  await sql`
    INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
    VALUES (${watcherId}, ${`w-${suffix}`}, ${`w-${suffix}`}, ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
  `;
  const windowId = base + 1;
  await sql`
    INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
    VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
  `;
  return { orgId: org.id, watcherId, windowId, eventId: Number(event.id) };
}

async function edges(windowId: number) {
  return (await sql`
    SELECT organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint
    FROM event_edges WHERE parent_event_id = ${windowId}
  `) as Array<{
    organization_id: string;
    parent_event_id: number;
    child_event_id: number;
    edge_type: string;
    watcher_id_hint: number;
  }>;
}

describe('event_edges membership trigger (P6 phase 1)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('creates a membership edge with org + watcher_id_hint resolved from the window watcher', async () => {
    const { orgId, watcherId, windowId, eventId } = await seed('a', 900100);
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${eventId})`;

    const rows = await edges(windowId);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgId);
    expect(Number(rows[0].parent_event_id)).toBe(windowId);
    expect(Number(rows[0].child_event_id)).toBe(eventId);
    expect(Number(rows[0].watcher_id_hint)).toBe(watcherId);
    expect(rows[0].edge_type).toBe('membership');
  });

  it('is idempotent — a re-linked content event does not duplicate the edge', async () => {
    const { windowId, eventId } = await seed('b', 900200);
    await sql`
      INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${eventId})
      ON CONFLICT (window_id, event_id) DO NOTHING
    `;
    // Re-insert the same link (the completion path uses ON CONFLICT DO NOTHING).
    await sql`
      INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${eventId})
      ON CONFLICT (window_id, event_id) DO NOTHING
    `;
    expect(await edges(windowId)).toHaveLength(1);
  });

  it('removes the membership edge when the content link is deleted (window-replace / entity-delete)', async () => {
    const { windowId, eventId } = await seed('del', 900400);
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${eventId})`;
    expect(await edges(windowId)).toHaveLength(1);

    // complete-window.ts (window replace) + entity-management.ts (entity delete) DELETE
    // watcher_window_events; the edge must track that so the mirror stays accurate.
    await sql`DELETE FROM watcher_window_events WHERE window_id = ${windowId} AND event_id = ${eventId}`;
    expect(await edges(windowId)).toHaveLength(0);
  });

  it('edge org is the WATCHER org, even when the linked content event is in another org', async () => {
    // A watcher in org A can legitimately analyze/link an event whose home org is B (via a
    // shared entity/connection). The edge's org is deliberately the WATCHER's org — read-time
    // org isolation comes from the outer content-search scope (keyed on the content event's
    // own org), and the exclude_watcher_id read is keyed on watcher_id_hint, not edge org.
    // Locking this so a future refactor can't "fix" it into a real leak.
    const { orgId: orgA, windowId } = await seed('xorg', 900300);
    const orgB = await createTestOrganization({ name: 'Edge Org B' });
    const eventB = await createTestEvent({ content: 'cross-org', organization_id: orgB.id });
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${Number(eventB.id)})`;

    const rows = await edges(windowId);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(orgA); // edge org = watcher's org A
    const [ev] = (await sql`
      SELECT organization_id FROM events WHERE id = ${Number(eventB.id)}
    `) as Array<{ organization_id: string }>;
    expect(ev.organization_id).toBe(orgB.id); // content event keeps its own home org B
  });
});
