/**
 * SPIKE — does the derived-edge provenance index still win at production scale?
 *
 * The earlier plan check ran against ~400 rows, where Postgres will pick an
 * index for almost anything. This builds a table two orders of magnitude larger
 * with a REALISTIC skew — one rule version owning the overwhelming majority of
 * rows — because that is the shape that flips a planner to a sequential scan.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { ensureMemberEntityType } from '../member-entity-type';

const TOTAL_EDGES = 200_000;
/** The slice a retraction actually targets — rare, as a real rule bump is. */
const TARGET_SLICE = 500;

let orgId: string;
let userId: string;
let relTypeId: number;
let otherTypeId: number;

describe('SPIKE: derived-edge provenance at scale', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'scale org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await ensureMemberEntityType(org.id);
    orgId = org.id;
    userId = user.id;
    const sql = getTestDb();

    const [typeRow] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
      VALUES (${orgId}, 'invoice_customer', 'invoice_customer', 'active', current_timestamp, current_timestamp)
      RETURNING id
    `;
    relTypeId = Number(typeRow.id);
    const [otherRow] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
      VALUES (${orgId}, 'invoice_salesrep', 'invoice_salesrep', 'active', current_timestamp, current_timestamp)
      RETURNING id
    `;
    otherTypeId = Number(otherRow.id);

    const [etype] = await sql<{ id: number }[]>`
      SELECT id FROM entity_types WHERE organization_id = ${orgId} AND slug = '$member' LIMIT 1
    `;

    // Endpoints. The unique live-triple index means every edge needs a distinct
    // (from, to, type) pair, so mint enough entities to pair them off.
    const endpointCount = TOTAL_EDGES / 100 + 200;
    await sql`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
      SELECT ${orgId}, ${Number(etype.id)}, 'scale-' || g, 'scale-' || g, '{}'::jsonb, ${userId}, current_timestamp, current_timestamp
      FROM generate_series(1, ${endpointCount}) g
    `;
    const ids = await sql<{ id: number }[]>`
      SELECT id FROM entities WHERE organization_id = ${orgId} ORDER BY id
    `;
    const lo = Number(ids[0].id);
    const hi = Number(ids[ids.length - 1].id);

    // 199_500 rows on rule version '1', 500 on '2'. `g % (hi-lo)` fans the
    // from-side out so no single from-entity dominates.
    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, confidence, source, created_by, updated_by, created_at, updated_at
      )
      SELECT
        ${orgId},
        ${lo} + (g % ${hi - lo}),
        ${lo} + ((g / ${hi - lo}) % ${hi - lo}),
        (CASE WHEN g % 2 = 0 THEN ${relTypeId} ELSE ${otherTypeId} END)::int,
        jsonb_build_object('derivedFrom', jsonb_build_object(
          'relationshipTypeId', (CASE WHEN g % 2 = 0 THEN ${relTypeId} ELSE ${otherTypeId} END)::text,
          'ruleVersion', CASE WHEN g <= ${TARGET_SLICE} THEN '2' ELSE '1' END,
          'connectionId', '1'
        )),
        1.0, 'feed', ${userId}, ${userId}, current_timestamp, current_timestamp
      FROM generate_series(1, ${TOTAL_EDGES}) g
      ON CONFLICT DO NOTHING
    `;
    await sql`ANALYZE entity_relationships`;
  }, 300_000);

  it('reports the table is actually large and skewed', async () => {
    const sql = getTestDb();
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships WHERE organization_id = ${orgId}
    `;
    // ON CONFLICT drops collisions; assert we still built a genuinely big table.
    console.log(`[scale] entity_relationships rows: ${row.count}`);
    expect(Number(row.count)).toBeGreaterThan(100_000);
    const [skew] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${orgId} AND metadata -> 'derivedFrom' ->> 'ruleVersion' = '1'
    `;
    expect(Number(skew.count) / Number(row.count)).toBeGreaterThan(0.9);
  });

  it('the retraction sweep uses the rule index, not a sequential scan', async () => {
    const sql = getTestDb();
    const plan = await sql<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id FROM entity_relationships
      WHERE organization_id = ${orgId}
        AND deleted_at IS NULL
        AND metadata ? 'derivedFrom'
        AND metadata -> 'derivedFrom' ->> 'relationshipTypeId' = ${String(relTypeId)}
        AND metadata -> 'derivedFrom' ->> 'ruleVersion' = '2'
    `;
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    console.log(text);
    expect(text).toContain('idx_entity_relationships_derived_from_rule');
    expect(text).not.toMatch(/Seq Scan on entity_relationships/);
  });

  it('the reconcile sweep resolves by from_entity index, not a sequential scan', async () => {
    const sql = getTestDb();
    const [sample] = await sql<{ from_entity_id: number }[]>`
      SELECT from_entity_id FROM entity_relationships
      WHERE organization_id = ${orgId} LIMIT 1
    `;
    const plan = await sql<{ 'QUERY PLAN': string }[]>`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT id FROM entity_relationships
      WHERE organization_id = ${orgId}
        AND from_entity_id = ${Number(sample.from_entity_id)}
        AND relationship_type_id = ${relTypeId}
        AND deleted_at IS NULL
        AND metadata ? 'derivedFrom'
        AND NOT (to_entity_id = ANY (ARRAY[1,2,3]::bigint[]))
    `;
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    console.log(text);
    expect(text).not.toMatch(/Seq Scan on entity_relationships/);
  });
});
