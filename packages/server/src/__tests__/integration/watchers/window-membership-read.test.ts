/**
 * Windows-as-events (P6) phase 3: the content-search window-membership reads (the window_id
 * filter — windowJoinSql + buildStandardWhereSql + the list-path EXISTS) read from the
 * event_edges mirror (parent_event_id = window id, edge_type='membership') instead of
 * watcher_window_events, behind WATCHER_WINDOWS_VIA_EVENT_EDGES. This proves the two paths return
 * the SAME content for a window_id filter — the flag selects the source, not the result.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchContentByText } from '../../../utils/content-search';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

describe('window-membership read flip equivalence (P6 phase 3)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.WATCHER_WINDOWS_VIA_EVENT_EDGES;
  });

  it('the window_id filter returns the same content from the table and the event_edges mirror', async () => {
    const org = await createTestOrganization({ name: 'Win Org' });
    const user = await createTestUser({ email: 'win@test.com' });
    const entity = await createTestEntity({
      organization_id: org.id,
      created_by: user.id,
      name: 'WinEntity',
    });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });

    const mkEvent = async (slug: string, text: string) => {
      const [e] = (await sql`
        INSERT INTO events (organization_id, semantic_type, entity_ids, origin_id, payload_text, occurred_at, created_at)
        VALUES (${org.id}, 'content', ARRAY[${Number(entity.id)}]::bigint[], ${slug}, ${text}, NOW(), NOW())
        RETURNING id
      `) as Array<{ id: number }>;
      return Number(e.id);
    };
    const inWin = await mkEvent('win_in', 'in window content');
    await mkEvent('win_out', 'out of window content'); // entity-linked but NOT in the window

    const watcherId = 960000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-win', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 960001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    // Link the in-window event — the phase-1 trigger populates the event_edges membership edge.
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${inWin})`;

    const runList = async () => {
      const res = await searchContentByText(null, {
        organization_id: org.id,
        entity_id: Number(entity.id),
        window_id: windowId,
        limit: 50,
      });
      return res.content.map((c) => Number(c.id)).sort((a, b) => a - b);
    };

    delete process.env.WATCHER_WINDOWS_VIA_EVENT_EDGES;
    const off = await runList();
    process.env.WATCHER_WINDOWS_VIA_EVENT_EDGES = '1';
    const on = await runList();

    expect(off).toEqual([inWin]); // the table path returns only the in-window event
    expect(on).toEqual(off); // the event_edges path returns the identical set
  });
});
