/**
 * Windows-as-events (P6) phase 3d: the watcher_id-keyed window reads (get_watchers "not in any
 * window of this watcher" + the linked-per-month histograms in get_watchers / watcher-mode) read
 * from the event_edges mirror via watcher_id_hint (replacing the watcher_windows JOIN), behind
 * WATCHER_WINDOWS_VIA_EVENT_EDGES. This proves the watcher_id_hint reads return the SAME rows as
 * the watcher_window_events -> watcher_windows JOIN.
 */

import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('watcher-membership (watcher_id_hint) read flip equivalence (P6 phase 3d)', () => {
  it('not-in-window + linked-count are identical from the table-JOIN and the event_edges hint', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'WMem Org' });
    const user = await createTestUser({ email: 'wmem@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });

    const mkEvent = async (slug: string) => {
      const [e] = (await sql`
        INSERT INTO events (organization_id, semantic_type, origin_id, payload_text, occurred_at, created_at)
        VALUES (${org.id}, 'content', ${slug}, 'c', NOW(), NOW())
        RETURNING id
      `) as Array<{ id: number }>;
      return Number(e.id);
    };
    const linked = await mkEvent('wm_linked');
    const unlinked = await mkEvent('wm_unlinked');

    const watcherId = 963000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-wm', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 963001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${linked})`;

    // "NOT in any window of this watcher" — table JOIN vs event_edges hint.
    const notInTable = (await sql`
      SELECT f.id FROM events f
      WHERE f.organization_id = ${org.id}
        AND NOT EXISTS (
          SELECT 1 FROM watcher_window_events iwc
          JOIN watcher_windows iw ON iw.id = iwc.window_id
          WHERE iwc.event_id = f.id AND iw.watcher_id = ${watcherId}
        )
      ORDER BY f.id
    `) as Array<{ id: number }>;
    const notInEdges = (await sql`
      SELECT f.id FROM events f
      WHERE f.organization_id = ${org.id}
        AND NOT EXISTS (
          SELECT 1 FROM event_edges iwc
          WHERE iwc.child_event_id = f.id AND iwc.watcher_id_hint = ${watcherId} AND iwc.edge_type = 'membership'
        )
      ORDER BY f.id
    `) as Array<{ id: number }>;
    expect(notInEdges.map((r) => Number(r.id))).toEqual(notInTable.map((r) => Number(r.id)));
    expect(notInTable.map((r) => Number(r.id))).toEqual([unlinked]); // only the unlinked event

    // linked-count for the watcher — JOIN-through-windows vs hint.
    const linkedTable = (await sql`
      SELECT CAST(COUNT(DISTINCT f.id) AS INTEGER) AS n FROM events f
      JOIN watcher_window_events iwc ON f.id = iwc.event_id
      JOIN watcher_windows iw ON iwc.window_id = iw.id
      WHERE iw.watcher_id = ${watcherId}
    `) as Array<{ n: number }>;
    const linkedEdges = (await sql`
      SELECT CAST(COUNT(DISTINCT f.id) AS INTEGER) AS n FROM events f
      JOIN event_edges iwc ON f.id = iwc.child_event_id AND iwc.edge_type = 'membership'
      WHERE iwc.watcher_id_hint = ${watcherId}
    `) as Array<{ n: number }>;
    expect(linkedEdges[0].n).toBe(linkedTable[0].n);
    expect(linkedTable[0].n).toBe(1); // the one linked event
  });
});
