/**
 * Volatile source state is reconciled on the current row, never superseded.
 *
 * Measured on the 200,000 most recent supersede pairs in prod: 164,915 (82.5%)
 * differed ONLY in `score`/`metadata`, with title, payload_text and attachments
 * byte-identical. Each of those minted a duplicate row, a duplicate 768-dim
 * vector and a permanent ivfflat entry, so ~half of `events` was mutable state
 * stored in an immutable row.
 *
 * The ledger's invariant is narrower than the convention: the only trigger on
 * `events` is `trg_events_append_only`, and it is BEFORE DELETE. An upvote count
 * is not an utterance, so it is reconciled rather than versioned.
 */

import { describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function versionsOf(orgId: string, originId: string) {
  const sql = getTestDb();
  return (await sql`
    SELECT id, score, metadata, payload_text, superseded_by
    FROM events
    WHERE organization_id = ${orgId} AND origin_id = ${originId}
    ORDER BY id ASC
  `) as Array<{
    id: number;
    score: number | null;
    metadata: Record<string, unknown> | null;
    payload_text: string | null;
    superseded_by: number | null;
  }>;
}

/**
 * `findCurrentEventByOrigin` returns early unless `connectionId` is set — dedupe
 * keys on (connection_id, origin_id) — so a fixture without one would insert a
 * fresh row every call and silently test nothing. Real connector ingest always
 * carries a connection.
 */
async function seedConnection(orgId: string, email: string): Promise<number> {
  const user = await createTestUser({ email });
  const conn = await createTestConnection({
    organization_id: orgId,
    connector_key: 'reddit',
    created_by: user.id,
  });
  return Number(conn.id);
}

function baseParams(orgId: string, originId: string, connectionId: number) {
  return {
    entityIds: [] as number[],
    organizationId: orgId,
    originId,
    connectionId,
    content: 'a post nobody edited',
    semanticType: 'content',
    connectorKey: 'reddit',
  };
}

describe('volatile source state is reconciled in place', () => {
  it('a counter change updates the current row instead of superseding it', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile A' });
    const conn = await seedConnection(org.id, 'vol-a@test.com');
    const originId = 't3_volatile_a';

    const first = await insertEvent(
      { ...baseParams(org.id, originId, conn), score: 10, metadata: { score: 10, upvote_ratio: 0.9 } },
      { onConflictUpdate: true }
    );
    expect(first.change).toBe('inserted');

    const second = await insertEvent(
      { ...baseParams(org.id, originId, conn), score: 42, metadata: { score: 42, upvote_ratio: 0.97 } },
      { onConflictUpdate: true }
    );

    // Before this change the identical call superseded, leaving two rows.
    expect(second.change).toBe('state_updated');
    expect(second.id).toBe(first.id);

    const rows = await versionsOf(org.id, originId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].score)).toBe(42);
    expect(rows[0].metadata?.score).toBe(42);
    expect(rows[0].metadata?.upvote_ratio).toBe(0.97);
    expect(rows[0].superseded_by).toBeNull();
  });

  it('reports unchanged when the counters did not move either', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile B' });
    const conn = await seedConnection(org.id, 'vol-b@test.com');
    const originId = 't3_volatile_b';
    const params = { ...baseParams(org.id, originId, conn), score: 7, metadata: { score: 7 } };

    await insertEvent(params, { onConflictUpdate: true });
    const again = await insertEvent(params, { onConflictUpdate: true });

    expect(again.change).toBe('unchanged');
    expect(await versionsOf(org.id, originId)).toHaveLength(1);
  });

  it('an omitted counter is preserved and does not count as a change', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile F' });
    const conn = await seedConnection(org.id, 'vol-f@test.com');
    const originId = 't3_volatile_f';

    await insertEvent(
      { ...baseParams(org.id, originId, conn), score: 5, metadata: { score: 5, upvote_ratio: 0.9 } },
      { onConflictUpdate: true }
    );
    // This sync omits upvote_ratio. Merge semantics keep the last known value,
    // so the omission must read as "unchanged" — a raw set comparison would
    // report state_updated on every sync forever, since the merge never lets
    // the stored set converge to the incoming one.
    const second = await insertEvent(
      { ...baseParams(org.id, originId, conn), score: 5, metadata: { score: 5 } },
      { onConflictUpdate: true }
    );
    expect(second.change).toBe('unchanged');

    const rows = await versionsOf(org.id, originId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata?.upvote_ratio).toBe(0.9);
  });

  it('still supersedes when the authored text changes', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile C' });
    const conn = await seedConnection(org.id, 'vol-c@test.com');
    const originId = 't3_volatile_c';

    const first = await insertEvent(
      { ...baseParams(org.id, originId, conn), score: 1, metadata: { score: 1 } },
      { onConflictUpdate: true }
    );
    const second = await insertEvent(
      {
        ...baseParams(org.id, originId, conn),
        content: 'the author edited this',
        score: 99,
        metadata: { score: 99 },
      },
      { onConflictUpdate: true }
    );

    expect(second.change).toBe('superseded');
    expect(second.id).not.toBe(first.id);

    const rows = await versionsOf(org.id, originId);
    expect(rows).toHaveLength(2);
    // The successor carries the new counters too — they ride along on a real edit.
    expect(Number(rows[1].score)).toBe(99);
    expect(rows[1].superseded_by).toBeNull();
  });

  it('still supersedes when a non-volatile metadata key changes', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile D' });
    const conn = await seedConnection(org.id, 'vol-d@test.com');
    const originId = 't3_volatile_d';

    await insertEvent(
      { ...baseParams(org.id, originId, conn), metadata: { score: 1, flair: 'discussion' } },
      { onConflictUpdate: true }
    );
    const second = await insertEvent(
      { ...baseParams(org.id, originId, conn), metadata: { score: 2, flair: 'announcement' } },
      { onConflictUpdate: true }
    );

    // `flair` is authored, not observed — that is a genuine new version.
    expect(second.change).toBe('superseded');
    expect(await versionsOf(org.id, originId)).toHaveLength(2);
  });

  it('merges volatile keys without disturbing authored metadata', async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Volatile E' });
    const conn = await seedConnection(org.id, 'vol-e@test.com');
    const originId = 't3_volatile_e';

    await insertEvent(
      {
        ...baseParams(org.id, originId, conn),
        metadata: { score: 1, flair: 'discussion', email: 'a@b.c' },
      },
      { onConflictUpdate: true }
    );
    // Same authored keys, moved counter.
    const second = await insertEvent(
      {
        ...baseParams(org.id, originId, conn),
        metadata: { score: 500, flair: 'discussion', email: 'a@b.c' },
      },
      { onConflictUpdate: true }
    );
    expect(second.change).toBe('state_updated');

    const rows = await versionsOf(org.id, originId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata?.score).toBe(500);
    // Identity keys back the expression indexes on this table — the merge must
    // never clobber them.
    expect(rows[0].metadata?.flair).toBe('discussion');
    expect(rows[0].metadata?.email).toBe('a@b.c');
  });
});
