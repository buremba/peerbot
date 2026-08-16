/**
 * SPIKE — reproducing the two critical findings from the codex review, rather
 * than accepting them on assertion. Both are expected to FAIL against the
 * current spike implementation; each documents a real defect.
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

async function baseOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);
  clearEntityLinkRulesCache();
  const sql = getTestDb();
  await sql`
    INSERT INTO entity_relationship_types (organization_id, slug, name, status, created_at, updated_at)
    VALUES (${org.id}, 'invoice_customer', 'invoice_customer', 'active', current_timestamp, current_timestamp)
  `;
  return { org, user, sql };
}

describe('codex finding: resolveEndpoint bypasses identity normalization', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('an EMAIL endpoint stored lowercase is not found by the raw mixed-case lookup', async () => {
    const { org, user, sql } = await baseOrg('normalize org');
    await createTestConnectorDefinition({
      key: 'crm',
      name: 'crm',
      organization_id: org.id,
      feeds_schema: {
        [FEED_KEY]: {
          eventKinds: {
            deal: {
              attributions: [
                {
                  role: 'belongs_to',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    titlePath: 'metadata.deal_id',
                    identities: [{ namespace: 'crm_deal', eventPath: 'metadata.deal_id' }],
                  },
                },
                {
                  role: 'about',
                  autoCreate: true,
                  target: {
                    entityType: '$member',
                    titlePath: 'metadata.contact_email',
                    identities: [{ namespace: 'email', eventPath: 'metadata.contact_email' }],
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
      connector_key: 'crm',
      display_name: 'CRM',
      created_by: user.id,
      createDefaultFeed: false,
    });

    // The source system reports the contact in mixed case, as they all do.
    const items = [
      {
        origin_type: 'deal',
        metadata: { deal_id: 'D-1', contact_email: 'Alice@EXAMPLE.com' },
      },
    ];
    await applyEventAttributions({
      connectorKey: 'crm',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items,
    });

    // Attribution normalized it on the way in.
    const stored = await sql<{ identifier: string }[]>`
      SELECT identifier FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'email' AND deleted_at IS NULL
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0].identifier).toBe('alice@example.com');

    const rules: DeclaredEdgeRule[] = [
      {
        type: 'invoice_customer',
        name: 'invoice_customer_rule',
    name: 'invoice_customer_rule',
        from: {
          entityType: '$member',
          identities: [{ namespace: 'crm_deal', eventPath: 'metadata.deal_id' }],
        },
        to: {
          entityType: '$member',
          identities: [{ namespace: 'email', eventPath: 'metadata.contact_email' }],
        },
      },
    ];
    const result = await materializeDeclaredEdges({
      orgId: org.id,
      connectionId: connection.id,
      ruleVersion: '1',
      rules,
      items,
      createdBy: user.id,
      syncToken: 'sync-1',
    });

    // Both entities exist and the declaration is correct, yet the edge is lost:
    // the materializer searched for `Alice@EXAMPLE.com`.
    expect(result.created).toBe(1);
    expect(result.unresolved).toBe(0);
  });
});

describe('codex finding: one row cannot hold two independent claims', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('retracting owner A destroys owner B\'s still-valid edge', async () => {
    const { org, user, sql } = await baseOrg('co-ownership org');
    await createTestConnectorDefinition({
      key: 'erp',
      name: 'erp',
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
                    titlePath: 'metadata.customer_origin_id',
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
      connector_key: 'erp',
      display_name: 'ERP',
      created_by: user.id,
      createDefaultFeed: false,
    });

    const items = [
      {
        origin_type: 'invoice',
        metadata: { origin_id: 'FTR-1', customer_origin_id: 'CARI-1' },
      },
    ];
    await applyEventAttributions({
      connectorKey: 'erp',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items,
    });

    const rules: DeclaredEdgeRule[] = [
      {
        type: 'invoice_customer',
        name: 'invoice_customer_rule',
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

    // Two independent owners assert the SAME triple. Owner A wins the insert;
    // owner B's claim is silently dropped by ON CONFLICT DO NOTHING.
    const a = await materializeDeclaredEdges({
      orgId: org.id, connectionId: connection.id, ruleVersion: 'owner-a',
      rules: [{ ...rules[0], name: 'rule_a' }], items, createdBy: user.id,
      syncToken: 'sync-1',
    });
    const b = await materializeDeclaredEdges({
      orgId: org.id, connectionId: connection.id, ruleVersion: 'owner-b',
      rules: [{ ...rules[0], name: 'rule_b' }], items, createdBy: user.id,
      syncToken: 'sync-1',
    });
    expect(a.created).toBe(1);
    expect(b.duplicate).toBe(1);

    const typeRow = await sql<{ id: number }[]>`
      SELECT id FROM entity_relationship_types
      WHERE organization_id = ${org.id} AND slug = 'invoice_customer'
    `;

    // Owner A's rule is removed. Owner B still asserts this edge.
    await retractDeclaredEdges({
      orgId: org.id,
      relationshipTypeId: Number(typeRow[0].id),
      ruleVersion: 'owner-a',
      syncToken: 'retract-1',
    });

    const live = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM entity_relationships
      WHERE organization_id = ${org.id} AND deleted_at IS NULL
    `;
    // B never withdrew its claim, so the edge must survive.
    expect(live[0].count).toBe('1');
  });
});

describe('codex finding: cross-owner reconcile oscillation', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('two owners asserting DIFFERENT targets no longer delete each other', async () => {
    // A says invoice -> CARI-1, B says invoice -> CARI-2. Before reconcile was
    // scoped to the owner, each sync deleted the other's edge and the live
    // graph flipped with arrival order. Both are legitimate independent
    // assertions and both must survive.
    const { org, user, sql } = await baseOrg('cross owner org');
    await createTestConnectorDefinition({
      key: 'erp',
      name: 'erp',
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
                    titlePath: 'metadata.customer_origin_id',
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
      connector_key: 'erp',
      display_name: 'ERP',
      created_by: user.id,
      createDefaultFeed: false,
    });

    const itemsA = [
      { origin_type: 'invoice', metadata: { origin_id: 'FTR-1', customer_origin_id: 'CARI-1' } },
    ];
    const itemsB = [
      { origin_type: 'invoice', metadata: { origin_id: 'FTR-1', customer_origin_id: 'CARI-2' } },
    ];
    await applyEventAttributions({
      connectorKey: 'erp',
      connectionId: connection.id,
      feedKey: FEED_KEY,
      orgId: org.id,
      items: [...itemsA, ...itemsB],
    });

    const base: DeclaredEdgeRule = {
      type: 'invoice_customer',
      name: 'placeholder',
      from: {
        entityType: '$member',
        identities: [{ namespace: 'erp_invoice', eventPath: 'metadata.origin_id' }],
      },
      to: {
        entityType: '$member',
        identities: [{ namespace: 'erp_customer', eventPath: 'metadata.customer_origin_id' }],
      },
    };

    // Interleave two full sync rounds, the sequence that used to oscillate.
    for (let round = 0; round < 2; round++) {
      await materializeDeclaredEdges({
        orgId: org.id, connectionId: connection.id, ruleVersion: '1',
        rules: [{ ...base, name: 'owner_a' }], items: itemsA,
        createdBy: user.id, reconcile: true, syncToken: `a-${round}`,
      });
      await materializeDeclaredEdges({
        orgId: org.id, connectionId: connection.id, ruleVersion: '1',
        rules: [{ ...base, name: 'owner_b' }], items: itemsB,
        createdBy: user.id, reconcile: true, syncToken: `b-${round}`,
      });
    }

    // Ownership now lives in the claim SET, so read one row per (edge, owner)
    // rather than a single derivedFrom owner per edge.
    const live = await sql<{ owner_id: string }>`
      SELECT k AS owner_id
      FROM entity_relationships r,
           LATERAL jsonb_object_keys(r.metadata -> 'claims') AS k
      WHERE r.organization_id = ${org.id} AND r.deleted_at IS NULL
      ORDER BY 1
    `;
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.owner_id.split(':')[1])).toEqual(['owner_a', 'owner_b']);
  });
});
