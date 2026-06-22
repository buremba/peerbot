/**
 * Windows-as-events (P6) STEADY STATE (post phase-4 drop): watcher_window_events is retired;
 * window membership lives ONLY in event_edges. Window reads (membership filter + exclude) and the
 * write path all go through event_edges. This seeds event_edges directly (the table + trigger are
 * gone) and verifies the now-only read paths.
 */

import { describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

describe('event_edges membership steady state (P6 phase 4)', () => {
  it('window_id filter + exclude_watcher_id read from event_edges only; the table is gone', async () => {
    await cleanupTestDatabase();
    // The drop migration ran in setup — watcher_window_events no longer exists.
    const reg = (await sql`SELECT to_regclass('public.watcher_window_events') AS t`) as Array<{
      t: string | null;
    }>;
    expect(reg[0].t).toBeNull();

    const org = await createTestOrganization({ name: 'EE Steady Org' });
    const user = await createTestUser({ email: 'eesteady@test.com' });
    const entity = await createTestEntity({
      organization_id: org.id,
      created_by: user.id,
      name: 'EEEntity',
    });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });

    const mkEvent = async (slug: string) => {
      const [e] = (await sql`
        INSERT INTO events (organization_id, semantic_type, entity_ids, origin_id, payload_text, occurred_at, created_at)
        VALUES (${org.id}, 'content', ARRAY[${Number(entity.id)}]::bigint[], ${slug}, 'c', NOW(), NOW())
        RETURNING id
      `) as Array<{ id: number }>;
      return Number(e.id);
    };
    const inWin = await mkEvent('ee_in');
    const outWin = await mkEvent('ee_out');

    const watcherId = 965000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-ee', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 965001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    // Membership lives directly in event_edges now.
    await sql`
      INSERT INTO event_edges (organization_id, parent_event_id, child_event_id, edge_type, watcher_id_hint, created_at)
      VALUES (${org.id}, ${windowId}, ${inWin}, 'membership', ${watcherId}, NOW())
    `;

    // window_id filter → only the in-window content.
    const byWindow = await searchContentByText(null, {
      organization_id: org.id,
      entity_id: Number(entity.id),
      window_id: windowId,
      limit: 50,
    });
    expect(byWindow.content.map((c) => Number(c.id)).sort((a, b) => a - b)).toEqual([inWin]);

    // exclude_watcher_id → drops content already in a window of this watcher.
    const excluded = await searchContentByText(null, {
      organization_id: org.id,
      entity_id: Number(entity.id),
      exclude_watcher_id: watcherId,
      limit: 50,
    });
    const excludedIds = excluded.content.map((c) => Number(c.id));
    expect(excludedIds).toContain(outWin); // not in a window → kept
    expect(excludedIds).not.toContain(inWin); // in a window of this watcher → excluded

    // Display-count shapes (get_watchers stats / shared.ts analyzed_count / index.ts content_count)
    // now read event_edges with the renamed columns — assert the COUNT is correct post-drop.
    const cnt = (await sql`
      SELECT CAST(COUNT(iwc.child_event_id) AS INTEGER) AS n
      FROM watcher_windows iw
      LEFT JOIN event_edges iwc ON iwc.parent_event_id = iw.id AND iwc.edge_type = 'membership'
      WHERE iw.watcher_id = ${watcherId}
    `) as Array<{ n: number }>;
    expect(cnt[0].n).toBe(1); // the single in-window edge
  });
});
