import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { reconcileConnectorIdentityScopeRegistry } from '../../../utils/connector-identity-scopes';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnectorDefinition,
  createTestEntity,
  createTestOrganization,
} from '../../setup/test-fixtures';

function connectorMetadata(params: {
  key: string;
  scope: 'organization' | 'tenant';
  scopeKeyPath?: string;
}) {
  return {
    key: params.key,
    feeds: {
      customers: {
        eventKinds: {
          customer: {
            attributions: [
              {
                role: 'about',
                target: {
                  identities: [
                    {
                      namespace: 'erp_customer',
                      eventPath: 'metadata.customer_id',
                      scope: params.scope,
                      ...(params.scopeKeyPath ? { scopeKeyPath: params.scopeKeyPath } : {}),
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
}

async function reconcile(
  organizationId: string,
  metadata: ReturnType<typeof connectorMetadata>
): Promise<void> {
  const sql = getTestDb();
  await sql.begin((tx) =>
    reconcileConnectorIdentityScopeRegistry({
      sql: tx as unknown as DbClient,
      organizationId,
      metadata,
    })
  );
}

describe('connector identity scope registry', () => {
  beforeEach(cleanupTestDatabase);

  it('updates a declaration shape when its namespace has no live identities', async () => {
    const org = await createTestOrganization({ name: 'Empty identity namespace org' });
    const key = 'empty-scope-change';
    await reconcile(org.id, connectorMetadata({ key, scope: 'organization' }));
    await reconcile(
      org.id,
      connectorMetadata({ key, scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
    );

    const rows = await getTestDb()<{
      scope: string;
      scope_key_path: string | null;
    }[]>`
      SELECT scope, scope_key_path
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND connector_key = ${key}
    `;
    expect(rows).toEqual([{ scope: 'tenant', scope_key_path: 'metadata.tenant_id' }]);
  });

  it('requires a manual row plus registry migration when live identities exist', async () => {
    const org = await createTestOrganization({ name: 'Manual identity migration org' });
    const key = 'manual-scope-change';
    const sql = getTestDb();
    await reconcile(org.id, connectorMetadata({ key, scope: 'organization' }));
    const first = await createTestEntity({ organization_id: org.id, name: 'First customer' });
    const second = await createTestEntity({ organization_id: org.id, name: 'Second customer' });
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector, scope_key
      ) VALUES
        (${org.id}, ${first.id}, 'erp_customer', 'C-1', 'seed', NULL),
        (${org.id}, ${second.id}, 'erp_customer', 'C-2', 'seed', NULL)
    `;

    const tenantMetadata = connectorMetadata({
      key,
      scope: 'tenant',
      scopeKeyPath: 'metadata.tenant_id',
    });
    await expect(reconcile(org.id, tenantMetadata)).rejects.toThrow(
      /while 2 live identity rows exist.*migrate the identity rows plus connector_identity_scope_registry/i
    );

    // Operator-run migration while ingestion is quiesced. Keep the old claims
    // for append-only event history and add the claims future events will use.
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO entity_identities (
          organization_id, entity_id, namespace, identifier, source_connector, scope_key
        )
        SELECT organization_id, entity_id, namespace, identifier, source_connector, 'tenant-a'
        FROM entity_identities
        WHERE organization_id = ${org.id}
          AND namespace = 'erp_customer'
          AND scope_key IS NULL
          AND deleted_at IS NULL
      `;
      await tx`
        UPDATE connector_identity_scope_registry
        SET scope = 'tenant', scope_key_path = 'metadata.tenant_id', updated_at = now()
        WHERE organization_id = ${org.id}
          AND connector_key = ${key}
          AND namespace = 'erp_customer'
      `;
    });

    await expect(reconcile(org.id, tenantMetadata)).resolves.toBeUndefined();
  });

  it('allows connector-local paths but rejects conflicting scope semantics', async () => {
    const org = await createTestOrganization({ name: 'Shared namespace scope org' });
    await createTestConnectorDefinition({
      key: 'active-peer',
      name: 'Active peer',
      organization_id: org.id,
      feeds_schema: connectorMetadata({
        key: 'active-peer',
        scope: 'tenant',
        scopeKeyPath: 'metadata.account_id',
      }).feeds,
    });

    await expect(
      reconcile(
        org.id,
        connectorMetadata({
          key: 'same-scope-peer',
          scope: 'tenant',
          scopeKeyPath: 'metadata.tenant_id',
        })
      )
    ).resolves.toBeUndefined();
    await expect(
      reconcile(org.id, connectorMetadata({ key: 'conflicting-peer', scope: 'organization' }))
    ).rejects.toThrow(/organization.*active-peer.*tenant/i);
  });
});
