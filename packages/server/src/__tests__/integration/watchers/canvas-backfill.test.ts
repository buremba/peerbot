/**
 * Canvas-on-events backfill contract.
 *
 * Locks the behavior of `backfillCanvasEvents` (the one-off fold of historical
 * watcher_windows rows into canvas_state chains): a legacy window gets a chain
 * ROOT event with its original created_at preserved, the denormalized
 * watcher_window_events.watcher_id is filled, replays are no-ops (the partial
 * unique index idx_canvas_chain_root is the lock), and dry-run writes nothing.
 *
 * window_id re-key onto event ids is intentionally NOT covered — it is deferred
 * to Phase 3 because watcher_reactions/runs/watcher_window_events/
 * event_classifications carry live FKs to watcher_windows(id) during the
 * dual-write release (see backfill-canvas-events.ts).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { backfillCanvasEvents } from '../../../watchers/backfill-canvas-events';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('canvas-on-events backfill', () => {
  let workspace: TestWorkspace;
  let watcherId: string;
  let windowId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Canvas Backfill Org' });
    const entity = await createTestEntity({
      name: 'Backfill Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.owner.id,
    });
    const watcher = (await workspace.owner.watchers.create({
      entity_id: entity.id,
      slug: 'canvas-backfill-watcher',
      name: 'Canvas Backfill Watcher',
      prompt: 'Analyze inputs.',
      agent_id: agent.agentId,
    })) as { watcher_id: string };
    watcherId = watcher.watcher_id;

    // A legacy pre-canvas window (no canvas_state chain), created ~3 days ago.
    const [win] = await getTestDb()`
      INSERT INTO watcher_windows (
        watcher_id, granularity, window_start, window_end,
        extracted_data, content_analyzed, model_used, created_at
      ) VALUES (
        ${Number(watcherId)}, 'weekly',
        ${new Date(Date.now() - 7 * DAY_MS)}, ${new Date()},
        ${getTestDb().json({ summary: 'legacy window payload' })},
        0, 'test-model', ${new Date(Date.now() - 3 * DAY_MS)}
      )
      RETURNING id
    `;
    windowId = Number(win.id);

    // A link row with watcher_id unset, as pre-migration rows have.
    const linkEvent = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      content: 'linked content',
      occurred_at: new Date(),
    });
    await getTestDb()`
      INSERT INTO watcher_window_events (window_id, event_id)
      VALUES (${windowId}, ${linkEvent.id})
      ON CONFLICT DO NOTHING
    `;
  });

  it('dry-run reports the pending root but writes nothing', async () => {
    const sql = getTestDb() as unknown as DbClient;
    const dry = await backfillCanvasEvents({ db: sql, execute: false, log: () => {} });
    expect(dry.windows).toBe(1);
    expect(dry.rootsCreated).toBe(1);
    expect(dry.rootsExisting).toBe(0);

    const roots = await getTestDb()`
      SELECT 1 FROM events
      WHERE semantic_type = 'canvas_state'
        AND (metadata->>'watcher_id')::bigint = ${Number(watcherId)}
    `;
    expect(roots).toHaveLength(0);

    const [wwe] = await getTestDb()`
      SELECT watcher_id FROM watcher_window_events WHERE window_id = ${windowId}
    `;
    expect(wwe.watcher_id).toBeNull();
  });

  it('creates the root (created_at preserved), fills watcher_id, and replays as a no-op', async () => {
    const sql = getTestDb() as unknown as DbClient;

    const r1 = await backfillCanvasEvents({ db: sql, execute: true, log: () => {} });
    expect(r1.windows).toBe(1);
    expect(r1.rootsCreated).toBe(1);
    expect(r1.rootsExisting).toBe(0);
    expect(r1.windowEventsWatcherIdFilled).toBe(1);

    // (1) Root exists with the window's original created_at (~3 days ago, not NOW()).
    const roots = await getTestDb()`
      SELECT id, created_at, payload_data FROM events
      WHERE semantic_type = 'canvas_state'
        AND (metadata->>'watcher_id')::bigint = ${Number(watcherId)}
        AND supersedes_event_id IS NULL
    `;
    expect(roots).toHaveLength(1);
    expect(Date.now() - new Date(roots[0].created_at as string).getTime()).toBeGreaterThan(
      2 * DAY_MS
    );
    expect((roots[0].payload_data as Record<string, unknown>).summary).toBe(
      'legacy window payload'
    );

    // (2) Denormalized watcher_id filled; window_id untouched (FK-constrained,
    // re-key deferred to Phase 3).
    const [wwe] = await getTestDb()`
      SELECT window_id, watcher_id FROM watcher_window_events WHERE window_id = ${windowId}
    `;
    expect(Number(wwe.watcher_id)).toBe(Number(watcherId));
    expect(Number(wwe.window_id)).toBe(windowId);

    // (3) Idempotent replay: rootsExisting increments, no duplicate root.
    const r2 = await backfillCanvasEvents({ db: sql, execute: true, log: () => {} });
    expect(r2.rootsCreated).toBe(0);
    expect(r2.rootsExisting).toBe(1);

    const rootsAfterReplay = await getTestDb()`
      SELECT id FROM events
      WHERE semantic_type = 'canvas_state'
        AND (metadata->>'watcher_id')::bigint = ${Number(watcherId)}
        AND supersedes_event_id IS NULL
    `;
    expect(rootsAfterReplay).toHaveLength(1);
    expect(Number(rootsAfterReplay[0].id)).toBe(Number(roots[0].id));
  });
});
