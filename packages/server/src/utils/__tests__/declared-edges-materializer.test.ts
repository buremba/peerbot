/**
 * SPIKE — the connector-facing half, end to end.
 *
 * The storage spike (`derived-edges-spike.test.ts`) proved the existing schema
 * can hold connector-declared edges. This proves a connector can DECLARE them
 * and that honouring the declaration needs no new machinery: the attribution
 * pass resolves both endpoints, the materializer writes one row.
 *
 * The ERP shape throughout: an `invoice` event carries its own origin id and
 * its customer's, and must become a typed `invoice_customer` edge.
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
import {
  type DeclaredEdgeRule,
  materializeDeclaredEdges,
  retractDeclaredEdges,
} from '../declared-edges-spike';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { ensureMemberEntityType } from '../member-entity-type';

const FEED_KEY = 'documents';
const RULE_VERSION = '1';

/** What the connector author writes — the proposed additive manifest field. */
const DECLARED_RELATIONSHIPS: DeclaredEdgeRule[] = [
  {
    type: 'invoice_customer',
    name: 'invoice_customer_rule',
    from: {
      entityType: '$member',
      identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.origin_id' }],
    },
    to: {
      entityType: '$member',
      identities: [{ namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' }],
    },
  },
];

async function setupOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  clearEntityLinkRulesCache();
  return { org, user };
}

/**
 * Both endpoints are minted by the EXISTING attribution surface. That is the
 * whole point: the materializer adds no resolution of its own.
 */
async function installConnector(orgId: string) {
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
                role: 'belongs_to',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.origin_id',
                  identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.origin_id' }],
                },
              },
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
        },
      },
    },
  });
  clearEntityLinkRulesCache();
}

const INVOICES = [
  {
    origin_type: 'invoice',
    metadata: {
      origin_id: 'FTR-2028-0001',
      customer_origin_id: 'CARI-001',
      customer_name: 'Akin Plastik A.S.',
    },
  },
  {
    origin_type: 'invoice',
    metadata: {
      origin_id: 'FTR-2028-0002',
      customer_origin_id: 'CARI-002',
      customer_name: 'Deniz Kalip Ltd.',
    },
  },
  {
    origin_type: 'invoice',
    metadata: {
      origin_id: 'FTR-2028-0003',
      customer_origin_id: 'CARI-001',
      customer_name: 'Akin Plastik A.S.',
    },
  },
];

async function ensureRelType(orgId: string, slug: string): Promise<number> {
  const sql = getTestDb();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${slug}, 'active', current_timestamp, current_timestamp)
    RETURNING id
  `;
  return Number(rows[0].id);
}

describe('SPIKE: honouring a connector-declared edge rule', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('materializes declared edges from a sync batch, idempotently, then retracts them', async () => {
    const { org, user } = await setupOrg('materializer org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    const relTypeId = await ensureRelType(org.id, 'invoice_customer');

    // --- the existing sync pass: resolves and mints both endpoints ---------
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });

    // 3 invoices + 2 distinct customers = 5 entities, from attribution alone.
    const entities = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.organization_id = ${org.id} AND et.slug = '$member' AND e.deleted_at IS NULL
    `;
    expect(entities[0].count).toBe('5');

    // --- the new part: honour the declaration -----------------------------
    const first = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(first).toEqual({ created: 3, duplicate: 0, unresolved: 0, unknownType: 0, retracted: 0 });

    // Two invoices point at CARI-001; both edges exist because the SOURCE
    // differs. Collapsing them would lose an invoice.
    const edges = await sql<{ from_entity_id: number; to_entity_id: number }[]>`
      SELECT from_entity_id, to_entity_id FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(edges).toHaveLength(3);
    expect(new Set(edges.map((e) => Number(e.to_entity_id))).size).toBe(2);

    // --- replay the same batch: a resync must not duplicate ---------------
    const replay = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(replay).toEqual({ created: 0, duplicate: 3, unresolved: 0, unknownType: 0, retracted: 0 });

    const afterReplay = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(afterReplay[0].count).toBe('3');

    // --- retraction, by rule version alone --------------------------------
    const retracted = await retractDeclaredEdges({
      orgId: org.id,
      relationshipTypeId: relTypeId,
      ruleVersion: RULE_VERSION,
      syncToken: 'retract-1',
    });
    expect(retracted).toBe(3);
    const afterRetract = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(afterRetract[0].count).toBe('0');
  });

  it('refuses a relationship type the org has not defined', async () => {
    // The `$links` gate decision requires the type be resolved from the DB,
    // never taken from a caller-supplied string. A connector must not be able
    // to name an authz-bearing type into existence by writing it in a manifest.
    const { org, user } = await setupOrg('unknown type org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });

    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      // Nothing created this type. A naive implementation would create it.
      rules: [{ ...DECLARED_RELATIONSHIPS[0], type: 'can_read' }],
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(result.created).toBe(0);
    expect(result.unknownType).toBe(3);

    const edges = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(edges[0].count).toBe('0');
    const types = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationship_types
      WHERE organization_id = ${org.id} AND slug = 'can_read'
    `;
    expect(types[0].count).toBe('0');
  });

  it('skips an unresolvable endpoint instead of writing a half edge', async () => {
    const { org, user } = await setupOrg('unresolvable org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await ensureRelType(org.id, 'invoice_customer');

    // Materialize WITHOUT running the attribution pass: nothing exists yet.
    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(result).toEqual({ created: 0, duplicate: 0, unresolved: 3, unknownType: 0, retracted: 0 });

    const edges = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(edges[0].count).toBe('0');

    // Run the attribution pass, then materialize again — the SAME batch now
    // resolves. This is the ordering answer: re-running converges, and no
    // pending-assertion state was needed to get there.
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });
    const second = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(second).toEqual({ created: 3, duplicate: 0, unresolved: 0, unknownType: 0, retracted: 0 });
  });

  it('writes no edge when only ONE endpoint resolves', async () => {
    // The dangerous asymmetric case: the invoice exists, the customer does not
    // (the ERP row omitted the cari code). Both-endpoints-missing is easy to
    // handle by accident; this is the one that produces a dangling half edge.
    const { org, user } = await setupOrg('half edge org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await ensureRelType(org.id, 'invoice_customer');

    const headless = [
      { origin_type: 'invoice', metadata: { origin_id: 'FTR-2028-0009', customer_name: '' } },
    ];
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: headless,
    });

    // Exactly one endpoint got minted.
    const invoiceSide = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'erp_invoice' AND deleted_at IS NULL
    `;
    expect(invoiceSide[0].count).toBe('1');
    const customerSide = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'erp_customer' AND deleted_at IS NULL
    `;
    expect(customerSide[0].count).toBe('0');

    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: headless,
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(result).toEqual({ created: 0, duplicate: 0, unresolved: 1, unknownType: 0, retracted: 0 });

    const edges = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(edges[0].count).toBe('0');
  });

  it('reconciles when an invoice moves to a DIFFERENT customer', async () => {
    // The retraction POLICY question, which storage alone does not answer:
    // FTR-0001 was billed to CARI-001, the ERP corrects it to CARI-002. The
    // stale edge must go, the new one must land, and every OTHER invoice's edge
    // must survive — a sync that retracts what it did not observe is worse than
    // one that retracts nothing.
    const { org, user } = await setupOrg('reconcile org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await ensureRelType(org.id, 'invoice_customer');

    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });
    await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES,
      createdBy: user.id,
      syncToken: 'sync-1',
      reconcile: true,
    });

    const idFor = async (namespace: string, identifier: string) => {
      const rows = await sql<{ entity_id: number }[]>`
        SELECT entity_id FROM entity_identities
        WHERE organization_id = ${org.id} AND namespace = ${namespace}
          AND identifier = ${identifier} AND deleted_at IS NULL
      `;
      return Number(rows[0].entity_id);
    };
    const invoice1 = await idFor('erp_invoice', 'FTR-2028-0001');
    const cari1 = await idFor('erp_customer', 'CARI-001');
    const cari2 = await idFor('erp_customer', 'CARI-002');

    // The correction arrives as a partial batch — only the changed invoice.
    const corrected = [
      {
        origin_type: 'invoice',
        metadata: {
          origin_id: 'FTR-2028-0001',
          customer_origin_id: 'CARI-002',
          customer_name: 'Deniz Kalip Ltd.',
        },
      },
    ];
    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: corrected,
      createdBy: user.id,
      syncToken: 'sync-1',
      reconcile: true,
    });
    expect(result).toEqual({
      created: 1,
      duplicate: 0,
      unresolved: 0,
      unknownType: 0,
      retracted: 1,
    });

    const live = await sql<{ from_entity_id: number; to_entity_id: number }[]>`
      SELECT from_entity_id, to_entity_id FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
      ORDER BY from_entity_id, to_entity_id
    `;
    // Still three edges: FTR-0001 repointed, FTR-0002 and FTR-0003 untouched.
    expect(live).toHaveLength(3);
    const forInvoice1 = live.filter((e) => Number(e.from_entity_id) === invoice1);
    expect(forInvoice1).toHaveLength(1);
    expect(Number(forInvoice1[0].to_entity_id)).toBe(cari2);

    // FTR-0003 still points at CARI-001 — the batch never observed it, so the
    // reconcile must not have touched it.
    const invoice3 = await idFor('erp_invoice', 'FTR-2028-0003');
    const forInvoice3 = live.filter((e) => Number(e.from_entity_id) === invoice3);
    expect(forInvoice3).toHaveLength(1);
    expect(Number(forInvoice3[0].to_entity_id)).toBe(cari1);

    // The withdrawn edge is tombstoned, not deleted — the history survives.
    const tombstoned = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND from_entity_id = ${invoice1}
        AND to_entity_id = ${cari1} AND deleted_at IS NOT NULL
    `;
    expect(tombstoned[0].count).toBe('1');
  });

  it('a rule VERSION BUMP repoints instead of stranding the old edge', async () => {
    // Reconcile must own the whole derived slice for (from_entity, type). If it
    // were scoped to the current ruleVersion, bumping the version would leave
    // v1's edge live forever — no later sync would ever claim it.
    const { org, user } = await setupOrg('version bump org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    await ensureRelType(org.id, 'invoice_customer');
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });
    await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: '1',
      rules: DECLARED_RELATIONSHIPS,
      items: [INVOICES[0]],
      createdBy: user.id,
      syncToken: 'sync-1',
      reconcile: true,
    });

    // Same invoice, corrected customer, but now under rule version 2.
    const bumped = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: '2',
      rules: DECLARED_RELATIONSHIPS,
      items: [
        {
          origin_type: 'invoice',
          metadata: { origin_id: 'FTR-2028-0001', customer_origin_id: 'CARI-002' },
        },
      ],
      createdBy: user.id,
      syncToken: 'sync-1',
      reconcile: true,
    });
    expect(bumped.created).toBe(1);
    expect(bumped.retracted).toBe(1);

    const live = await sql<{ rule_version: string }[]>`
      SELECT c.value ->> 'ruleVersion' AS rule_version
      FROM entity_relationships r, LATERAL jsonb_each(r.metadata -> 'claims') AS c
      WHERE r.organization_id = ${org.id} AND r.deleted_at IS NULL
    `;
    expect(live).toHaveLength(1);
    expect(live[0].rule_version).toBe('2');
  });

  it('never retracts a hand-authored edge', async () => {
    // The `derivedFrom` predicate is the ownership boundary. A person who drew
    // an edge in the UI must not have it swept away by the next sync.
    const { org, user } = await setupOrg('hand authored org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    const relTypeId = await ensureRelType(org.id, 'invoice_customer');
    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });

    const idFor = async (namespace: string, identifier: string) => {
      const rows = await sql<{ entity_id: number }[]>`
        SELECT entity_id FROM entity_identities
        WHERE organization_id = ${org.id} AND namespace = ${namespace}
          AND identifier = ${identifier} AND deleted_at IS NULL
      `;
      return Number(rows[0].entity_id);
    };
    const invoice1 = await idFor('erp_invoice', 'FTR-2028-0001');
    const cari2 = await idFor('erp_customer', 'CARI-002');

    // A human links FTR-0001 to CARI-002 by hand — no `derivedFrom`.
    await sql`
      INSERT INTO entity_relationships (
        organization_id, from_entity_id, to_entity_id, relationship_type_id,
        metadata, confidence, source, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${org.id}, ${invoice1}, ${cari2}, ${relTypeId},
        ${sql.json({})}, 1.0, 'ui', ${user.id}, ${user.id},
        current_timestamp, current_timestamp
      )
    `;

    // The sync says FTR-0001 belongs to CARI-001. Reconcile must add its own
    // edge and leave the human's alone.
    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: RULE_VERSION,
      rules: DECLARED_RELATIONSHIPS,
      items: [INVOICES[0]],
      createdBy: user.id,
      syncToken: 'sync-1',
      reconcile: true,
    });
    expect(result.created).toBe(1);
    expect(result.retracted).toBe(0);

    const handMade = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND from_entity_id = ${invoice1}
        AND to_entity_id = ${cari2} AND source = 'ui' AND deleted_at IS NULL
    `;
    expect(handMade[0].count).toBe('1');
  });

  it('retracts one rule version of the SAME type, leaving the other live', async () => {
    // Both slices share a relationship type, so only the ruleVersion predicate
    // can tell them apart — a retraction keyed on type alone would take both.
    const { org, user } = await setupOrg('rule version org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    const relTypeId = await ensureRelType(org.id, 'invoice_customer');

    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });
    await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: '1',
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES.slice(0, 2),
      createdBy: user.id,
      syncToken: 'sync-1',
    });
    await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: '2',
      rules: DECLARED_RELATIONSHIPS,
      items: INVOICES.slice(2),
      createdBy: user.id,
      syncToken: 'sync-1',
    });

    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(before[0].count).toBe('3');

    const retracted = await retractDeclaredEdges({
      orgId: org.id,
      relationshipTypeId: relTypeId,
      ruleVersion: '1',
      syncToken: 'retract-1',
    });
    expect(retracted).toBe(2);

    const survivors = await sql<{ rule_version: string }[]>`
      SELECT c.value ->> 'ruleVersion' AS rule_version
      FROM entity_relationships r, LATERAL jsonb_each(r.metadata -> 'claims') AS c
      WHERE r.organization_id = ${org.id} AND r.deleted_at IS NULL
    `;
    expect(survivors).toHaveLength(1);
    expect(survivors[0].rule_version).toBe('2');
  });

  it('retracts one relationship type at the SAME rule version, leaving the other live', async () => {
    // Mirror image: both slices share a rule version, so only the type
    // predicate can tell them apart.
    const { org, user } = await setupOrg('rule type org');
    const sql = getTestDb();
    await installConnector(org.id);
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'prodma',
      display_name: 'Prodma',
      created_by: user.id,
      createDefaultFeed: false,
    });
    const relTypeId = await ensureRelType(org.id, 'invoice_customer');
    const otherTypeId = await ensureRelType(org.id, 'invoice_salesrep');

    await applyEventAttributions({
      connectorKey: 'prodma',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: INVOICES,
    });
    for (const type of ['invoice_customer', 'invoice_salesrep']) {
      await materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: RULE_VERSION,
        rules: [{ ...DECLARED_RELATIONSHIPS[0], type }],
        items: INVOICES.slice(0, 2),
        createdBy: user.id,
      syncToken: 'sync-1',
      });
    }

    const before = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(before[0].count).toBe('4');

    const retracted = await retractDeclaredEdges({
      orgId: org.id,
      relationshipTypeId: relTypeId,
      ruleVersion: RULE_VERSION,
      syncToken: 'retract-1',
    });
    expect(retracted).toBe(2);

    const survivors = await sql<{ relationship_type_id: number }[]>`
      SELECT relationship_type_id FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(survivors).toHaveLength(2);
    expect(survivors.every((r) => Number(r.relationship_type_id) === otherTypeId)).toBe(true);
  });
});
