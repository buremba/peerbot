/** Atomic source-claim invariants for shared relationship triples. */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  reconcileConnectorRelationshipClaims,
  RELATIONSHIP_CLAIMS_METADATA_KEY,
  retractConnectionRelationshipClaims,
} from '../../../utils/relationship-claims';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestConnection } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

async function seedClaimGraph() {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Relationship Claim Races' });
  await workspace.owner.entity_schema.createType({ slug: 'invoice', name: 'Invoice' });
  await workspace.owner.entity_schema.createType({ slug: 'customer', name: 'Customer' });
  await workspace.owner.entity_schema.createRelType({
    slug: 'invoice_customer',
    name: 'Invoice Customer',
  });
  const invoice = (await workspace.owner.entities.create({
    type: 'invoice',
    name: 'INV-RACE',
  })) as { entity: { id: number } };
  const customer = (await workspace.owner.entities.create({
    type: 'customer',
    name: 'Race Customer',
  })) as { entity: { id: number } };
  const connection = await createTestConnection({
    organization_id: workspace.org.id,
    connector_key: 'claim-race',
    created_by: workspace.users.owner.id,
    createDefaultFeed: false,
  });
  const desired = [
    {
      declaration: {
        type: 'invoice_customer',
        from: 'invoice',
        to: 'customer',
      },
      fromEntityId: invoice.entity.id,
      toEntityId: customer.entity.id,
    },
  ];
  return { sql, workspace, connection, invoice, customer, desired };
}

describe('relationship source claims', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('atomically keeps two concurrent source claims on one live triple', async () => {
    const { sql, workspace, connection, desired } = await seedClaimGraph();
    const [index] = await sql`
      SELECT i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'idx_entity_relationships_live_claims'
    `;
    expect(index?.indisvalid).toBe(true);

    await Promise.all([
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:source-a',
          desired,
        })
      ),
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:source-b',
          desired,
        })
      ),
    ]);

    const rows = await sql`
      SELECT id, metadata
      FROM entity_relationships
      WHERE organization_id = ${workspace.org.id} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).sort()).toEqual([
      `feed:${connection.id}:invoice:source-a`,
      `feed:${connection.id}:invoice:source-b`,
    ]);

    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:source-a',
        desired: [],
      })
    );
    const [retained] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships WHERE id = ${rows[0].id}
    `;
    expect(retained.deleted_at).toBeNull();
    expect(Object.keys(retained.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY])).toEqual([
      `feed:${connection.id}:invoice:source-b`,
    ]);
  });

  it('fails closed on an unclaimed pre-cutover row instead of silently adopting it', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;
    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, source, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${invoice.entity.id}, ${customer.entity.id}, ${type.id},
        ${sql.json({ migrated: false })}, 'api', NOW(), NOW()
      )
    `;

    await expect(
      sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId: 'invoice:needs-migration',
          desired,
        })
      )
    ).rejects.toThrow(/_lobu_claims.*migrate/i);

    const [unchanged] = await sql`
      SELECT metadata FROM entity_relationships WHERE organization_id = ${workspace.org.id}
    `;
    expect(unchanged.metadata).toEqual({ migrated: false });
  });

  it('retracts every claim one connection owns on a co-owned edge in one pass', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    await workspace.owner.entities.link({
      from_entity_id: invoice.entity.id,
      to_entity_id: customer.entity.id,
      relationship_type_slug: 'invoice_customer',
    });
    for (const originId of ['invoice:source-a', 'invoice:source-b']) {
      await sql.begin((tx) =>
        reconcileConnectorRelationshipClaims(tx, {
          organizationId: workspace.org.id,
          connectionId: connection.id,
          originId,
          desired,
        })
      );
    }
    await sql.begin((tx) =>
      retractConnectionRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
      })
    );

    const [row] = await sql`
      SELECT deleted_at, metadata FROM entity_relationships
      WHERE organization_id = ${workspace.org.id}
    `;
    expect(row.deleted_at).toBeNull();
    expect(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY]).toEqual({ manual: {} });
  });

  it('keeps link duplicate semantics when a connector already owns the edge', async () => {
    const { sql, workspace, connection, invoice, customer, desired } = await seedClaimGraph();
    await sql.begin((tx) =>
      reconcileConnectorRelationshipClaims(tx, {
        organizationId: workspace.org.id,
        connectionId: connection.id,
        originId: 'invoice:source',
        desired,
      })
    );

    await expect(
      workspace.owner.entities.link({
        from_entity_id: invoice.entity.id,
        to_entity_id: customer.entity.id,
        relationship_type_slug: 'invoice_customer',
        metadata: { requested: 'must-not-be-dropped' },
      })
    ).rejects.toThrow(/already exists/i);

    const [row] = await sql`
      SELECT metadata FROM entity_relationships WHERE organization_id = ${workspace.org.id}
    `;
    expect(row.metadata).not.toHaveProperty('requested');
    expect(Object.keys(row.metadata[RELATIONSHIP_CLAIMS_METADATA_KEY])).toEqual([
      `feed:${connection.id}:invoice:source`,
    ]);
  });

  // The same fail-closed rule the migration header documents, from the caller
  // surface: an unclaimed row is not manually owned either, so manage_entity
  // refuses it instead of guessing who asserts it.
  it('refuses manual mutation of an unclaimed relationship', async () => {
    const { sql, workspace, invoice, customer } = await seedClaimGraph();
    const [type] = await sql`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${workspace.org.id} AND slug = 'invoice_customer'
    `;
    const [unclaimed] = await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        source, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, ${invoice.entity.id}, ${customer.entity.id}, ${type.id},
        'api', NOW(), NOW()
      )
      RETURNING id
    `;

    await expect(
      workspace.owner.entities.manage({
        action: 'update_link',
        relationship_id: Number(unclaimed.id),
        confidence: 0.5,
      })
    ).rejects.toThrow(/_lobu_claims/);
    await expect(
      workspace.owner.entities.manage({
        action: 'unlink',
        relationship_id: Number(unclaimed.id),
      })
    ).rejects.toThrow(/_lobu_claims/);

    const [live] = await sql`
      SELECT deleted_at, confidence FROM entity_relationships WHERE id = ${unclaimed.id}
    `;
    expect(live.deleted_at).toBeNull();
    expect(live.confidence).toBeNull();
  });
});
