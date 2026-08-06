/**
 * The one-off backfill that re-stamps Behavior event-output rows written with a
 * POSITIONAL origin_id (`behavior_<id>_<output>_canvas_<revision>_<index>`).
 *
 * The rows this repairs are NOT duplicates: prod Behavior 71 wrote 8 distinct
 * posts under `behavior_71_signals_canvas_4819569_4`, each correctly deduped by
 * its own idempotency key. Only the identifier collided. So the assertion that
 * matters is that after the backfill each row carries its OWN origin_id.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { pgBigintArray } from '../../../db/client';
import { backfillBehaviorOutputOriginId } from '../../../events/backfill-behavior-output-origin-id';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestWorkspace } from '../../setup/test-mcp-client';

describe('backfillBehaviorOutputOriginId', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('gives each collided row its own origin_id and leaves positional rows alone', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Origin Backfill Org' });

    // Three runs of Behavior 71 appending to one Canvas revision, each ranking a
    // different post — exactly the prod shape, all stamped item 4.
    const collided = [
      { sourceKey: '2085095802108866868', title: 'zoink on X' },
      { sourceKey: 'li_home_XBFs8O1_zgvFRN8', title: 'Global Turks AI Lab on LinkedIn' },
      { sourceKey: '2085086999267144083', title: 'PrimeIntellect / x' },
    ];
    const insert = (originId: string, title: string, idempotencyKey: string) =>
      sql<{ id: number }>`
        INSERT INTO events (
          organization_id, origin_id, title, payload_text, semantic_type, client_id, metadata
        ) VALUES (
          ${workspace.org.id}, ${originId}, ${title}, ${title},
          ${'observation'}, NULL, ${sql.json({
            behavior_id: 71,
            behavior_output: 'signals',
            _lobu_idempotency_key: idempotencyKey,
          })}
        )
        RETURNING id
      `;

    const collidedIds: number[] = [];
    for (const row of collided) {
      const inserted = await insert(
        'behavior_71_signals_canvas_4819569_4',
        row.title,
        `behavior:71:output:signals:key:${row.sourceKey}`
      );
      collidedIds.push(Number(inserted[0].id));
    }

    // A row the model gave no idempotency_key for: its identity IS its slot, so
    // the positional origin_id is already honest and must survive untouched.
    const positional = await insert(
      'behavior_71_drafts_canvas_4819569_0',
      'Unkeyed draft',
      'behavior:71:canvas:4819569:output:drafts:item:0'
    );

    const dry = await backfillBehaviorOutputOriginId({ db: sql, execute: false, sleepMs: 0 });
    expect(dry.restamped).toBe(3);
    const stillCollided = await sql<{ origin_id: string }>`
      SELECT origin_id FROM events WHERE id = ANY(${pgBigintArray(collidedIds)}::bigint[]) ORDER BY id
    `;
    expect(new Set(stillCollided.map((r) => r.origin_id)).size).toBe(1);

    const run1 = await backfillBehaviorOutputOriginId({ db: sql, execute: true, sleepMs: 0 });
    expect(run1.restamped).toBe(3);

    const repaired = await sql<{ id: number; origin_id: string; title: string }>`
      SELECT id, origin_id, title FROM events WHERE id = ANY(${pgBigintArray(collidedIds)}::bigint[]) ORDER BY id
    `;
    expect(new Set(repaired.map((r) => r.origin_id)).size).toBe(3);
    expect(repaired.map((r) => r.origin_id)).toEqual(
      collided.map((r) => `behavior_71_signals_key_${r.sourceKey}`)
    );

    const untouched = await sql<{ origin_id: string }>`
      SELECT origin_id FROM events WHERE id = ${positional[0].id}
    `;
    expect(untouched[0].origin_id).toBe('behavior_71_drafts_canvas_4819569_0');

    // Resumable: a second pass re-derives the same names and writes nothing.
    const run2 = await backfillBehaviorOutputOriginId({ db: sql, execute: true, sleepMs: 0 });
    expect(run2.restamped).toBe(0);
    expect(run2.alreadyCorrect).toBe(3);
  });

  it('rejects knobs that would make the backfill silently no-op', async () => {
    const sql = getTestDb();
    await expect(
      backfillBehaviorOutputOriginId({ db: sql, batchSize: 0, sleepMs: 0 })
    ).rejects.toThrow(/batchSize must be a positive integer/);
    await expect(
      backfillBehaviorOutputOriginId({ db: sql, sleepMs: -1 })
    ).rejects.toThrow(/sleepMs must be a non-negative number/);
  });
});
