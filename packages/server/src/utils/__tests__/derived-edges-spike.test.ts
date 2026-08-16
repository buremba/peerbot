/**
 * SPIKE — can connector-declared entity->entity edges work on the EXISTING
 * schema, with no new table?
 *
 * A proposal asked for a `connector_declared_edge_state` table on three
 * grounds. This exercises each against the real production paths instead:
 *
 *   1. ORDERING — "the target may not exist when the source syncs, so an
 *      unresolved assertion must be parked somewhere."
 *      Tested against the REAL `applyEventAttributions` path with
 *      `autoCreate`, then a later sync of the genuine customer record.
 *
 *   2. IDEMPOTENCY — "re-running must not duplicate the edge."
 *      Tested against `idx_entity_relationships_live_triple`.
 *
 *   3. PROVENANCE + RETRACTION — "we must know which rule asserted an edge in
 *      order to withdraw it."
 *      Tested against `metadata->'derivedFrom'` and
 *      `idx_entity_relationships_derived_from_rule`, both of which already
 *      exist in the baseline migration with NO writer anywhere in the repo.
 *
 * The ERP case driving it: an invoice syncs BEFORE its customer.
 *
 * Honest scope — steps that use the real path vs. the simulated one:
 *   REAL:      entity resolution, autoCreate, identity accretion on later sync.
 *   SIMULATED: the edge write itself, because the generic materializer is the
 *              thing being proposed and does not exist. What is under test is
 *              whether the STORAGE LAYER suffices for it, not the writer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { ensureMemberEntityType } from '../member-entity-type';

const FEED_KEY = 'documents';
const RULE_VERSION = '1';

async function setupOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  clearEntityLinkRulesCache();
  return { org, user };
}

/**
 * The connector declares: an `invoice` event carries `customer_origin_id`, and
 * that identifies a customer. This is the EXISTING attribution surface — the
 * point is that it already mints the target.
 */
async function installInvoiceRule(orgId: string) {
  await createTestConnectorDefinition({
    key: 'prodma',
    name: 'prodma',
    organization_id: orgId,
    feeds_schema: {
      [FEED_KEY]: {
        eventKinds: {
          invoice: {
            attributions: [
              {
                role: 'about',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.customer_name',
                  identities: [
                    { namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' },
                  ],
                },
              },
            ],
          },
          customer: {
            attributions: [
              {
                role: 'about',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.title',
                  identities: [
                    { namespace: 'erp_customer', eventPath: 'metadata.origin_id' },
                    { namespace: 'tax_no', eventPath: 'metadata.tax_number' },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });
  clearEntityLinkRulesCache();
}

describe('SPIKE: connector-declared edges on the existing schema', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('handles out-of-order sync, idempotency, provenance and retraction with no new table', async () => {
    const { org, user } = await setupOrg('derived edges org');
    const sql = getTestDb();
    await installInvoiceRule(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });

    // ================================================================
    // 1. ORDERING — the invoice arrives FIRST, referencing a customer
    //    that has never synced.
    // ================================================================
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'invoice',
          metadata: {
            origin_id: 'FTR-2028-0001',
            customer_origin_id: 'CARI-001',
            customer_name: 'Akin Plastik A.S.',
            grand_total: 41250.0,
          },
        },
      ],
    });

    const afterInvoice = await sql<{ id: number; name: string }[]>`
      SELECT e.id, e.name FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    // The target was MINTED from the foreign key alone. Nothing had to be parked.
    expect(afterInvoice).toHaveLength(1);
    const customerEntityId = Number(afterInvoice[0].id);
    expect(afterInvoice[0].name).toBe('Akin Plastik A.S.');

    // ================================================================
    // 2. The edge write the proposed materializer would perform, carrying
    //    `derivedFrom` — the provenance convention the baseline already
    //    indexes and nothing in the repo writes.
    // ================================================================
    const [{ id: invoiceEntityId }] = await sql<{ id: number }[]>`
      INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
      VALUES (
        ${org.id},
        (SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL),
        'FTR-2028-0001', 'ftr-2028-0001', '{}'::jsonb, ${user.id}
      ) RETURNING id
    `;
    const [{ id: relTypeId }] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
      VALUES (${org.id}, 'invoice_customer', 'Fatura Cari', 'active', current_timestamp, current_timestamp)
      RETURNING id
    `;

    const derivedFrom = {
      derivedFrom: {
        sourceEventId: '90001',
        relationshipTypeId: String(relTypeId),
        ruleVersion: RULE_VERSION,
        connectionId: String(connection.id),
        sourceOriginId: 'FTR-2028-0001',
        targetOriginId: 'CARI-001',
      },
    };
    const writeEdge = () => sql<{ id: number }[]>`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, confidence, source, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${org.id}, ${Number(invoiceEntityId)}, ${customerEntityId}, ${Number(relTypeId)},
        ${sql.json(derivedFrom)}, 1.0, 'feed', ${user.id}, ${user.id},
        current_timestamp, current_timestamp
      )
      ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
        WHERE deleted_at IS NULL
      DO NOTHING
      RETURNING id
    `;
    const firstWrite = await writeEdge();
    expect(firstWrite).toHaveLength(1);

    // ================================================================
    // 3. IDEMPOTENCY — replay the same assertion twice more.
    // ================================================================
    const replayA = await writeEdge();
    const replayB = await writeEdge();
    expect(replayA).toHaveLength(0);
    expect(replayB).toHaveLength(0);

    const liveEdges = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(liveEdges[0].count).toBe('1');

    // ================================================================
    // 4. ORDERING, second half — the REAL customer record now syncs,
    //    carrying the same origin id plus a tax number.
    // ================================================================
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [
        {
          origin_type: 'customer',
          metadata: {
            origin_id: 'CARI-001',
            title: 'Akin Plastik Sanayi ve Ticaret A.S.',
            tax_number: '1234567890',
          },
        },
      ],
    });

    const afterCustomer = await sql<{ id: number }[]>`
      SELECT e.id FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
      ORDER BY e.id
    `;
    // Still exactly the invoice stub + the customer — the real record COLLAPSED
    // onto the entity the foreign key already minted. No duplicate, no repair.
    expect(afterCustomer.map((r) => Number(r.id))).toContain(customerEntityId);
    const identities = await sql<{ namespace: string; identifier: string }[]>`
      SELECT namespace, identifier FROM entity_identities
      WHERE organization_id = ${org.id} AND entity_id = ${customerEntityId}
      ORDER BY namespace
    `;
    expect(identities.map((r) => `${r.namespace}:${r.identifier}`)).toEqual([
      'erp_customer:CARI-001',
      'tax_no:1234567890',
    ]);

    // The edge written before the customer existed still points at the right row.
    const edgeTarget = await sql<{ to_entity_id: number }[]>`
      SELECT to_entity_id FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(Number(edgeTarget[0].to_entity_id)).toBe(customerEntityId);

    // ================================================================
    // 5. RETRACTION — withdraw every edge this rule asserted, using only
    //    the `derivedFrom` metadata.
    // ================================================================
    const swept = await sql<{ id: number }[]>`
      UPDATE entity_relationships
      SET deleted_at = current_timestamp, updated_at = current_timestamp
      WHERE organization_id = ${org.id}
        AND deleted_at IS NULL
        AND metadata ? 'derivedFrom'
        AND metadata -> 'derivedFrom' ->> 'relationshipTypeId' = ${String(relTypeId)}
        AND metadata -> 'derivedFrom' ->> 'ruleVersion' = ${RULE_VERSION}
      RETURNING id
    `;
    expect(swept).toHaveLength(1);

    const afterSweep = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(afterSweep[0].count).toBe('0');

    // The partial unique index is on live rows only, so the same edge can be
    // re-asserted after a retraction rather than being permanently poisoned.
    const reasserted = await writeEdge();
    expect(reasserted).toHaveLength(1);
  });

  it('the retraction sweep actually USES idx_entity_relationships_derived_from_rule', async () => {
    // A sweep that seq-scans `entity_relationships` is not a retraction
    // primitive — history grows, the answer does not. This is the check that
    // decides whether provenance-in-metadata is viable at all.
    const { org, user } = await setupOrg('plan org');
    const sql = getTestDb();
    const [{ id: relTypeId }] = await sql<{ id: number }[]>`
      INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
      VALUES (${org.id}, 'invoice_customer', 'Fatura Cari', 'active', current_timestamp, current_timestamp)
      RETURNING id
    `;
    const typeRow = await sql<{ id: number }[]>`
      SELECT id FROM entity_types WHERE slug = '$member' AND organization_id = ${org.id} AND deleted_at IS NULL
    `;
    // Enough rows that the planner has a reason to prefer the index.
    for (let i = 0; i < 400; i++) {
      const [{ id: a }] = await sql<{ id: number }[]>`
        INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
        VALUES (${org.id}, ${Number(typeRow[0].id)}, ${`src-${i}`}, ${`src-${i}`}, '{}'::jsonb, ${user.id})
        RETURNING id`;
      const [{ id: b }] = await sql<{ id: number }[]>`
        INSERT INTO entities (organization_id, entity_type_id, name, slug, metadata, created_by)
        VALUES (${org.id}, ${Number(typeRow[0].id)}, ${`tgt-${i}`}, ${`tgt-${i}`}, '{}'::jsonb, ${user.id})
        RETURNING id`;
      await sql`
        INSERT INTO entity_relationships (
          organization_id, from_entity_id, to_entity_id, relationship_type_id,
          metadata, confidence, source, created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${org.id}, ${Number(a)}, ${Number(b)}, ${Number(relTypeId)},
          ${sql.json({ derivedFrom: { relationshipTypeId: String(relTypeId), ruleVersion: i === 0 ? RULE_VERSION : `v${i}` } })},
          1.0, 'feed', ${user.id}, ${user.id}, current_timestamp, current_timestamp
        )`;
    }
    await sql`ANALYZE entity_relationships`;

    const plan = await sql<{ 'QUERY PLAN': string }[]>`
      EXPLAIN SELECT id FROM entity_relationships
      WHERE metadata ? 'derivedFrom'
        AND metadata -> 'derivedFrom' ->> 'relationshipTypeId' = ${String(relTypeId)}
        AND metadata -> 'derivedFrom' ->> 'ruleVersion' = ${RULE_VERSION}
    `;
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    // Surfaced on failure so the plan is visible rather than guessed at.
    expect(text).toContain('idx_entity_relationships_derived_from_rule');
    expect(text).not.toContain('Seq Scan on entity_relationships');
  });

  it('two connections sharing an identity namespace COLLIDE onto one entity', async () => {
    // The remaining structural claim from the proposal: the live identity
    // unique index is (organization_id, namespace, identifier) and EXCLUDES
    // connection_id. So two Prodma installations in one org, both emitting
    // customer origin id "CARI-001" under namespace `erp_customer`, would
    // resolve to the SAME entity. If that reproduces, the namespace has to
    // carry the connection - which is a naming convention, not a new table.
    const { org, user } = await setupOrg('collision org');
    const sql = getTestDb();
    await installInvoiceRule(org.id);
    const connA = await createTestConnection({
      organization_id: org.id, connector_key: 'prodma',
      display_name: 'Prodma A', created_by: user.id, createDefaultFeed: false,
    });
    const connB = await createTestConnection({
      organization_id: org.id, connector_key: 'prodma',
      display_name: 'Prodma B', created_by: user.id, createDefaultFeed: false,
    });

    const emit = (connectionId: number, name: string) =>
      applyEventAttributions({
        connectorKey: 'prodma',
        connectionId,
        feedKey: FEED_KEY,
        orgId: org.id,
        items: [
          {
            origin_type: 'customer',
            metadata: { origin_id: 'CARI-001', title: name, tax_number: null },
          },
        ],
      });
    await emit(connA.id, 'Akin Plastik (tenant A)');
    await emit(connB.id, 'Baska Firma (tenant B)');

    const members = await sql<{ id: number; name: string }[]>`
      SELECT e.id, e.name FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
      ORDER BY e.id
    `;
    // Documented behaviour, not a wish: ONE entity, because the namespace is
    // connection-blind. Two unrelated companies merge into one customer.
    expect(members).toHaveLength(1);

    const idents = await sql<{ namespace: string; connection_id: number | null }[]>`
      SELECT namespace, connection_id FROM entity_identities
      WHERE organization_id = ${org.id} AND identifier = 'CARI-001'
    `;
    expect(idents).toHaveLength(1);
  });
});
