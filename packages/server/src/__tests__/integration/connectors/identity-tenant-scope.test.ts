/**
 * Identity scope: does an identifier mean the same thing across upstream tenants?
 *
 * `idx_entity_identities_live_unique_tenant_scoped` keys on
 * `(organization_id, namespace, identifier, COALESCE(scope_key, ''))`.
 * A connector declares `scope` per identity namespace, because only it knows
 * whether its namespace is globally meaningful:
 *
 *   - `scope: 'tenant'` — `erp_customer` `CARI-001` is a DIFFERENT customer
 *     in two different ERP tenants, while reconnecting to the same tenant must
 *     converge on the existing customer.
 *   - default (`organization`) — a Slack user id names the same person no
 *     matter which connection observed it, so two connections must collapse.
 *
 * Both directions are pinned here: getting either one wrong is a data defect,
 * and they fail in opposite directions (fragmenting one entity vs merging two
 * tenants' records).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyEventAttributions, clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { ensureMemberEntityType } from '../../../utils/member-entity-type';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'erp-scope-contract';
const feedKey = 'customers';

/**
 * One connector, two namespaces on the same rule: `erp_customer` is
 * tenant-scoped, `email` is not. A mixed rule is the interesting case — it
 * proves scope is resolved per identity rather than per rule or per call.
 */
async function seed() {
  await cleanupTestDatabase();
  clearEntityLinkRulesCache();

  const org = await createTestOrganization({ name: 'Identity Scope Org' });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensureMemberEntityType(org.id);

  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'ERP Scope Contract',
    organization_id: org.id,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          customer: {
            attributions: [
              {
                role: 'about',
                autoCreate: true,
                target: {
                  entityType: '$member',
                  titlePath: 'metadata.name',
                  identities: [
                    {
                      namespace: 'erp_customer',
                      eventPath: 'metadata.customer_code',
                      scope: 'tenant',
                      scopeKeyPath: 'metadata.tenant_id',
                    },
                    { namespace: 'email', eventPath: 'metadata.email' },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  });

  const tenantA = await createTestConnection({
    organization_id: org.id,
    connector_key: connectorKey,
    display_name: 'ERP Tenant A',
    createDefaultFeed: false,
  });
  const tenantB = await createTestConnection({
    organization_id: org.id,
    connector_key: connectorKey,
    display_name: 'ERP Tenant B',
    createDefaultFeed: false,
  });

  clearEntityLinkRulesCache();
  return { org, tenantA, tenantB };
}

function customerEvent(code: string, name: string, tenantId?: unknown, email?: string) {
  return {
    origin_type: 'customer',
    metadata: {
      customer_code: code,
      name,
      ...(tenantId !== undefined ? { tenant_id: tenantId } : {}),
      ...(email ? { email } : {}),
    },
  };
}

async function memberCount(orgId: string): Promise<number> {
  const sql = getTestDb();
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId} AND et.slug = '$member' AND e.deleted_at IS NULL
  `;
  return Number(rows[0].n);
}

describe('connector tenant identity scope', () => {
  beforeEach(() => {
    clearEntityLinkRulesCache();
  });

  it('keeps the same identifier separate across different tenant keys', async () => {
    const { org, tenantA, tenantB } = await seed();
    const sql = getTestDb();

    // Same customer_code, two ERP tenants, no other identifier to link them.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantA.id,
      items: [customerEvent('CARI-001', 'Acme A', 'tenant-a')],
    });
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantB.id,
      items: [customerEvent('CARI-001', 'Beta B', 'tenant-b')],
    });

    expect(await memberCount(org.id)).toBe(2);

    const rows = await sql<{ identifier: string; scope_key: string | null }[]>`
      SELECT identifier, scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'erp_customer' AND deleted_at IS NULL
      ORDER BY scope_key
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scope_key)).toEqual(['tenant-a', 'tenant-b']);
  });

  it('converges across two Lobu connections to the same upstream tenant', async () => {
    const { org, tenantA, tenantB } = await seed();

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantA.id,
      items: [customerEvent('CARI-001', 'Acme A', 'shared-tenant')],
    });
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantB.id,
      items: [customerEvent('CARI-001', 'Acme after reconnect', 'shared-tenant')],
    });

    expect(await memberCount(org.id)).toBe(1);
  });

  it('still collapses an org-scoped identifier across the same two connections', async () => {
    const { org, tenantA, tenantB } = await seed();
    const sql = getTestDb();

    // Distinct customer codes so `erp_customer` cannot be what links them —
    // only the shared, org-scoped `email` can.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantA.id,
      items: [customerEvent('CARI-001', 'Dana', 'tenant-a', 'dana@example.com')],
    });
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantB.id,
      items: [customerEvent('CARI-999', 'Dana', 'tenant-b', 'dana@example.com')],
    });

    // One person, seen through two connections. This is the case a blanket
    // `connection_id` in the unique index would have broken.
    expect(await memberCount(org.id)).toBe(1);

    const emails = await sql<{ scope_key: string | null }[]>`
      SELECT scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = 'email' AND deleted_at IS NULL
    `;
    expect(emails).toHaveLength(1);
    expect(emails[0].scope_key).toBeNull();
  });

  it('is idempotent when the same connection re-syncs a scoped identifier', async () => {
    const { org, tenantA } = await seed();
    const sql = getTestDb();

    // The ON CONFLICT DO UPDATE path with a NON-NULL scope_key — the
    // conflict target is an expression index, so a re-sync is where a
    // mismatched inference would surface as a duplicate row rather than an
    // error.
    for (let i = 0; i < 2; i++) {
      await applyEventAttributions({
        connectorKey,
        feedKey,
        orgId: org.id,
        connectionId: tenantA.id,
        items: [customerEvent('CARI-042', 'Repeat Customer', 'tenant-a')],
      });
    }

    expect(await memberCount(org.id)).toBe(1);
    const rows = await sql<{ scope_key: string | null }[]>`
      SELECT scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'erp_customer'
        AND identifier = 'CARI-042'
        AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_key).toBe('tenant-a');
  });

  it('stringifies and trims a non-string tenant key', async () => {
    const { org, tenantA } = await seed();
    const sql = getTestDb();

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      connectionId: tenantA.id,
      items: [customerEvent('CARI-043', 'Boolean Tenant', false)],
    });

    const rows = await sql<{ scope_key: string | null }[]>`
      SELECT scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'erp_customer'
        AND identifier = 'CARI-043'
        AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].scope_key).toBe('false');
  });

  it('rejects structured tenant keys instead of collapsing them through String()', async () => {
    const { org, tenantA } = await seed();
    const sql = getTestDb();

    for (const tenantKey of [{ tenant: 'a' }, ['tenant-a']]) {
      await expect(
        applyEventAttributions({
          connectorKey,
          feedKey,
          orgId: org.id,
          connectionId: tenantA.id,
          items: [customerEvent('CARI-044', 'Structured Tenant', tenantKey)],
        })
      ).rejects.toThrow(
        /erp_customer.*metadata\.tenant_id.*string, number, or boolean tenant scope key/i
      );
    }

    const rows = await sql`
      SELECT id
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = 'erp_customer'
        AND identifier = 'CARI-044'
        AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(0);
  });

  it('fails ingestion when a tenant-scoped identity has a missing or empty tenant key', async () => {
    const { org } = await seed();

    await expect(
      applyEventAttributions({
        connectorKey,
        feedKey,
        orgId: org.id,
        items: [customerEvent('CARI-777', 'Missing tenant')],
      })
    ).rejects.toThrow(/erp_customer.*metadata\.tenant_id.*non-empty tenant scope key/i);

    await expect(
      applyEventAttributions({
        connectorKey,
        feedKey,
        orgId: org.id,
        items: [customerEvent('CARI-778', 'Empty tenant', '   ')],
      })
    ).rejects.toThrow(/erp_customer.*metadata\.tenant_id.*non-empty tenant scope key/i);
  });
});
