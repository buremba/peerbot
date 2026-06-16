/**
 * Integration test: concurrent dedup on (connection_id, origin_id).
 *
 * `insertEvent(..., { onConflictUpdate: true })` is the connector-ingest dedup
 * path. It is a read-then-insert: it looks up the current row for
 * (connection_id, origin_id), then either supersedes it (content changed) or
 * inserts fresh (no current row). There is NO unique constraint on
 * (connection_id, origin_id) — the only DB guard is the partial unique index
 * `idx_events_superseded_by` on supersedes_event_id.
 *
 * Without serialization, two concurrent ingests of the SAME item race:
 *
 *   - New origin_id, two concurrent inserts: both see "no current row", both
 *     insert with supersedes_event_id NULL → TWO permanent current rows for the
 *     same key. (Observed in prod: org Market had 224k+ such reddit duplicates,
 *     all within a single connection_id, still growing ~2.5k/week.)
 *
 *   - Existing origin_id, two concurrent updates: both target the same row to
 *     supersede → one wins idx_events_superseded_by, the other throws a
 *     duplicate-key error that fails the whole stream batch.
 *
 * The fix serializes the read-then-insert with a transaction-scoped advisory
 * lock keyed on (connection_id, origin_id). This test pins the invariant:
 * after N concurrent ingests of the same (connection_id, origin_id) — half
 * fresh-new, half content-changing — there is EXACTLY ONE current
 * (non-superseded) row, and no insert throws.
 *
 * Vitest CI gap note (mirrors neighbors): runs against the dev/CI pgvector DB
 * via DATABASE_URL; the integration job runs it in CI.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestOrganization,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('insertEvent > concurrent dedup on (connection_id, origin_id)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let connectionId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Dedup Race Org' });
    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'reddit',
    });
    connectionId = Number(conn.id);
  });

  it('keeps exactly ONE current row when the same item is ingested concurrently', async () => {
    const originId = 'reddit_post_t3_race_fresh';

    // 8 concurrent ingests of a brand-new origin_id. On the unserialized path
    // every racer sees "no current row" and inserts fresh with
    // supersedes_event_id NULL → 8 current rows. With the advisory lock they
    // serialize: the first inserts, the rest dedup/supersede, leaving one.
    const params = (content: string) => ({
      entityIds: [],
      organizationId: org.id,
      originId,
      title: 'Bitbucket down?',
      content,
      semanticType: 'content',
      originType: 'post',
      connectorKey: 'reddit',
      connectionId,
      occurredAt: new Date('2026-04-07T18:05:55Z'),
      metadata: {},
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        // Mix identical and content-changing payloads to exercise both the
        // fresh-insert and the supersede branch under contention.
        insertEvent(params(i % 2 === 0 ? 'same body' : `changed body ${i}`), {
          onConflictUpdate: true,
        })
      )
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r))
    ).toEqual([]);

    const sql = getTestDb();
    const current = await sql`
      SELECT id FROM current_event_records
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
        AND origin_id = ${originId}
    `;
    expect(current).toHaveLength(1);
  });

  it('survives a concurrent burst of content updates without duplicate-key failures', async () => {
    const originId = 'reddit_post_t3_race_update';

    // Seed one current row first.
    await insertEvent(
      {
        entityIds: [],
        organizationId: org.id,
        originId,
        title: 'Score post',
        content: 'score 1',
        semanticType: 'content',
        originType: 'post',
        connectorKey: 'reddit',
        connectionId,
        occurredAt: new Date('2026-04-08T00:00:00Z'),
        score: 1,
        metadata: {},
      },
      { onConflictUpdate: true }
    );

    // 10 concurrent score updates (each a distinct payload → each wants to
    // supersede the current row). On the unserialized path several collide on
    // idx_events_superseded_by and throw.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        insertEvent(
          {
            entityIds: [],
            organizationId: org.id,
            originId,
            title: 'Score post',
            content: `score ${i + 2}`,
            semanticType: 'content',
            originType: 'post',
            connectorKey: 'reddit',
            connectionId,
            occurredAt: new Date('2026-04-08T00:00:00Z'),
            score: i + 2,
            metadata: {},
          },
          { onConflictUpdate: true }
        )
      )
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String(r))
    ).toEqual([]);

    const sql = getTestDb();
    const current = await sql`
      SELECT id FROM current_event_records
      WHERE organization_id = ${org.id}
        AND connection_id = ${connectionId}
        AND origin_id = ${originId}
    `;
    expect(current).toHaveLength(1);
  });
});
