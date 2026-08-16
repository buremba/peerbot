/**
 * SPIKE — the strongest case FOR a dedicated state table: concurrency.
 *
 * Two sync replicas processing overlapping batches for the same connection is
 * the scenario a `connector_declared_edge_state` table is usually argued for.
 * If `ON CONFLICT DO NOTHING` on the live-triple index does not hold under a
 * genuine race, the no-new-table conclusion is wrong.
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
import { type DeclaredEdgeRule, materializeDeclaredEdges } from '../declared-edges-spike';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { ensureMemberEntityType } from '../member-entity-type';

const FEED_KEY = 'documents';

const RULES: DeclaredEdgeRule[] = [
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

const INVOICES = Array.from({ length: 20 }, (_, i) => ({
  origin_type: 'invoice',
  metadata: {
    origin_id: `FTR-${String(i).padStart(4, '0')}`,
    customer_origin_id: `CARI-${i % 4}`,
    customer_name: `Musteri ${i % 4}`,
  },
}));

async function setup(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  await createTestConnectorDefinition({
    key: 'prodma',
    name: 'prodma',
    organization_id: org.id,
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
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: 'prodma',
    display_name: 'Prodma',
    created_by: user.id,
    createDefaultFeed: false,
  });
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
    VALUES (${org.id}, 'invoice_customer', 'invoice_customer', 'active', current_timestamp, current_timestamp)
  `;
  await applyEventAttributions({
    connectorKey: 'prodma',
    connectionId: connection.id,
    feedKey: FEED_KEY,
    orgId: org.id,
    items: INVOICES,
  });
  return { org, user, connection, sql };
}

describe('SPIKE: declared edges under concurrency', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('two replicas materializing the SAME batch concurrently write each edge once', async () => {
    const { org, user, connection, sql } = await setup('race org');

    const [a, b] = await Promise.all([
      materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items: INVOICES,
        createdBy: user.id,
      syncToken: 'sync-1',
      }),
      materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items: INVOICES,
        createdBy: user.id,
      syncToken: 'sync-1',
      }),
    ]);

    // Every edge lands exactly once, and the two callers between them account
    // for all 20 — whichever way the race split them.
    expect(a.created + b.created).toBe(20);
    expect(a.duplicate + b.duplicate).toBe(20);
    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    expect(rows[0].count).toBe('20');
  });

  it('concurrent RECONCILE of conflicting batches converges without losing both edges', async () => {
    // The nastier race: replica A says FTR-0000 -> CARI-0, replica B says
    // FTR-0000 -> CARI-1, both reconciling. One must win; the invoice must not
    // end up with ZERO customer edges.
    const { org, user, connection, sql } = await setup('conflict org');

    const batchA = [
      {
        origin_type: 'invoice',
        metadata: { origin_id: 'FTR-0000', customer_origin_id: 'CARI-0' },
      },
    ];
    const batchB = [
      {
        origin_type: 'invoice',
        metadata: { origin_id: 'FTR-0000', customer_origin_id: 'CARI-1' },
      },
    ];

    await Promise.all([
      materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items: batchA,
        createdBy: user.id,
      syncToken: 'sync-1',
        reconcile: true,
      }),
      materializeDeclaredEdges({
        orgId: org.id,
        connectionId: connection.id,
        ruleVersion: '1',
        rules: RULES,
        items: batchB,
        createdBy: user.id,
      syncToken: 'sync-1',
        reconcile: true,
      }),
    ]);

    const live = await sql<{ to_entity_id: number }[]>`
      SELECT r.to_entity_id FROM entity_relationships r
      JOIN entity_identities i ON i.entity_id = r.from_entity_id
      WHERE r.organization_id = ${org.id} AND r.deleted_at IS NULL
        AND i.namespace = 'erp_invoice' AND i.identifier = 'FTR-0000'
    `;
    // THIS is the assertion that matters. Zero live edges = the invoice silently
    // lost its customer to a race, which is exactly the data loss a state table
    // is supposed to prevent.
    expect(live.length).toBeGreaterThanOrEqual(1);
  });
});
