/**
 * Windows-as-events (P6) phase 3e: the membership WRITES (complete-window INSERT/DELETE,
 * entity-management DELETE cascades) write event_edges directly when WATCHER_WINDOWS_WRITE_VIA_EVENT_EDGES
 * is set, skipping watcher_window_events. This proves the direct-written edge is IDENTICAL in shape
 * to what the phase-1 trigger produces (org from the watcher, watcher_id_hint, edge_type), and that
 * the dedup constraint collapses any overlap.
 */

import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestOrganization, createTestUser } from '../../setup/test-fixtures';

const sql = getTestDb();

describe('window membership write flip (P6 phase 3e)', () => {
  it('direct event_edges write matches the trigger edge; dedup collapses overlap', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'WWrite Org' });
    const user = await createTestUser({ email: 'wwrite@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });

    const mkEvent = async (slug: string) => {
      const [e] = (await sql`
        INSERT INTO events (organization_id, semantic_type, origin_id, payload_text, occurred_at, created_at)
        VALUES (${org.id}, 'content', ${slug}, 'c', NOW(), NOW()) RETURNING id
      `) as Array<{ id: number }>;
      return Number(e.id);
    };
    const eTrig = await mkEvent('ww_trig');
    const eDirect = await mkEvent('ww_direct');

    const watcherId = 964000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-ww', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 964001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;

    // Trigger path: INSERT watcher_window_events -> phase-1 trigger -> edge for eTrig.
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${eTrig})`;

    // Direct path (the write flip's exact INSERT) for eDirect.
    await sql`
      INSERT INTO event_edges (organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint, created_at)
      VALUES (${org.id}, ${windowId}, ${eDirect}, 'membership', ${watcherId}, NOW())
      ON CONFLICT (parent_event_id, child_event_id, edge_type) DO NOTHING
    `;

    const edge = async (child: number) => {
      const [r] = (await sql`
        SELECT organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint
        FROM event_edges WHERE child_event_id = ${child} AND edge_type = 'membership'
      `) as Array<{
        organization_id: string;
        parent_event_id: number;
        child_event_id: number;
        edge_type: string;
        watcher_id_hint: number;
      }>;
      return r;
    };
    const trigEdge = await edge(eTrig);
    const directEdge = await edge(eDirect);

    // Same shape except the child (org, parent=window, edge_type, watcher_id_hint all identical).
    expect(directEdge.organization_id).toBe(trigEdge.organization_id);
    expect(Number(directEdge.parent_event_id)).toBe(Number(trigEdge.parent_event_id));
    expect(directEdge.edge_type).toBe(trigEdge.edge_type);
    expect(Number(directEdge.watcher_id_hint)).toBe(Number(trigEdge.watcher_id_hint));
    expect(directEdge.organization_id).toBe(org.id);
    expect(Number(directEdge.watcher_id_hint)).toBe(watcherId);

    // Dedup: re-writing the same direct edge (e.g. an old-pod trigger write racing a new-pod
    // direct write) collapses to one row.
    await sql`
      INSERT INTO event_edges (organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint, created_at)
      VALUES (${org.id}, ${windowId}, ${eDirect}, 'membership', ${watcherId}, NOW())
      ON CONFLICT (parent_event_id, child_event_id, edge_type) DO NOTHING
    `;
    const dupCount = (await sql`
      SELECT COUNT(*)::int AS n FROM event_edges WHERE child_event_id = ${eDirect} AND edge_type = 'membership'
    `) as Array<{ n: number }>;
    expect(dupCount[0].n).toBe(1);
  });
});
