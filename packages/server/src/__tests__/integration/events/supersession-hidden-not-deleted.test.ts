/**
 * Integration test: the "hidden, not deleted" supersession contract.
 *
 * `events` is append-only — superseding a row never physically removes it.
 * The contract (advertised in the save_memory tool description and depended on
 * by get_content.include_superseded) is:
 *
 *   1. The superseded row stays PHYSICALLY present in the raw `events` table.
 *   2. It is ABSENT from `current_event_records` (the view that masks rows
 *      with a newer superseder) and therefore absent from default get_content.
 *   3. `include_superseded: true` on an entity-scoped chronological listing
 *      surfaces BOTH the superseded original and its successor.
 *
 * Sibling coverage: delete-content-tombstone.test.ts pins the same contract
 * for the tombstone (delete) path; get-content-visibility.test.ts pins the
 * visibility predicate across the include_superseded branch. This file pins
 * the raw-table-vs-view split directly.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally against the dev/CI
 * pgvector DB via DATABASE_URL; the integration job runs it in CI.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { backfillSupersededBy } from '../../../events/backfill-superseded-by';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('supersession > hidden, not deleted', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let ctx: ToolContext;

  let originalId: number;
  let successorId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Supersession Contract Org' });
    user = await createTestUser({ email: 'supersession@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entity = await createTestEntity({
      name: 'Supersession Entity',
      organization_id: org.id,
    });

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };

    // Original "old preference" event.
    const original = await createTestEvent({
      organization_id: org.id,
      entity_id: entity.id,
      content: 'Budget cap is 1000',
      semantic_type: 'preference',
    });
    originalId = original.id;

    // Successor event that supersedes the original. createTestEvent does not
    // expose supersedes_event_id, so insert the successor with the linkage
    // directly — the same approach delete-content-tombstone.test.ts uses for
    // the tombstone row.
    const sql = getTestDb();
    const [succ] = await sql`
      INSERT INTO events (
        entity_ids, origin_id, payload_type, payload_text, occurred_at,
        semantic_type, connector_key, metadata, organization_id,
        supersedes_event_id, created_at
      ) VALUES (
        ${`{${entity.id}}`}::bigint[],
        ${`test-supersede-${originalId}`},
        'text',
        'Budget cap is 2000',
        NOW(),
        'preference',
        'test.connector',
        ${sql.json({})},
        ${org.id},
        ${originalId},
        NOW()
      )
      RETURNING id
    `;
    successorId = Number(succ.id);
  });

  it('keeps the superseded original PHYSICALLY present in the raw events table', async () => {
    const sql = getTestDb();
    const raw = await sql`SELECT id FROM events WHERE id = ${originalId}`;
    expect(raw).toHaveLength(1);

    // And the successor really does point at it.
    const link = await sql`
      SELECT supersedes_event_id FROM events WHERE id = ${successorId}
    `;
    expect(Number(link[0].supersedes_event_id)).toBe(originalId);
  });

  it('hides the superseded original from current_event_records (the masking view)', async () => {
    const sql = getTestDb();
    const inView = await sql`
      SELECT id FROM current_event_records WHERE id = ${originalId}
    `;
    expect(inView).toHaveLength(0);

    // The successor, having no newer superseder, IS in the view.
    const successorInView = await sql`
      SELECT id FROM current_event_records WHERE id = ${successorId}
    `;
    expect(successorInView).toHaveLength(1);
  });

  it('default get_content omits the superseded original but returns the successor', async () => {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );
    const visibleIds = new Set(result.content.map((c) => c.id));

    expect(visibleIds.has(originalId)).toBe(false);
    expect(visibleIds.has(successorId)).toBe(true);
  });

  it('include_superseded=true returns BOTH the superseded original and the successor', async () => {
    const result = await getContent(
      {
        entity_id: entity.id,
        include_superseded: true,
        limit: 100,
        sort_by: 'date',
        sort_order: 'desc',
      } as never,
      {} as never,
      ctx
    );
    const ids = new Set(result.content.map((c) => c.id));

    expect(ids.has(originalId)).toBe(true);
    expect(ids.has(successorId)).toBe(true);
  });
});

/**
 * Denormalized lineage (`events.superseded_by`) coverage.
 *
 * Migration 20260702200000 adds `superseded_by` as the inverse edge of
 * `supersedes_event_id`. New superseding writes dual-write it in the same tx as
 * the superseding INSERT (utils/insert-event.ts); historical rows are filled by
 * the batched, resumable backfill (events/backfill-superseded-by.ts). Through
 * all of this the masking contract above stays intact — the view still hides
 * superseded rows — so the flip to `WHERE superseded_by IS NULL` (Stage 2) is a
 * pure performance change, not a behaviour change.
 */
describe('supersession > denormalized superseded_by lineage', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Superseded-By Lineage Org' });
    entity = await createTestEntity({
      name: 'Lineage Entity',
      organization_id: org.id,
    });
  });

  it('dual-writes superseded_by on the target in the SAME insertEvent call', async () => {
    const sql = getTestDb();

    const original = await createTestEvent({
      organization_id: org.id,
      entity_id: entity.id,
      content: 'v1',
      semantic_type: 'preference',
    });

    // Before superseding, the target is live: superseded_by IS NULL.
    const [before] = await sql`
      SELECT superseded_by FROM events WHERE id = ${original.id}
    `;
    expect(before.superseded_by).toBeNull();

    const successor = await insertEvent({
      entityIds: [entity.id],
      organizationId: org.id,
      originId: `dualwrite-${original.id}`,
      content: 'v2',
      semanticType: 'preference',
      supersedesEventId: original.id,
    });

    // The superseding insert stamped the target's inverse edge atomically.
    const [after] = await sql`
      SELECT superseded_by FROM events WHERE id = ${original.id}
    `;
    expect(Number(after.superseded_by)).toBe(Number(successor.id));

    // The successor itself is live (nothing supersedes it yet).
    const [succRow] = await sql`
      SELECT superseded_by FROM events WHERE id = ${successor.id}
    `;
    expect(succRow.superseded_by).toBeNull();

    // Masking is unchanged: original hidden, successor visible.
    const hidden = await sql`
      SELECT id FROM current_event_records WHERE id = ${original.id}
    `;
    expect(hidden).toHaveLength(0);
    const visible = await sql`
      SELECT id FROM current_event_records WHERE id = ${successor.id}
    `;
    expect(visible).toHaveLength(1);
  });

  it('lets a concurrent double-supersede lose cleanly (unique index, one winner)', async () => {
    const sql = getTestDb();

    const target = await createTestEvent({
      organization_id: org.id,
      entity_id: entity.id,
      content: 'contended',
      semantic_type: 'preference',
    });

    // Two supersedes of the SAME target fire concurrently. The partial unique
    // index idx_events_superseded_by on supersedes_event_id serializes them:
    // exactly one INSERT wins, the other throws a raw 23505.
    const results = await Promise.allSettled([
      insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        originId: `race-a-${target.id}`,
        content: 'winner?',
        semanticType: 'preference',
        supersedesEventId: target.id,
      }),
      insertEvent({
        entityIds: [entity.id],
        organizationId: org.id,
        originId: `race-b-${target.id}`,
        content: 'winner?',
        semanticType: 'preference',
        supersedesEventId: target.id,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Exactly one superseder edge exists in the raw table.
    const superseders = await sql`
      SELECT id FROM events WHERE supersedes_event_id = ${target.id}
    `;
    expect(superseders).toHaveLength(1);

    // The winner's dual-write stamped superseded_by to that single winner.
    const winnerId = (fulfilled[0] as PromiseFulfilledResult<{ id: number }>).value.id;
    const [stamped] = await sql`
      SELECT superseded_by FROM events WHERE id = ${target.id}
    `;
    expect(Number(stamped.superseded_by)).toBe(Number(winnerId));
    expect(Number(superseders[0].id)).toBe(Number(winnerId));
  });

  it('backfill fills historical edges that predate the dual-write and stays idempotent', async () => {
    const sql = getTestDb();

    // Simulate a historical (pre-dual-write) supersede: raw INSERT that sets
    // supersedes_event_id but leaves superseded_by NULL (bypassing insertEvent,
    // exactly like the older successor inserted in the first describe block).
    const original = await createTestEvent({
      organization_id: org.id,
      entity_id: entity.id,
      content: 'historical v1',
      semantic_type: 'preference',
    });
    const [succ] = await sql`
      INSERT INTO events (
        entity_ids, origin_id, payload_type, payload_text, occurred_at,
        semantic_type, connector_key, metadata, organization_id,
        supersedes_event_id, created_at
      ) VALUES (
        ${`{${entity.id}}`}::bigint[],
        ${`historical-supersede-${original.id}`},
        'text',
        'historical v2',
        NOW(),
        'preference',
        'test.connector',
        ${sql.json({})},
        ${org.id},
        ${original.id},
        NOW()
      )
      RETURNING id
    `;
    const successorId = Number(succ.id);

    // The historical edge is unstamped, but the view already masks it (proves
    // the flip is a perf-only change: masking works both before AND after the
    // backfill).
    const [preBackfill] = await sql`
      SELECT superseded_by FROM events WHERE id = ${original.id}
    `;
    expect(preBackfill.superseded_by).toBeNull();
    const maskedBefore = await sql`
      SELECT id FROM current_event_records WHERE id = ${original.id}
    `;
    expect(maskedBefore).toHaveLength(0);

    // Dry-run reports the edge without writing.
    const dry = await backfillSupersededBy({ db: sql, execute: false, sleepMs: 0 });
    expect(dry.filled).toBeGreaterThanOrEqual(1);
    const [stillNull] = await sql`
      SELECT superseded_by FROM events WHERE id = ${original.id}
    `;
    expect(stillNull.superseded_by).toBeNull();

    // Execute: the historical edge is now stamped.
    const run1 = await backfillSupersededBy({ db: sql, execute: true, sleepMs: 0 });
    expect(run1.filled).toBeGreaterThanOrEqual(1);
    const [filled] = await sql`
      SELECT superseded_by FROM events WHERE id = ${original.id}
    `;
    expect(Number(filled.superseded_by)).toBe(successorId);

    // Re-run is a no-op (idempotent + resumable): nothing left to fill.
    const run2 = await backfillSupersededBy({ db: sql, execute: true, sleepMs: 0 });
    expect(run2.filled).toBe(0);

    // Masking remains correct after the backfill.
    const maskedAfter = await sql`
      SELECT id FROM current_event_records WHERE id = ${original.id}
    `;
    expect(maskedAfter).toHaveLength(0);
    const visibleAfter = await sql`
      SELECT id FROM current_event_records WHERE id = ${successorId}
    `;
    expect(visibleAfter).toHaveLength(1);
  });
});
