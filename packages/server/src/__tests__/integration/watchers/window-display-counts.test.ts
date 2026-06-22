/**
 * Windows-as-events (P6) phase 3c: the display/admin window reads (get_watchers classification
 * stats, shared.ts analyzed_count, index.ts window content_count) flip iwc/iwf from
 * watcher_window_events to event_edges with aggregate column renames (COUNT(event_id) ->
 * COUNT(child_event_id), window_id -> parent_event_id). This proves the renames preserve the
 * COUNTS — the rename risk — by running the membership-count + classification-stats shapes both
 * ways and asserting identical results.
 */

import { describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

describe('window display-count read flip equivalence (P6 phase 3c)', () => {
  it('membership COUNT + classification stats are identical from the table and event_edges', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'WinCount Org' });
    const user = await createTestUser({ email: 'wincount@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });

    const mkEvent = async (slug: string) => {
      const [e] = (await sql`
        INSERT INTO events (organization_id, semantic_type, origin_id, payload_text, occurred_at, created_at)
        VALUES (${org.id}, 'content', ${slug}, 'content', NOW(), NOW())
        RETURNING id
      `) as Array<{ id: number }>;
      return Number(e.id);
    };
    const e1 = await mkEvent('wc_1');
    const e2 = await mkEvent('wc_2');
    await mkEvent('wc_unlinked'); // NOT in the window

    const watcherId = 961000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-wc', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 961001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    // Link e1 + e2 → the phase-1 trigger populates 2 event_edges membership edges.
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${e1}), (${windowId}, ${e2})`;

    // index/shared shape: COUNT of window content via each source.
    const countTable = (await sql`
      SELECT CAST(COUNT(iwf.event_id) AS INTEGER) AS n
      FROM watcher_windows iw
      LEFT JOIN watcher_window_events iwf ON iwf.window_id = iw.id
      WHERE iw.id = ${windowId}
    `) as Array<{ n: number }>;
    const countEdges = (await sql`
      SELECT CAST(COUNT(iwf.child_event_id) AS INTEGER) AS n
      FROM watcher_windows iw
      LEFT JOIN event_edges iwf ON iwf.parent_event_id = iw.id AND iwf.edge_type = 'membership'
      WHERE iw.id = ${windowId}
    `) as Array<{ n: number }>;
    expect(countEdges[0].n).toBe(countTable[0].n);
    expect(countTable[0].n).toBe(2);

    // shared analyzed_count shape: COUNT(DISTINCT content) across a watcher's windows.
    const distTable = (await sql`
      SELECT CAST(COUNT(DISTINCT iwc.event_id) AS INTEGER) AS n
      FROM watcher_windows iw
      LEFT JOIN watcher_window_events iwc ON iwc.window_id = iw.id
      WHERE iw.watcher_id = ${watcherId}
    `) as Array<{ n: number }>;
    const distEdges = (await sql`
      SELECT CAST(COUNT(DISTINCT iwc.child_event_id) AS INTEGER) AS n
      FROM watcher_windows iw
      LEFT JOIN event_edges iwc ON iwc.parent_event_id = iw.id AND iwc.edge_type = 'membership'
      WHERE iw.watcher_id = ${watcherId}
    `) as Array<{ n: number }>;
    expect(distEdges[0].n).toBe(distTable[0].n);
    expect(distTable[0].n).toBe(2);

    // get_watchers stats shape: a classifier label on e1 → per-(window,classifier,value) count.
    const [cls] = (await sql`
      INSERT INTO event_classifiers (slug, name, attribute_key, created_by, organization_id, status)
      VALUES ('wc-cls', 'WC', 'attr', ${user.id}, ${org.id}, 'active') RETURNING id
    `) as Array<{ id: number }>;
    const [ver] = (await sql`
      INSERT INTO event_classifier_versions (classifier_id, version, is_current, attribute_values, created_by)
      VALUES (${Number(cls.id)}, 1, true, '[]'::jsonb, ${user.id}) RETURNING id
    `) as Array<{ id: number }>;
    await sql`
      INSERT INTO event_classifications (event_id, classifier_version_id, "values", source)
      VALUES (${e1}, ${Number(ver.id)}, ARRAY['high'], 'embedding')
    `;

    const statsTable = (await sql`
      SELECT iwc.window_id AS window_id, cc.slug AS slug, value AS value, CAST(COUNT(*) AS INTEGER) AS count
      FROM watcher_window_events iwc
      JOIN event_classifications cls ON iwc.event_id = cls.event_id
      JOIN event_classifier_versions ccv ON cls.classifier_version_id = ccv.id
      JOIN event_classifiers cc ON ccv.classifier_id = cc.id
      CROSS JOIN unnest(cls."values") AS t(value)
      WHERE iwc.window_id IN (${windowId})
      GROUP BY iwc.window_id, cc.slug, value
    `) as Array<{ window_id: number; slug: string; value: string; count: number }>;
    const statsEdges = (await sql`
      SELECT iwc.parent_event_id AS window_id, cc.slug AS slug, value AS value, CAST(COUNT(*) AS INTEGER) AS count
      FROM event_edges iwc
      JOIN event_classifications cls ON iwc.child_event_id = cls.event_id
      JOIN event_classifier_versions ccv ON cls.classifier_version_id = ccv.id
      JOIN event_classifiers cc ON ccv.classifier_id = cc.id
      CROSS JOIN unnest(cls."values") AS t(value)
      WHERE iwc.parent_event_id IN (${windowId}) AND iwc.edge_type = 'membership'
      GROUP BY iwc.parent_event_id, cc.slug, value
    `) as Array<{ window_id: number; slug: string; value: string; count: number }>;
    expect(statsEdges).toEqual(statsTable);
    expect(statsTable).toEqual([{ window_id: windowId, slug: 'wc-cls', value: 'high', count: 1 }]);
  });
});
