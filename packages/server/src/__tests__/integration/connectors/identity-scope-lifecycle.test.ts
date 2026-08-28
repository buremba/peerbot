import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityRekeyError, rekeyEntityIdentities } from '../../../identity/rekey';
import { runMetric } from '../../../metrics/run-metric';
import type { ConnectorMetadata } from '../../../utils/connector-compiler';
import { upsertConnectorDefinitionRecords } from '../../../utils/connector-definition-install';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  fetchEntityIdentityScopes,
} from '../../../utils/content-search/entity-link';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'scope-lifecycle-erp';
// Use a recall-indexed namespace so the lifecycle test proves both indexed
// content recall and metric attribution survive an explicit scope re-key.
const namespace = 'x_user_id';

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

type InstallSql = Parameters<typeof upsertConnectorDefinitionRecords>[0]['sql'];

async function install(
  orgId: string,
  connectorMetadata: ConnectorMetadata,
  sql: InstallSql = getTestDb()
) {
  return upsertConnectorDefinitionRecords({
    sql,
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
    entity_type: 'person',
    organization_id: org.id,
    created_by: user.id,
  });
  const second = await createTestEntity({
    name: 'Second customer',
    entity_type: 'person',
    organization_id: org.id,
    created_by: user.id,
  });
  await install(org.id, metadata('1.0.0', {}));
  const identifiers = options?.duplicateIdentifier ? ['1001', '1001'] : ['1001', '1002'];
  const scopes = options?.duplicateIdentifier ? ['legacy-a', 'legacy-b'] : [null, null];
  const rows = await sql<{ id: string }[]>`
    INSERT INTO entity_identities (
      organization_id, entity_id, namespace, identifier, source_connector, scope_key
    ) VALUES
      (${org.id}, ${first.id}, ${namespace}, ${identifiers[0]}, ${`connector:${connectorKey}`}, ${scopes[0]}),
      (${org.id}, ${second.id}, ${namespace}, ${identifiers[1]}, ${`connector:${connectorKey}`}, ${scopes[1]})
    RETURNING id::text AS id
  `;
  await sql`
    UPDATE entities
    SET metadata = jsonb_build_object(
      'aliases',
      jsonb_build_array(
        CASE id
          WHEN ${first.id} THEN ${identifiers[0]}
          WHEN ${second.id} THEN ${identifiers[1]}
        END
      )
    )
    WHERE id IN (${first.id}, ${second.id})
  `;
  return { org, ids: rows.map((row) => row.id), first, second };
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
    const { org, ids, first } = await seedRows();
    const sql = getTestDb();
    await sql`
      UPDATE entity_types
      SET metrics_config = ${sql.json({
        eventSets: {
          observations: { by: 'alias', field: `metadata->>'${namespace}'` },
        },
        measures: {
          observations: { eventSet: 'observations', agg: 'count' },
        },
      })}
      WHERE organization_id = ${org.id} AND slug = 'person'
    `;
    const historicalEvent = await createTestEvent({
      organization_id: org.id,
      content: 'Observed before tenant scope existed',
      connector_key: connectorKey,
      metadata: { [namespace]: '1001' },
    });
    const next = metadata('2.0.0', {
      scope: 'tenant',
      scopeKeyPath: 'metadata.tenant_id',
    });
    await expect(install(org.id, next)).rejects.toThrow(
      /x_user_id.*2 live identity rows.*Old shape.*organization.*New shape.*tenant.*lobu identities rekey/i
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
    const metricAliases = await getTestDb()<
      { aliases: unknown; scoped_aliases: unknown }[]
    >`
      SELECT metadata->'aliases' AS aliases,
             metadata->'__lobu_scoped_identity_aliases' AS scoped_aliases
      FROM entities
      WHERE organization_id = ${org.id}
        AND id IN (
          SELECT entity_id
          FROM entity_identities
          WHERE organization_id = ${org.id}
            AND namespace = ${namespace}
            AND deleted_at IS NULL
        )
      ORDER BY id
    `;
    expect(metricAliases).toEqual([
      {
        aliases: [],
        scoped_aliases: [
          { namespace, identifier: '1001', scopeKey: '' },
          { namespace, identifier: '1001', scopeKey: 'tenant-a' },
        ],
      },
      {
        aliases: [],
        scoped_aliases: [
          { namespace, identifier: '1002', scopeKey: '' },
          { namespace, identifier: '1002', scopeKey: 'tenant-b' },
        ],
      },
    ]);

    const historicalScopes = await fetchEntityIdentityScopes(sql, first.id);
    expect(historicalScopes).toEqual(
      expect.arrayContaining([
        { namespace, identifier: '1001', scopeKey: null },
        { namespace, identifier: '1001', scopeKey: 'tenant-a' },
      ])
    );
    const historicalLink = buildEntityLinkUnion({
      entityIdLiteral: first.id,
      scopes: historicalScopes,
      alias: 'event',
      baseParamIndex: 1,
    });
    const recalled = await sql.unsafe(
      `SELECT event.id FROM events event WHERE ${historicalLink.sql}`,
      historicalLink.params
    );
    expect(recalled.map((row) => Number(row.id))).toContain(historicalEvent.id);
    const staticallyRecalled = await sql.unsafe(
      `SELECT event.id FROM events event WHERE ${entityLinkMatchSql(`${first.id}::bigint`, 'event')}`
    );
    expect(staticallyRecalled.map((row) => Number(row.id))).toContain(historicalEvent.id);
    const preservedMetrics = await runMetric({
      organizationId: org.id,
      entityType: 'person',
      entityId: first.id,
      measure: 'observations',
    });
    expect(preservedMetrics).toHaveLength(1);
    expect(Number(preservedMetrics[0]?.entity_id)).toBe(first.id);
    expect(Number(preservedMetrics[0]?.observations)).toBe(1);

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
              customer_id: '1003',
              customer_name: 'Blocked during activation gap',
              tenant_id: 'tenant-c',
            },
          },
        ],
      })
    ).rejects.toThrow(/x_user_id.*ingestion is paused.*lobu apply/i);

    const blockedRows = await getTestDb()<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = '1003'
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
              customer_id: '1003',
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
        AND identifier = '1003'
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
    ).rejects.toThrow(/x_user_id.*2 live identity rows.*Old shape.*organization.*New shape.*tenant/i);

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

  it('backfills pre-registry peer connectors and rejects a conflicting new connector', async () => {
    const org = await createTestOrganization({ name: 'Shared namespace registry org' });
    const firstConnector = 'scope-shared-first';
    const secondConnector = 'scope-shared-second';
    const conflictingConnector = 'scope-shared-conflict';
    await install(org.id, metadata('1.0.0', {}, firstConnector));
    await install(org.id, metadata('1.0.0', {}, secondConnector));
    await getTestDb()`
      DELETE FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND namespace = ${namespace}
    `;

    await expect(
      install(
        org.id,
        metadata(
          '1.0.0',
          { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' },
          conflictingConnector
        )
      )
    ).rejects.toThrow(/scope-shared-first.*organization.*same scope shape/i);

    const rows = await getTestDb()<
      { connector_key: string; scope: string; scope_key_path: string | null }[]
    >`
      SELECT connector_key, scope, scope_key_path
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND namespace = ${namespace}
      ORDER BY connector_key
    `;
    expect(rows).toEqual([
      { connector_key: firstConnector, scope: 'organization', scope_key_path: null },
      { connector_key: secondConnector, scope: 'organization', scope_key_path: null },
    ]);
    const conflictingDefinitions = await getTestDb()<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key = ${conflictingConnector}
        AND status = 'active'
    `;
    expect(conflictingDefinitions[0]?.count).toBe(0);
  });

  it('rolls registry reconciliation back when the enclosing definition install rolls back', async () => {
    const org = await createTestOrganization({ name: 'Scope rollback org' });
    await install(org.id, metadata('1.0.0', {}));
    const sql = getTestDb();
    await expect(
      sql.begin(async (tx) => {
        await install(
          org.id,
          metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' }),
          tx
        );
        throw new Error('definition rollback probe');
      })
    ).rejects.toThrow(/definition rollback probe/i);

    const rows = await sql<
      { registry_scope: string; active_scope: string | null; version: string }[]
    >`
      SELECT registry.scope AS registry_scope,
             definition.feeds_schema #>>
               '{customers,eventKinds,customer,attributions,0,target,identities,0,scope}'
               AS active_scope,
             definition.version
      FROM connector_identity_scope_registry registry
      JOIN connector_definitions definition
        ON definition.organization_id = registry.organization_id
       AND definition.key = registry.connector_key
       AND definition.status = 'active'
      WHERE registry.organization_id = ${org.id}
        AND registry.connector_key = ${connectorKey}
        AND registry.namespace = ${namespace}
    `;
    expect(rows).toEqual([
      { registry_scope: 'organization', active_scope: null, version: '1.0.0' },
    ]);
  });

  it('commits a blocked pending target through a caller-owned transaction', async () => {
    const { org } = await seedRows();
    const sql = getTestDb();
    const result = await sql.begin((tx) =>
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' }),
        tx
      )
    );
    expect(result.blockedMessage).toMatch(/2 live identity rows.*lobu identities rekey/i);

    const rows = await sql<
      { scope: string; pending_scope: string | null; active_version: string }[]
    >`
      SELECT registry.scope,
             registry.pending_scope,
             definition.version AS active_version
      FROM connector_identity_scope_registry registry
      JOIN connector_definitions definition
        ON definition.organization_id = registry.organization_id
       AND definition.key = registry.connector_key
       AND definition.status = 'active'
      WHERE registry.organization_id = ${org.id}
        AND registry.connector_key = ${connectorKey}
        AND registry.namespace = ${namespace}
    `;
    expect(rows).toEqual([
      { scope: 'organization', pending_scope: 'tenant', active_version: '1.0.0' },
    ]);
  });

  it('keeps registry and active definition aligned across concurrent installs', async () => {
    const org = await createTestOrganization({ name: 'Concurrent scope install org' });
    await install(org.id, metadata('1.0.0', {}));
    await Promise.all([
      install(org.id, metadata('2.0.0', {})),
      install(
        org.id,
        metadata('3.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      ),
    ]);

    const rows = await getTestDb()<
      { registry_scope: string; active_scope: string | null }[]
    >`
      SELECT registry.scope AS registry_scope,
             definition.feeds_schema #>>
               '{customers,eventKinds,customer,attributions,0,target,identities,0,scope}'
               AS active_scope
      FROM connector_identity_scope_registry registry
      JOIN connector_definitions definition
        ON definition.organization_id = registry.organization_id
       AND definition.key = registry.connector_key
       AND definition.status = 'active'
      WHERE registry.organization_id = ${org.id}
        AND registry.connector_key = ${connectorKey}
        AND registry.namespace = ${namespace}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.registry_scope).toBe(rows[0]?.active_scope ?? 'organization');
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
    ).rejects.toThrow(/collision.*1001.*same-tenant.*identity ids/i);

    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping: { [ids[0]!]: 'legacy-b', [ids[1]!]: 'legacy-a' },
      })
    ).rejects.toThrow(/collision.*1001.*retained historical scope/i);
  });
});
