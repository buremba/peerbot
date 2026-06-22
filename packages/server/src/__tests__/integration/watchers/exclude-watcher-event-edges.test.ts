/**
 * Windows-as-events (P6) phase 2: buildExcludeWatcherClause reads membership from the
 * event_edges mirror when WATCHER_EXCLUDE_VIA_EVENT_EDGES is set, instead of the
 * watcher_window_events -> watcher_windows JOIN. This proves the two clauses are EQUIVALENT
 * (same content excluded) — the flag selects the path, not the result. Flag-gated so the hot
 * read (every read_knowledge()) can be A/B latency-validated in staging before cutover.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildExcludeWatcherClause } from '../../../utils/content-search/visibility';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const sql = getTestDb();

// Returns true if the event is EXCLUDED (filtered out) by the current clause path.
async function isExcluded(eventId: number, watcherId: number): Promise<boolean> {
  const clause = buildExcludeWatcherClause(watcherId, 1, 'f');
  const rows = await sql.unsafe(`SELECT f.id FROM events f WHERE f.id = $2 ${clause.sql}`, [
    clause.params[0],
    eventId,
  ]);
  return rows.length === 0;
}

describe('exclude_watcher_id read flip equivalence (P6 phase 2)', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });
  afterEach(() => {
    delete process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES;
  });

  it('the event_edges clause excludes exactly the same content as the watcher_window_events JOIN', async () => {
    const org = await createTestOrganization({ name: 'Excl Org' });
    const user = await createTestUser({ email: 'excl@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const linked = Number((await createTestEvent({ content: 'linked', organization_id: org.id })).id);
    const unlinked = Number(
      (await createTestEvent({ content: 'unlinked', organization_id: org.id })).id
    );
    const watcherId = 901000;
    await sql`
      INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
      VALUES (${watcherId}, 'w', 'w-excl', ${user.id}, ${org.id}, ${agent.agentId}, ${watcherId})
    `;
    const windowId = 901001;
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${windowId}, ${watcherId}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    // Linking the content fires the phase-1 trigger → event_edges membership edge.
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${windowId}, ${linked})`;

    // OLD path (flag off): watcher_window_events JOIN.
    delete process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES;
    expect(await isExcluded(linked, watcherId)).toBe(true);
    expect(await isExcluded(unlinked, watcherId)).toBe(false);

    // NEW path (flag on): event_edges. Same result on both rows.
    process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES = '1';
    expect(await isExcluded(linked, watcherId)).toBe(true);
    expect(await isExcluded(unlinked, watcherId)).toBe(false);

    // And after the link is removed (window-replace / entity-delete), neither path excludes it
    // (the DELETE trigger keeps the mirror accurate).
    await sql`DELETE FROM watcher_window_events WHERE window_id = ${windowId} AND event_id = ${linked}`;
    expect(await isExcluded(linked, watcherId)).toBe(false);
    delete process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES;
    expect(await isExcluded(linked, watcherId)).toBe(false);
  });

  it('multi-window (same watcher) and different-watcher cases match under both flag states', async () => {
    const org = await createTestOrganization({ name: 'Excl Org 2' });
    const user = await createTestUser({ email: 'excl2@test.com' });
    const agent = await createTestAgent({ organizationId: org.id, ownerUserId: user.id });
    const evtMulti = Number((await createTestEvent({ content: 'multi', organization_id: org.id })).id);
    const evtOther = Number((await createTestEvent({ content: 'other', organization_id: org.id })).id);
    const N = 902000;
    const M = 902100;
    for (const [wid, slug] of [
      [N, 'n'],
      [M, 'm'],
    ] as const) {
      await sql`
        INSERT INTO watchers (id, name, slug, created_by, organization_id, agent_id, watcher_group_id)
        VALUES (${wid}, ${slug}, ${`w-${slug}`}, ${user.id}, ${org.id}, ${agent.agentId}, ${wid})
      `;
    }
    // N: TWO windows (distinct periods — the unique (watcher,start,end) constraint) both link
    // evtMulti (multi-window same watcher → must still exclude once, not double-count).
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${N + 1}, ${N}, 'daily', NOW() - interval '1 day', NOW(), 0, '{}'::jsonb),
             (${N + 2}, ${N}, 'daily', NOW() - interval '2 day', NOW() - interval '1 day', 0, '{}'::jsonb)
    `;
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${N + 1}, ${evtMulti}), (${N + 2}, ${evtMulti})`;
    // M: one window links evtOther (different watcher).
    await sql`
      INSERT INTO watcher_windows (id, watcher_id, granularity, window_start, window_end, content_analyzed, extracted_data)
      VALUES (${M + 1}, ${M}, 'daily', NOW(), NOW(), 0, '{}'::jsonb)
    `;
    await sql`INSERT INTO watcher_window_events (window_id, event_id) VALUES (${M + 1}, ${evtOther})`;

    for (const flag of [undefined, '1'] as const) {
      if (flag) process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES = flag;
      else delete process.env.WATCHER_EXCLUDE_VIA_EVENT_EDGES;
      expect(await isExcluded(evtMulti, N)).toBe(true); // in 2 windows of N → excluded (once)
      expect(await isExcluded(evtOther, N)).toBe(false); // in M's window, not N's → not excluded by N
      expect(await isExcluded(evtOther, M)).toBe(true); // in M's window → excluded by M
    }
  });
});
