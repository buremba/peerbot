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
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
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
