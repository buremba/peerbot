import { beforeEach, describe, expect, it } from 'vitest';
import { IdentityRekeyError, rekeyEntityIdentities } from '../../../identity/rekey';
import {
  IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY,
  IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY,
  SCOPED_IDENTITY_ALIASES_METADATA_KEY,
} from '../../../identity/scope-projection';
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
  resolveSenderIdentity,
} from '../../../utils/entity-link-upsert';
import { createEntity } from '../../../utils/entity-management';
import { insertEvent } from '../../../utils/insert-event';
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
  return { org, user, ids: rows.map((row) => row.id), first, second };
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

  it('allows connectors sharing a tenant namespace to use connector-local scope paths', async () => {
    const org = await createTestOrganization({ name: 'Shared tenant path org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await getTestDb()`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    await install(
      org.id,
      metadata(
        '1.0.0',
        { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' },
        'scope-path-a'
      )
    );
    clearEntityLinkRulesCache();
    await applyEventAttributions({
      connectorKey: 'scope-path-a',
      feedKey: 'customers',
      orgId: org.id,
      items: [
        {
          origin_type: 'customer',
          metadata: {
            customer_id: '1001',
            customer_name: 'Path A customer',
            tenant_id: 'tenant-a',
          },
        },
      ],
    });
    await expect(
      install(
        org.id,
        metadata(
          '1.0.0',
          { scope: 'tenant', scopeKeyPath: 'metadata.account.database_id' },
          'scope-path-b'
        )
      )
    ).resolves.toBeDefined();
    clearEntityLinkRulesCache();
    await expect(
      applyEventAttributions({
        connectorKey: 'scope-path-b',
        feedKey: 'customers',
        orgId: org.id,
        items: [
          {
            origin_type: 'customer',
            metadata: {
              customer_id: '1002',
              customer_name: 'Path B customer',
              account: { database_id: 'tenant-b' },
            },
          },
        ],
      })
    ).resolves.toBeUndefined();

    const rows = await getTestDb()<
      { connector_key: string; scope: string; scope_key_path: string | null }[]
    >`
      SELECT connector_key, scope, scope_key_path
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id} AND namespace = ${namespace}
      ORDER BY connector_key
    `;
    expect(rows).toEqual([
      {
        connector_key: 'scope-path-a',
        scope: 'tenant',
        scope_key_path: 'metadata.tenant_id',
      },
      {
        connector_key: 'scope-path-b',
        scope: 'tenant',
        scope_key_path: 'metadata.account.database_id',
      },
    ]);
    const identities = await getTestDb()<
      { identifier: string; scope_key: string | null }[]
    >`
      SELECT identifier, scope_key
      FROM entity_identities
      WHERE organization_id = ${org.id} AND namespace = ${namespace}
      ORDER BY identifier
    `;
    expect(identities).toEqual([
      { identifier: '1001', scope_key: 'tenant-a' },
      { identifier: '1002', scope_key: 'tenant-b' },
    ]);
  });

  it('strips forged scope projections at the event and entity write funnels', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Projection boundary org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    const forged = {
      [IDENTITY_SCOPE_BY_NAMESPACE_METADATA_KEY]: { [namespace]: 'tenant-forged' },
      [IDENTITY_SCOPE_BY_ALIAS_METADATA_KEY]: { '1001': 'tenant-forged' },
      [SCOPED_IDENTITY_ALIASES_METADATA_KEY]: [
        { namespace, identifier: '1001', scopeKey: 'tenant-forged' },
      ],
      visible: 'kept',
    };

    const event = await insertEvent({
      organizationId: org.id,
      entityIds: [],
      originId: 'forged-scope-projection',
      semanticType: 'content',
      metadata: forged,
    });
    const [eventRow] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM events WHERE id = ${event.id}
    `;
    expect(eventRow?.metadata).toEqual({ visible: 'kept' });

    const entity = await createEntity({
      organization_id: org.id,
      entity_type: 'person',
      name: 'Projection boundary person',
      created_by: user.id,
      metadata: forged,
    });
    const [entityRow] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM entities WHERE id = ${entity.id}
    `;
    expect(entityRow?.metadata).toEqual({ visible: 'kept' });

    const trusted = await insertEvent(
      {
        organizationId: org.id,
        entityIds: [],
        originId: 'trusted-scope-projection',
        semanticType: 'content',
        metadata: forged,
      },
      { trustedIdentityScopeProjections: true }
    );
    const [trustedRow] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM events WHERE id = ${trusted.id}
    `;
    expect(trustedRow?.metadata).toEqual(forged);
  });

  it('takes entity locks before the identity table during re-key', async () => {
    const { org, ids, first } = await seedRows();
    const [firstIdentityId, secondIdentityId] = ids;
    if (!firstIdentityId || !secondIdentityId) throw new Error('Expected two identities');
    await expect(
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      )
    ).rejects.toThrow(/live identity rows/i);

    const sql = getTestDb();
    let releaseEntityLock!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseEntityLock = resolve;
    });
    let entityLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      entityLocked = resolve;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM entities WHERE id = ${first.id} FOR UPDATE`;
      entityLocked();
      await release;
    });
    await locked;

    const rekey = rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping: { [firstIdentityId]: 'tenant-a', [secondIdentityId]: 'tenant-b' },
      apply: true,
    });
    try {
      let rekeyHoldsAdvisoryLock = false;
      for (let attempt = 0; attempt < 100 && !rekeyHoldsAdvisoryLock; attempt++) {
        rekeyHoldsAdvisoryLock = await sql.begin(async (tx) => {
          const [row] = await tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(
              hashtext('lobu:identity-rekey'),
              hashtext(${`${org.id}:${namespace}`})
            ) AS acquired
          `;
          return row?.acquired === false;
        });
        if (!rekeyHoldsAdvisoryLock) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(rekeyHoldsAdvisoryLock).toBe(true);

      // The re-key is waiting on the entity row and therefore must not yet own
      // the conflicting identity-table lock. The old inverted order fails this
      // NOWAIT probe and can deadlock with merge/unmerge.
      await expect(
        sql.begin(async (tx) => {
          await tx`LOCK TABLE entity_identities IN ROW EXCLUSIVE MODE NOWAIT`;
        })
      ).resolves.toBeUndefined();
    } finally {
      releaseEntityLock();
      await blocker;
    }
    await expect(rekey).resolves.toMatchObject({ applied: true });
  });

  it('does not hold the global identity-table lock while refreshing metric projections', async () => {
    const { org, user, ids, first, second } = await seedRows();
    const [firstIdentityId, secondIdentityId] = ids;
    if (!firstIdentityId || !secondIdentityId) throw new Error('Expected two identities');
    await expect(
      install(
        org.id,
        metadata('2.0.0', { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' })
      )
    ).rejects.toThrow(/live identity rows/i);

    const sql = getTestDb();
    const otherOrg = await createTestOrganization({ name: 'Unrelated identity writer org' });
    const otherUser = await createTestUser();
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${otherOrg.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    const otherEntity = await createTestEntity({
      name: 'Unrelated person',
      entity_type: 'person',
      organization_id: otherOrg.id,
      created_by: otherUser.id,
    });
    const movedOwner = await createTestEntity({
      name: 'Moved identity owner',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    await sql`
      INSERT INTO entity_identities (
        organization_id, entity_id, namespace, identifier, source_connector
      ) VALUES (
        ${org.id}, ${first.id}, 'unrelated_namespace', 'moving-identity', 'test'
      )
    `;

    await sql.unsafe('DROP TRIGGER IF EXISTS identity_rekey_metric_refresh_probe ON entities');
    await sql.unsafe('DROP FUNCTION IF EXISTS identity_rekey_metric_refresh_probe()');
    await sql.unsafe(`
      CREATE FUNCTION identity_rekey_metric_refresh_probe() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('lobu:test:rekey-refresh'), 1);
        RETURN NEW;
      END;
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER identity_rekey_metric_refresh_probe
      BEFORE UPDATE ON entities
      FOR EACH ROW EXECUTE FUNCTION identity_rekey_metric_refresh_probe()
    `);

    let releaseProbe!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      probeHeld = resolve;
    });
    const blocker = sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(hashtext('lobu:test:rekey-refresh'), 1)
      `;
      probeHeld();
      await release;
    });
    await held;

    const rekey = rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping: { [firstIdentityId]: 'tenant-a', [secondIdentityId]: 'tenant-b' },
      apply: true,
    });
    try {
      let refreshWaiting = false;
      for (let attempt = 0; attempt < 200 && !refreshWaiting; attempt++) {
        const [row] = await sql<{ waiting: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND granted = false
          ) AS waiting
        `;
        refreshWaiting = row?.waiting === true;
        if (!refreshWaiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(refreshWaiting).toBe(true);

      // The target re-key is paused inside its per-entity metadata refresh.
      // An unrelated organization must still be able to take ROW EXCLUSIVE and
      // insert an identity. The old ordering held SHARE ROW EXCLUSIVE already
      // and this statement timed out.
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
          await tx`
            INSERT INTO entity_identities (
              organization_id, entity_id, namespace, identifier, source_connector
            ) VALUES (
              ${otherOrg.id}, ${otherEntity.id}, 'unrelated_namespace',
              'unrelated-identity', 'test'
            )
          `;
        })
      ).resolves.toBeUndefined();

      // A direct identity writer (for example Slack sign-in adoption) takes a
      // ROW EXCLUSIVE table lock and then its tuple without first locking the
      // entity. The proposed re-key snapshot must not retain that tuple lock
      // while projection refresh is paused, or the later re-key table lock and
      // this writer form a PostgreSQL deadlock cycle.
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL statement_timeout = '750ms'`);
          await tx`
            UPDATE entity_identities
            SET source_connector = 'test:direct-writer'
            WHERE id = ${firstIdentityId}::bigint
          `;
          await tx`
            UPDATE entity_identities
            SET entity_id = ${movedOwner.id}, source_connector = 'test:direct-writer'
            WHERE organization_id = ${org.id}
              AND namespace = 'unrelated_namespace'
              AND identifier = 'moving-identity'
              AND deleted_at IS NULL
          `;
        })
      ).resolves.toBeUndefined();
    } finally {
      releaseProbe();
      await blocker;
      await Promise.allSettled([rekey]);
      await sql.unsafe('DROP TRIGGER IF EXISTS identity_rekey_metric_refresh_probe ON entities');
      await sql.unsafe('DROP FUNCTION IF EXISTS identity_rekey_metric_refresh_probe()');
    }
    await expect(rekey).resolves.toMatchObject({ applied: true });
    const projected = await sql<{
      id: number | string;
      metadata: {
        aliases?: string[];
        [SCOPED_IDENTITY_ALIASES_METADATA_KEY]?: Array<{
          namespace: string;
          identifier: string;
          scopeKey: string;
        }>;
      };
    }[]>`
      SELECT id, metadata FROM entities
      WHERE id IN (${first.id}, ${second.id}, ${movedOwner.id})
      ORDER BY id
    `;
    const firstProjection = projected.find((row) => Number(row.id) === first.id)?.metadata;
    const secondProjection = projected.find((row) => Number(row.id) === second.id)?.metadata;
    const movedProjection = projected.find(
      (row) => Number(row.id) === movedOwner.id
    )?.metadata;
    expect(firstProjection?.aliases).toEqual([]);
    expect(
      firstProjection?.[SCOPED_IDENTITY_ALIASES_METADATA_KEY]?.map(
        (projection) => projection.identifier
      ).sort()
    ).toEqual(['1001', '1001']);
    expect(secondProjection?.aliases).toEqual([]);
    expect(
      secondProjection?.[SCOPED_IDENTITY_ALIASES_METADATA_KEY]?.map(
        (projection) => projection.identifier
      ).sort()
    ).toEqual(['1002', '1002']);
    expect(movedProjection?.aliases).toEqual(['moving-identity']);
    expect(movedProjection?.[SCOPED_IDENTITY_ALIASES_METADATA_KEY]).toEqual([
      { namespace: 'unrelated_namespace', identifier: 'moving-identity', scopeKey: '' },
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

    // Hand-built identities outside connector attribution may still present
    // the organization scope by omitting scopeKey. The retained organization
    // sentinel must resolve to its original owner rather than minting a second
    // identity after the connector has moved to tenant scope.
    const organizationHistoryOwner = await resolveSenderIdentity(sql, {
      orgId: org.id,
      connectorKey: 'scope-history-probe',
      mintEntityType: 'person',
      identities: [
        {
          namespace,
          identifier: '1001',
          matchOnly: false,
          primary: true,
        },
      ],
    });
    expect(organizationHistoryOwner).toBe(first.id);
    const organizationClaimRows = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = '1001'
        AND deleted_at IS NULL
    `;
    expect(organizationClaimRows).toEqual([{ count: 1 }]);

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
    // Do not clear the local attribution cache. The failed activation-gap
    // attempt above deliberately cached the old organization-scoped rule; the
    // active definition revision must make every replica load the newly
    // activated tenant rule immediately instead of waiting for the TTL.
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

  it('lets a new connector take over an archived registry owner through re-key', async () => {
    const { org, ids } = await seedRows();
    const sql = getTestDb();
    const takeoverConnectorKey = 'scope-lifecycle-takeover';
    await sql`
      UPDATE connector_definitions
      SET status = 'archived', updated_at = now()
      WHERE organization_id = ${org.id}
        AND key = ${connectorKey}
        AND status = 'active'
    `;

    const next = metadata(
      '2.0.0',
      { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' },
      takeoverConnectorKey
    );
    await expect(install(org.id, next)).rejects.toThrow(/2 live identity rows/i);
    const staged = await sql<
      { connector_key: string; scope: string; pending_scope: string | null }[]
    >`
      SELECT connector_key, scope, pending_scope
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
      ORDER BY connector_key
    `;
    expect(staged).toEqual([
      {
        connector_key: connectorKey,
        scope: 'organization',
        pending_scope: 'tenant',
      },
      {
        connector_key: takeoverConnectorKey,
        scope: 'organization',
        pending_scope: 'tenant',
      },
    ]);

    const mapping = { [ids[0]!]: 'tenant-a', [ids[1]!]: 'tenant-b' };
    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping,
        apply: true,
      })
    ).resolves.toMatchObject({ applied: true });
    await expect(install(org.id, next)).resolves.toBeDefined();

    const promoted = await sql<
      { connector_key: string; scope: string; pending_scope: string | null }[]
    >`
      SELECT connector_key, scope, pending_scope
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
      ORDER BY connector_key
    `;
    expect(promoted).toEqual([
      { connector_key: connectorKey, scope: 'tenant', pending_scope: null },
      { connector_key: takeoverConnectorKey, scope: 'tenant', pending_scope: null },
    ]);
    const definitions = await sql<{ key: string; status: string }[]>`
      SELECT key, status
      FROM connector_definitions
      WHERE organization_id = ${org.id}
        AND key IN (${connectorKey}, ${takeoverConnectorKey})
      ORDER BY key
    `;
    expect(definitions).toEqual([
      { key: connectorKey, status: 'archived' },
      { key: takeoverConnectorKey, status: 'active' },
    ]);
  });

  it('requires re-key when archived pre-registry identities get a tenant owner', async () => {
    const { org, ids } = await seedRows();
    const sql = getTestDb();
    const takeoverConnectorKey = 'scope-lifecycle-pre-registry-takeover';
    await sql`
      UPDATE connector_definitions
      SET status = 'archived', updated_at = now()
      WHERE organization_id = ${org.id}
        AND key = ${connectorKey}
        AND status = 'active'
    `;
    await sql`
      DELETE FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
    `;

    const next = metadata(
      '2.0.0',
      { scope: 'tenant', scopeKeyPath: 'metadata.tenant_id' },
      takeoverConnectorKey
    );
    await expect(install(org.id, next)).rejects.toThrow(
      /2 live identity rows.*Old shape.*organization.*New shape.*tenant.*lobu identities rekey/i
    );
    const staged = await sql<
      { connector_key: string; scope: string; pending_scope: string | null }[]
    >`
      SELECT connector_key, scope, pending_scope
      FROM connector_identity_scope_registry
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
    `;
    expect(staged).toEqual([
      {
        connector_key: takeoverConnectorKey,
        scope: 'organization',
        pending_scope: 'tenant',
      },
    ]);

    const mapping = { [ids[0]!]: 'tenant-a', [ids[1]!]: 'tenant-b' };
    await expect(
      rekeyEntityIdentities({
        organizationId: org.id,
        namespace,
        mapping,
        apply: true,
      })
    ).resolves.toMatchObject({ applied: true });
    await expect(install(org.id, next)).resolves.toBeDefined();
  });

  it('keeps a retained tenant key exclusive and resolves it to the original entity', async () => {
    const sql = getTestDb();
    const org = await createTestOrganization({ name: 'Retained tenant claim org' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${org.id}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
    const firstShape = { scope: 'tenant' as const, scopeKeyPath: 'metadata.tenant_id' };
    await install(org.id, metadata('1.0.0', firstShape));
    clearEntityLinkRulesCache();
    await applyEventAttributions({
      connectorKey,
      feedKey: 'customers',
      orgId: org.id,
      items: [
        {
          origin_type: 'customer',
          metadata: {
            customer_id: '1001',
            customer_name: 'Original tenant customer',
            tenant_id: 'tenant-a',
          },
        },
      ],
    });
    const [original] = await sql<{ id: string; entity_id: number | string }[]>`
      SELECT id::text AS id, entity_id
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = '1001'
        AND deleted_at IS NULL
    `;
    if (!original) throw new Error('Initial tenant identity was not created');

    const next = metadata('2.0.0', {
      scope: 'tenant',
      scopeKeyPath: 'metadata.account_id',
    });
    await expect(install(org.id, next)).rejects.toThrow(/1 live identity row/i);
    await rekeyEntityIdentities({
      organizationId: org.id,
      namespace,
      mapping: { [original.id]: 'tenant-b' },
      apply: true,
    });
    await install(org.id, next);

    clearEntityLinkRulesCache();
    await applyEventAttributions({
      connectorKey,
      feedKey: 'customers',
      orgId: org.id,
      items: [
        {
          origin_type: 'customer',
          metadata: {
            customer_id: '1001',
            customer_name: 'Same customer through retained key',
            account_id: 'tenant-a',
          },
        },
      ],
    });
    const rows = await sql<
      { id: string; entity_id: number | string; scope_key: string | null; history: string[] }[]
    >`
      SELECT id::text AS id, entity_id, scope_key,
             to_json(scope_key_history) AS history
      FROM entity_identities
      WHERE organization_id = ${org.id}
        AND namespace = ${namespace}
        AND identifier = '1001'
        AND deleted_at IS NULL
      ORDER BY id
    `;
    expect(rows).toEqual([
      {
        id: original.id,
        entity_id: original.entity_id,
        scope_key: 'tenant-b',
        history: ['tenant-a'],
      },
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
    ).rejects.toThrow(/scope-shared-first.*organization.*same organization\/tenant scope/i);

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
