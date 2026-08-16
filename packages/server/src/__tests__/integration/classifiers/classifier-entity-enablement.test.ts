import { beforeEach, describe, expect, it } from 'vitest';
import { parsePgTextArray } from '../../../db/client';
import { enableClassifiersOnEntity } from '../../../watchers/classifier-extraction';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

/**
 * Wait until both classifier writers have read or attempted to read the row and
 * are blocked behind the test transaction's row lock. With the old unlocked
 * SELECT, both wait in UPDATE after computing from the same stale value. With
 * the fixed SELECT FOR UPDATE, both wait before reading and then serialize.
 */
async function waitForTwoBlockedClassifierWriters(
  sql: ReturnType<typeof getTestDb>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE '%enabled_classifiers%'
        AND query ILIKE '%entities%'
    `;
    if (rows[0].count >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('two concurrent classifier writers never reached the entity row lock');
}

describe('classifier entity enablement', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('preserves both classifier additions when two Behavior creates race', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'Classifier enablement race' });
    const entity = await createTestEntity({
      name: 'Classified entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });

    let signalLocked!: () => void;
    const rowLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseLock!: () => void;
    const lockMayRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM entities WHERE id = ${entity.id} FOR UPDATE`;
      signalLocked();
      await lockMayRelease;
    });
    await rowLocked;

    const first = sql.begin((tx) =>
      enableClassifiersOnEntity(tx, entity.id, ['sentiment'])
    );
    const second = sql.begin((tx) =>
      enableClassifiersOnEntity(tx, entity.id, ['priority'])
    );
    try {
      await waitForTwoBlockedClassifierWriters(sql);
    } finally {
      releaseLock();
      // Settle all three transactions even when the helper times out, so an
      // abandoned mid-transaction promise cannot resurface as an unhandled
      // rejection that masks the real failure.
      await Promise.allSettled([blocker, first, second]);
    }
    await Promise.all([blocker, first, second]);

    const rows = await sql<{ enabled_classifiers: unknown }>`
      SELECT enabled_classifiers FROM entities WHERE id = ${entity.id}
    `;
    expect(new Set(parsePgTextArray(rows[0].enabled_classifiers))).toEqual(
      new Set(['sentiment', 'priority'])
    );
  });
});
