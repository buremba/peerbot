/**
 * SPIKE — does the claim-set + change-log design actually retire the defect that
 * one relationship row cannot hold two independent claims?
 *
 * The red test in `declared-edges-codex-findings.test.ts` says owner A
 * retracting destroys owner B's still-valid edge. If this design is right, the
 * same sequence must leave the edge live.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import {
  assertEdgeClaim,
  type EdgeClaimRef,
  readEdgeHistory,
  retractEdgeClaim,
} from '../edge-claims-spike';
import { ensureMemberEntityType } from '../member-entity-type';

async function setup() {
  await cleanupTestDatabase();
  const org = await createTestOrganization({ name: 'claims org' });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  const sql = getTestDb();

  const [etype] = await sql<{ id: number }[]>`
    SELECT id FROM entity_types WHERE organization_id = ${org.id} AND slug = '$member' LIMIT 1
  `;
  const mk = async (name: string) => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by, created_at, updated_at)
      VALUES (${org.id}, ${Number(etype.id)}, ${name}, ${name}, '{}'::jsonb, ${user.id},
              current_timestamp, current_timestamp)
      RETURNING id
    `;
    return Number(row.id);
  };
  const invoice = await mk('FTR-1');
  const customer = await mk('CARI-1');
  const [typeRow] = await sql<{ id: number }[]>`
    INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
    VALUES (${org.id}, 'invoice_customer', 'invoice_customer', 'active', current_timestamp, current_timestamp)
    RETURNING id
  `;

  const ref = (ownerId: string): EdgeClaimRef => ({
    orgId: org.id,
    fromEntityId: invoice,
    toEntityId: customer,
    relationshipTypeId: Number(typeRow.id),
    ownerId,
  });
  return { org, user, sql, invoice, customer, typeId: Number(typeRow.id), ref };
}

async function liveCount(orgId: string): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count FROM entity_relationships
    WHERE organization_id = ${orgId} AND deleted_at IS NULL
  `;
  return Number(row.count);
}

describe('SPIKE: edges as a claim set with an append-only change log', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('one owner retracting does NOT destroy an edge another owner still asserts', async () => {
    const { org, user, ref } = await setup();

    const a = await assertEdgeClaim({
      ref: ref('erp_rule'), ruleVersion: '1', createdBy: user.id, seq: 's1',
    });
    expect(a).toMatchObject({ live: true, owners: ['erp_rule'], flipped: true });

    // A second, independent owner asserts the SAME triple.
    const b = await assertEdgeClaim({
      ref: ref('human'), createdBy: user.id, seq: 's2',
    });
    expect(b.live).toBe(true);
    expect(b.owners).toEqual(['erp_rule', 'human']);
    // Still ONE projection row — the graph did not gain a duplicate edge.
    expect(await liveCount(org.id)).toBe(1);

    // The ERP rule is removed. THIS is the sequence that destroyed the edge
    // under the single-provenance design.
    const afterA = await retractEdgeClaim({ ref: ref('erp_rule'), seq: 's3' });
    expect(afterA.live).toBe(true);
    expect(afterA.owners).toEqual(['human']);
    expect(await liveCount(org.id)).toBe(1);

    // The last claim goes: now the edge is withdrawn.
    const afterB = await retractEdgeClaim({ ref: ref('human'), seq: 's4' });
    expect(afterB.live).toBe(false);
    expect(afterB.owners).toEqual([]);
    expect(await liveCount(org.id)).toBe(0);
  });

  it('asserting twice from one owner is idempotent', async () => {
    const { org, user, ref } = await setup();
    await assertEdgeClaim({ ref: ref('erp_rule'), createdBy: user.id, seq: 's1' });
    const again = await assertEdgeClaim({ ref: ref('erp_rule'), createdBy: user.id, seq: 's2' });
    expect(again.owners).toEqual(['erp_rule']);
    expect(again.flipped).toBe(false);
    expect(await liveCount(org.id)).toBe(1);

    // And one retraction still clears it — a double assert must not require two.
    const gone = await retractEdgeClaim({ ref: ref('erp_rule'), seq: 's3' });
    expect(gone.live).toBe(false);
    expect(await liveCount(org.id)).toBe(0);
  });

  it('the log records what changed and how, in order', async () => {
    const { org, user, invoice, customer, typeId, ref } = await setup();
    await assertEdgeClaim({ ref: ref('erp_rule'), ruleVersion: '1', createdBy: user.id, seq: 's1' });
    await assertEdgeClaim({ ref: ref('human'), createdBy: user.id, seq: 's2' });
    await retractEdgeClaim({ ref: ref('erp_rule'), seq: 's3' });

    const history = await readEdgeHistory({
      orgId: org.id,
      fromEntityId: invoice,
      toEntityId: customer,
      relationshipTypeId: typeId,
    });
    expect(history).toHaveLength(3);
    expect(history.map((h) => [h.op, h.ownerId])).toEqual([
      ['assert', 'erp_rule'],
      ['assert', 'human'],
      ['retract', 'erp_rule'],
    ]);
    // Each entry carries the before/after claim set — "what changed and how".
    expect(history[0]).toMatchObject({ before: [], after: ['erp_rule'] });
    expect(history[1]).toMatchObject({ before: ['erp_rule'], after: ['erp_rule', 'human'] });
    expect(history[2]).toMatchObject({ before: ['erp_rule', 'human'], after: ['human'] });
  });

  it('history survives the edge being fully withdrawn', async () => {
    const { org, user, invoice, customer, typeId, ref } = await setup();
    await assertEdgeClaim({ ref: ref('erp_rule'), createdBy: user.id, seq: 's1' });
    await retractEdgeClaim({ ref: ref('erp_rule'), seq: 's2' });
    expect(await liveCount(org.id)).toBe(0);

    // The projection is gone; the log is not. This is the property the design
    // exists for — "we can see what changed and how" after the fact.
    const history = await readEdgeHistory({
      orgId: org.id,
      fromEntityId: invoice,
      toEntityId: customer,
      relationshipTypeId: typeId,
    });
    expect(history.map((h) => h.op)).toEqual(['assert', 'retract']);
  });

  it('concurrent owners asserting the same edge both survive', async () => {
    // The read-modify-write hazard: two owners adding a key to one JSONB claim
    // set. Both keys must be present afterwards.
    const { org, user, ref } = await setup();
    await Promise.all([
      assertEdgeClaim({ ref: ref('owner_a'), createdBy: user.id, seq: 'a1' }),
      assertEdgeClaim({ ref: ref('owner_b'), createdBy: user.id, seq: 'b1' }),
      assertEdgeClaim({ ref: ref('owner_c'), createdBy: user.id, seq: 'c1' }),
    ]);

    const sql = getTestDb();
    // `fetch_types:false` means an array comes back as its Postgres literal, so
    // aggregate to JSON rather than relying on driver array parsing.
    const [row] = await sql<{ owners: unknown }[]>`
      SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) AS owners
      FROM entity_relationships r,
           LATERAL jsonb_object_keys(r.metadata -> 'claims') AS k
      WHERE r.organization_id = ${org.id} AND r.deleted_at IS NULL
    `;
    expect(row.owners).toEqual(['owner_a', 'owner_b', 'owner_c']);
    expect(await liveCount(org.id)).toBe(1);
  });

  it('retracting an owner that never claimed leaves the edge alone', async () => {
    const { org, user, ref } = await setup();
    await assertEdgeClaim({ ref: ref('erp_rule'), createdBy: user.id, seq: 's1' });
    const noop = await retractEdgeClaim({ ref: ref('someone_else'), seq: 's2' });
    expect(noop.live).toBe(true);
    expect(noop.owners).toEqual(['erp_rule']);
    expect(await liveCount(org.id)).toBe(1);
  });
});
