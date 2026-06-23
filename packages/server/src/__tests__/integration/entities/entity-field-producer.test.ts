/**
 * entity_field projection PRODUCER — manage_entity create/update emit an
 * entity_field event INSIDE the entity-write transaction, so the projection
 * (entity_field_state) tracks entities.metadata. Because emission is synchronous
 * (awaited in the txn), reads need no polling.
 *
 * The concurrency test is the load-bearing one: it proves the projection
 * converges to the SAME value as the authoritative entities.metadata even under
 * concurrent updates to the same field — i.e. the FOR UPDATE + same-txn emission
 * orders the projection consistently with the metadata write.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

const sql = getTestDb();

let owner: TestApiClient;

async function makeEntity(name: string, metadata?: Record<string, unknown>): Promise<number> {
  const created = (await owner.entities.create({ type: 'company', name, metadata })) as {
    entity?: { id: number };
  };
  return created.entity!.id;
}

async function tierState(entityId: number): Promise<{ value: unknown; obs: number } | undefined> {
  const rows = (await sql`
    SELECT value, observation_id FROM entity_field_state
    WHERE entity_id = ${entityId} AND field = 'tier'
  `) as Array<{ value: unknown; observation_id: string }>;
  if (rows.length === 0) return undefined;
  return { value: rows[0].value, obs: Number(rows[0].observation_id) };
}

async function entityTier(entityId: number): Promise<unknown> {
  const rows = (await sql`
    SELECT metadata->>'tier' AS tier FROM entities WHERE id = ${entityId}
  `) as Array<{ tier: string | null }>;
  return rows[0]?.tier ?? null;
}

describe('entity_field projection producer (manage_entity)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Producer Org' });
    const u = await createTestUser({ email: 'producer-owner@test.com' });
    await addUserToOrganization(u.id, org.id, 'owner');
    owner = await TestApiClient.for({ organizationId: org.id, userId: u.id, memberRole: 'owner' });
    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
  });

  it('create populates the projection (synchronously, no polling)', async () => {
    const id = await makeEntity('Acme', { tier: 'gold', employees: 50 });
    const tier = await tierState(id);
    expect(tier?.value).toBe('gold');
    const emp = (await sql`
      SELECT value FROM entity_field_state WHERE entity_id = ${id} AND field = 'employees'
    `) as Array<{ value: unknown }>;
    expect(emp[0].value).toBe(50);
  });

  it('emits a watcher-correction-shaped event per field (one edit model)', async () => {
    const id = await makeEntity('Shape Co', { tier: 'gold' });
    const rows = (await sql`
      SELECT metadata FROM events
      WHERE semantic_type = 'entity_field'
        AND (metadata->>'entity_id')::bigint = ${id}
        AND metadata->>'field_path' = 'tier'
      ORDER BY id DESC LIMIT 1
    `) as Array<{ metadata: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    const md = rows[0].metadata;
    // Same field-grained shape a watcher correction carries — one edit model.
    expect(md.field_path).toBe('tier');
    expect(md.mutation).toBe('set');
    expect(md.corrected_value).toBe('gold');
    expect(md.fields).toBeUndefined(); // no longer a fields-map snapshot
  });

  it('update advances the projection and matches entities.metadata', async () => {
    const id = await makeEntity('Globex', { tier: 'silver' });
    const before = await tierState(id);
    await owner.entities.update({ entity_id: id, metadata: { tier: 'platinum' } });
    const after = await tierState(id);
    expect(after?.value).toBe('platinum');
    expect(after!.obs).toBeGreaterThan(before!.obs);
    expect(after?.value).toBe(await entityTier(id));
  });

  it('concurrent updates: projection converges to the SAME value as entities.metadata', async () => {
    const id = await makeEntity('Race Co', { tier: 'v0' });
    // Fire several concurrent updates to the same field; FOR UPDATE serializes
    // them and the same-txn event emission orders the projection identically.
    await Promise.all([
      owner.entities.update({ entity_id: id, metadata: { tier: 'a' } }),
      owner.entities.update({ entity_id: id, metadata: { tier: 'b' } }),
      owner.entities.update({ entity_id: id, metadata: { tier: 'c' } }),
      owner.entities.update({ entity_id: id, metadata: { tier: 'd' } }),
    ]);
    const projected = await tierState(id);
    const authoritative = await entityTier(id);
    // Whatever won the row lock last is in entities.metadata; the projection must
    // agree (no stale/inverted winner).
    expect(projected?.value).toBe(authoritative);
    expect(['a', 'b', 'c', 'd']).toContain(authoritative);
  });
});
