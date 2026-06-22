/**
 * entity_field_state projection SUBSTRATE — expand phase.
 *
 * The DB trigger `project_entity_field` folds 'entity_field' events into
 * `entity_field_state` (latest event per (entity_id, field) wins, keep-greater on
 * the monotonic event id) — but ONLY for a well-formed event whose entity belongs
 * to the event's org. The trigger fires synchronously with the event insert, so
 * no polling is needed. Asserts:
 *   1. fields land in the projection (org-scoped),
 *   2. a later event advances value + observation_id,
 *   3. keep-greater REJECTS an event with a lower observation_id (out-of-order),
 *   4. a malformed event NEVER aborts the host events insert (degrades to no-op),
 *   5. a cross-org event CANNOT touch another org's projection row (tenancy),
 *   6. entity_field events carry no entity link (no content-count pollution).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { insertEvent } from '../../../utils/insert-event';

const sql = getTestDb();

let orgA: string;
let orgB: string;
let clientA: TestApiClient;
let counter = 0;

async function makeEntity(client: TestApiClient, name: string): Promise<number> {
  const created = (await client.entities.create({ type: 'company', name })) as {
    entity?: { id: number };
  };
  return created.entity!.id;
}

async function emitFields(
  orgId: string,
  entityId: number,
  fields: Record<string, unknown>
): Promise<number> {
  counter += 1;
  const ev = await insertEvent({
    entityIds: [],
    organizationId: orgId,
    originId: `efield_test_${counter}`,
    semanticType: 'entity_field',
    metadata: { entity_id: entityId, fields },
  });
  return ev.id;
}

async function fieldState(
  entityId: number
): Promise<Record<string, { value: unknown; obs: number; org: string }>> {
  const rows = (await sql`
    SELECT organization_id, field, value, observation_id
    FROM entity_field_state WHERE entity_id = ${entityId}
  `) as Array<{ organization_id: string; field: string; value: unknown; observation_id: string }>;
  const out: Record<string, { value: unknown; obs: number; org: string }> = {};
  for (const r of rows) {
    out[r.field] = { value: r.value, obs: Number(r.observation_id), org: r.organization_id };
  }
  return out;
}

describe('entity_field_state projection substrate (expand phase)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();

    const oa = await createTestOrganization({ name: 'Projection Org A' });
    orgA = oa.id;
    const ua = await createTestUser({ email: 'proj-a@test.com' });
    await addUserToOrganization(ua.id, oa.id, 'owner');
    clientA = await TestApiClient.for({ organizationId: oa.id, userId: ua.id, memberRole: 'owner' });
    await clientA.entity_schema.createType({ slug: 'company', name: 'Company' });

    const ob = await createTestOrganization({ name: 'Projection Org B' });
    orgB = ob.id;
    const ub = await createTestUser({ email: 'proj-b@test.com' });
    await addUserToOrganization(ub.id, ob.id, 'owner');
  });

  it('folds entity_field events into the projection (org-scoped)', async () => {
    const id = await makeEntity(clientA, 'Acme');
    await emitFields(orgA, id, { tier: 'gold', employees: 50 });
    const st = await fieldState(id);
    expect(st.tier.value).toBe('gold');
    expect(st.employees.value).toBe(50);
    expect(st.tier.org).toBe(orgA);
  });

  it('a later event advances the projected value and observation_id', async () => {
    const id = await makeEntity(clientA, 'Globex');
    await emitFields(orgA, id, { tier: 'silver' });
    const before = await fieldState(id);
    await emitFields(orgA, id, { tier: 'platinum' });
    const after = await fieldState(id);
    expect(after.tier.value).toBe('platinum');
    expect(after.tier.obs).toBeGreaterThan(before.tier.obs);
  });

  it('keep-greater REJECTS an event with a lower observation_id (out-of-order)', async () => {
    const id = await makeEntity(clientA, 'Initech');
    await emitFields(orgA, id, { tier: 'gold' });
    // Simulate a much later event already projected.
    await sql`
      UPDATE entity_field_state SET observation_id = 9223372036854775000
      WHERE entity_id = ${id} AND field = 'tier'
    `;
    await emitFields(orgA, id, { tier: 'bronze' });
    const st = await fieldState(id);
    expect(st.tier.value).toBe('gold'); // lower id rejected
  });

  it('a malformed entity_field event NEVER aborts the host events insert', async () => {
    const id = await makeEntity(clientA, 'Malformed Co');
    // Each of these must resolve (no thrown abort of the events insert) AND
    // leave no projection row.
    const bad: Array<Record<string, unknown>> = [
      { fields: { x: 1 } }, // entity_id missing
      { entity_id: 3.9, fields: { x: 1 } }, // non-integer number
      { entity_id: 99999999999999999999999, fields: { x: 1 } }, // out of bigint range
      { entity_id: id, fields: 'not-an-object' }, // fields not an object
    ];
    for (const [i, meta] of bad.entries()) {
      await expect(
        insertEvent({
          entityIds: [],
          organizationId: orgA,
          originId: `efield_bad_${i}`,
          semanticType: 'entity_field',
          metadata: meta,
        })
      ).resolves.toBeTruthy();
    }
    expect(Object.keys(await fieldState(id))).toHaveLength(0);
  });

  it("a cross-org event CANNOT touch another org's projection row (tenancy)", async () => {
    const id = await makeEntity(clientA, 'Tenancy Co'); // owned by org A
    await emitFields(orgA, id, { tier: 'gold' });

    // Org B emits a field event for org A's entity id — the ownership check must
    // skip it (entity does not belong to org B), even though its event id is higher.
    await emitFields(orgB, id, { tier: 'HIJACKED' });

    const st = await fieldState(id);
    expect(st.tier.value).toBe('gold'); // unchanged
    expect(st.tier.org).toBe(orgA); // org not re-stamped to B
  });

  it('does not pollute entity-linked content: entity_field events carry no entity link', async () => {
    const id = await makeEntity(clientA, 'Clean Co');
    await emitFields(orgA, id, { tier: 'gold' });
    const rows = (await sql`
      SELECT count(*)::int AS n FROM events
      WHERE semantic_type = 'entity_field'
        AND organization_id = ${orgA}
        AND entity_ids IS NOT NULL AND array_length(entity_ids, 1) >= 1
    `) as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });
});
