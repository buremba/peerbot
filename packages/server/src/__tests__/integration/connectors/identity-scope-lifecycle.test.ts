import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityRekeyError, rekeyEntityIdentities } from '../../../identity/rekey';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'scope-lifecycle-erp';
const namespace = 'erp_customer';

function metadata(
  version: string,
  shape: { scope?: 'organization' | 'tenant'; scopeKeyPath?: string },
  key = connectorKey
): ConnectorMetadata {
  return {
    key,
    name: 'Scope lifecycle ERP',
    version,
    authSchema: null,
    webhook: null,
    actions: null,
    automationEvents: null,
    optionsSchema: null,
    feeds: {
      customers: {
        operations: ['sync'],
        eventKinds: {
          customer: {
            attributions: [
              {
                role: 'about',
                autoCreate: true,
                target: {
                  entityType: 'person',
                  titlePath: 'metadata.customer_name',
                  identities: [
                    {
                      namespace,
                      eventPath: 'metadata.customer_id',
                      ...shape,
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

async function install(orgId: string, connectorMetadata: ConnectorMetadata) {
  return upsertConnectorDefinitionRecords({
    sql: getTestDb(),
    organizationId: orgId,
    metadata: connectorMetadata,
    versionRecord: {
      compiledCode: null,
      compiledCodeHash: null,
      compileConfigHash: null,
      sourceCode: null,
      sourcePath: null,
    },
    versionScope: 'organization',
  });
}

async function seedRows(options?: { duplicateIdentifier?: boolean }) {
  const sql = getTestDb();
  const org = await createTestOrganization({ name: 'Scope lifecycle org' });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await sql`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
  `;
  const first = await createTestEntity({
    name: 'First customer',
    entity_type: '$member',
    organization_id: org.id,
  });
  const second = await createTestEntity({
    name: 'Second customer',
    entity_type: '$member',
    organization_id: org.id,
  });
  await install(org.id, metadata('1.0.0', {}));
  const identifiers = options?.duplicateIdentifier ? ['CARI-001', 'CARI-001'] : ['CARI-001', 'CARI-002'];
  const scopes = options?.duplicateIdentifier ? ['legacy-a', 'legacy-b'] : [null, null];
  const rows = await sql<{ id: string }[]>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    ) VALUES
      (${org.id}, ${first.id}, ${namespace}, ${identifiers[0]}, ${`connector:${connectorKey}`}, ${scopes[0]}),
      (${org.id}, ${second.id}, ${namespace}, ${identifiers[1]}, ${`connector:${connectorKey}`}, ${scopes[1]})
    RETURNING id::text AS id
  `;
  return { org, ids: rows.map((row) => row.id) };
}

describe('connector identity scope lifecycle', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('updates the registered shape when a namespace has zero live identities', async () => {
    const org = await createTestOrganization({ name: 'Empty scope org' });
    await install(org.id, metadata('1.0.0', {}));
    await expect(
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      )
    ).resolves.toBeDefined();

    const rows = await getTestDb()<
      { scope: string; scope_key_path: string | null; shape_version: number }[]
    >`
      SELECT scope, scope_key_path, shape_version::integer AS shape_version
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND connector_key = ${connectorKey}
    `;
    expect(rows).toEqual([
      { scope: 'tenant', scope_key_path: 'metadata.tenant_id', shape_version: 2 },
    ]);
  });

  it('blocks a live shape change, re-keys atomically, and lets the next apply succeed', async () => {
    const { org, ids } = await seedRows();
    const next = metadata('2.0.0', {
      scope: 'tenant',
      scopeKeyPath: 'metadata.tenant_id',
    });
    await expect(install(org.id, next)).rejects.toThrow(
      /erp_customer.*2 live identity rows.*Old shape.*organization.*New shape.*tenant.*lobu identities rekey/i
    );

    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping: { [ids[0]!]: 'tenant-a' },
      })
    ).rejects.toThrow(/incomplete.*missing live identity ids/i);

    const mapping = { [ids[0]!]: 'tenant-a', [ids[1]!]: 'tenant-b' };
    const dryRun = await rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping,
    });
    expect(dryRun).toMatchObject({
      targetScope: 'tenant',
      targetScopeKeyPath: 'metadata.tenant_id',
      liveIdentityCount: 2,
      applied: false,
    });
    const applied = await rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping,
      apply: true,
    });
    expect(applied.applied).toBe(true);

    const rows = await getTestDb()<
      { scope_key: string | null; scope: string; pending_scope: string | null }[]
    >`
      SELECT identity.scope_key, registry.scope, registry.pending_scope
      FROM entity_identities identity
      CROSS JOIN connector_identity_scope_registry registry
      WHERE identity.organization_id = ${org.id}
        AND identity.namespace = ${namespace}
        AND identity.deleted_at IS NULL
        AND registry.organization_id = ${org.id}
        AND registry.connector_key = ${connectorKey}
        AND registry.namespace = ${namespace}
      ORDER BY identity.id
    `;
    expect(rows).toEqual([
      { scope_key: 'tenant-a', scope: 'tenant', pending_scope: null },
      { scope_key: 'tenant-b', scope: 'tenant', pending_scope: null },
    ]);

    clearEntityLinkRulesCache();
    await expect(
      applyEventAttributions({
        connectorKey,
        feedKey: 'customers',
        orgId: org.id,
        items: [
          {
            origin_type: 'customer',
            metadata: {
              customer_id: 'CARI-003',
              customer_name: 'Blocked during activation gap',
              tenant_id: 'tenant-c',
            },
          },
        ],
      })
    ).rejects.toThrow(/erp_customer.*ingestion is paused.*lobu apply/i);

    const blockedRows = await getTestDb()<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = 'CARI-003'
        AND deleted_at IS NULL
    `;
    expect(blockedRows[0]?.count).toBe(0);

    await expect(install(org.id, next)).resolves.toBeDefined();
    clearEntityLinkRulesCache();
    await expect(
      applyEventAttributions({
        connectorKey,
        feedKey: 'customers',
        orgId: org.id,
        items: [
          {
            origin_type: 'customer',
            metadata: {
              customer_id: 'CARI-003',
              customer_name: 'Allowed after apply',
              tenant_id: 'tenant-c',
            },
          },
        ],
      })
    ).resolves.toBeUndefined();

    const activatedRows = await getTestDb()<{ scope_key: string | null }[]>`
      SELECT scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = 'CARI-003'
        AND deleted_at IS NULL
    `;
    expect(activatedRows).toEqual([{ scope_key: 'tenant-c' }]);
  });

  it('recovers an empty upgrade registry from the active definition before changing shape', async () => {
    const { org } = await seedRows();
    const sql = getTestDb();
    await sql`
      DELETE FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND connector_key = ${connectorKey}
        AND namespace = ${namespace}
    `;

    await expect(
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      )
    ).rejects.toThrow(/erp_customer.*2 live identity rows.*Old shape.*organization.*New shape.*tenant/i);

    const rows = await sql<
      { scope: string; scope_key_path: string | null; pending_scope: string | null }[]
    >`
      SELECT scope, scope_key_path, pending_scope
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND connector_key = ${connectorKey}
        AND namespace = ${namespace}
    `;
    expect(rows).toEqual([
      { scope: 'organization', scope_key_path: null, pending_scope: 'tenant' },
    ]);
  });

  it('requires every connector sharing a namespace to converge before re-key', async () => {
    const { org, ids } = await seedRows();
    const secondConnectorKey = 'scope-lifecycle-secondary';
    await install(org.id, metadata('1.0.0', {}, secondConnectorKey));
    const target = { scope: 'tenant' as const, scopeKeyPath: 'metadata.tenant_id' };

    await expect(install(org.id, metadata('2.0.0', target))).rejects.toThrow(
      /2 live identity rows/i
    );
    const mapping = { [ids[0]!]: 'tenant-a', [ids[1]!]: 'tenant-b' };
    await expect(
      rekeyEntityIdentities({ organizationId: org.id, namespace, mapping })
    ).rejects.toThrow(/scope-lifecycle-secondary.*every connector sharing the namespace/i);

    await expect(
      install(org.id, metadata('2.0.0', target, secondConnectorKey))
    ).rejects.toThrow(/2 live identity rows/i);
    const dryRun = await rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping,
    });
    expect(dryRun.connectorKeys).toEqual([connectorKey, secondConnectorKey]);
    expect(dryRun.targetScope).toBe('tenant');

    const applied = await rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping,
      apply: true,
    });
    expect(applied.applied).toBe(true);
    const registryRows = await getTestDb()<
      { connector_key: string; scope: string; pending_scope: string | null }[]
    >`
      SELECT connector_key, scope, pending_scope
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND namespace = ${namespace}
      ORDER BY connector_key
    `;
    expect(registryRows).toEqual([
      { connector_key: connectorKey, scope: 'tenant', pending_scope: null },
      { connector_key: secondConnectorKey, scope: 'tenant', pending_scope: null },
    ]);
  });

  it('rejects ids outside the org+namespace and proposed unique-key collisions', async () => {
    const { org, ids } = await seedRows({ duplicateIdentifier: true });
    await expect(
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      )
    ).rejects.toThrow(/2 live identity rows/i);

    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping: { [ids[0]!]: 'tenant-a', [ids[1]!]: 'tenant-b', '999999999': 'tenant-c' },
      })
    ).rejects.toBeInstanceOf(IdentityRekeyError);

    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping: { [ids[0]!]: 'same-tenant', [ids[1]!]: 'same-tenant' },
      })
    ).rejects.toThrow(/collision.*CARI-001.*same-tenant.*identity ids/i);
  });
});
