import { randomUUID } from 'node:crypto';
import { validateEntityRowPatch } from '../authz/entity-row-validation';
import { type DbClient, getDb, pgBigintArray, pgTextArray } from '../db/client';
import {
  SCOPED_IDENTITY_ALIASES_METADATA_KEY,
  scopedIdentityAliasProjectionKey,
  type ScopedIdentityAliasProjection,
} from './scope-projection';
import { patchEntityRows } from '../utils/entity-management';

export class IdentityRekeyError extends Error {}

class IdentityRekeyLockRetry extends Error {}

const MAX_LOCK_ORDER_RETRIES = 3;

type RekeyTarget = {
  scope: 'organization' | 'tenant';
  scopeKeyPath: string | null;
  connectorKeys: string[];
};

type LiveIdentity = {
  id: string;
  identifier: string;
  scope_key: string | null;
  scope_key_history: string[];
};

export type IdentityRekeyReport = {
  namespace: string;
  targetScope: 'organization' | 'tenant';
  targetScopeKeyPath: string | null;
  connectorKeys: string[];
  liveIdentityCount: number;
  changes: Array<{
    id: string;
    identifier: string;
    fromScopeKey: string | null;
    toScopeKey: string | null;
  }>;
  applied: boolean;
};

function normalizeMapping(mapping: unknown): Map<string, string | null> {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new IdentityRekeyError('Mapping must be a JSON object keyed by entity_identity_id.');
  }
  const normalized = new Map<string, string | null>();
  for (const [id, rawValue] of Object.entries(mapping as Record<string, unknown>)) {
    if (!/^[1-9][0-9]*$/.test(id)) {
      throw new IdentityRekeyError(`Mapping key '${id}' is not a valid entity_identity_id.`);
    }
    if (rawValue === null) {
      normalized.set(id, null);
      continue;
    }
    if (typeof rawValue !== 'string') {
      throw new IdentityRekeyError(`Mapping value for identity ${id} must be a string or null.`);
    }
    const value = rawValue.trim();
    if (!value || value.includes('\u0000')) {
      throw new IdentityRekeyError(`Mapping value for identity ${id} must be a non-empty tenant key.`);
    }
    normalized.set(id, value);
  }
  return normalized;
}

async function loadTarget(
  db: DbClient,
  organizationId: string,
  namespace: string,
  forUpdate: boolean
): Promise<RekeyTarget> {
  const lock = forUpdate ? db`FOR UPDATE` : db``;
  const rows = await db<{
    connector_key: string;
    scope: 'organization' | 'tenant';
    scope_key_path: string | null;
    pending_scope: 'organization' | 'tenant' | null;
    pending_scope_key_path: string | null;
  }>`
    SELECT connector_key, scope, scope_key_path, pending_scope, pending_scope_key_path
    FROM connector_identity_scope_registry
    WHERE organization_id = ${organizationId}
      AND namespace = ${namespace}
    ORDER BY connector_key
    ${lock}
  `;
  const pending = rows.filter(
    (row): row is typeof row & { pending_scope: 'organization' | 'tenant' } =>
      row.pending_scope !== null
  );
  if (pending.length === 0) {
    throw new IdentityRekeyError(
      `Identity namespace '${namespace}' has no pending scope change. Run lobu apply with the new connector declaration first.`
    );
  }
  const first = pending[0]!;
  for (const row of rows) {
    const targetScope = row.pending_scope ?? row.scope;
    // scopeKeyPath is connector-local payload layout. Connectors sharing a
    // namespace must converge on organization-vs-tenant semantics, but may
    // extract the same upstream tenant key from different event paths.
    if (targetScope !== first.pending_scope) {
      throw new IdentityRekeyError(
        `Identity namespace '${namespace}' cannot be re-keyed while connector ` +
          `'${row.connector_key}' remains registered with a different scope. ` +
          'Every connector sharing the namespace must already match or have the same pending organization/tenant target.'
      );
    }
  }
  return {
    scope: first.pending_scope,
    scopeKeyPath: first.pending_scope_key_path,
    connectorKeys: rows.map((row) => row.connector_key),
  };
}

async function buildReport(params: {
  db: DbClient;
  organizationId: string;
  namespace: string;
  mapping: Map<string, string | null>;
  forUpdate: boolean;
}): Promise<IdentityRekeyReport> {
  const target = await loadTarget(
    params.db,
    params.organizationId,
    params.namespace,
    params.forUpdate
  );
  const lock = params.forUpdate ? params.db`FOR UPDATE` : params.db``;
  const rows = await params.db<LiveIdentity>`
    SELECT id::text AS id, identifier, scope_key,
           to_json(scope_key_history) AS scope_key_history
    FROM entity_identities
    WHERE organization_id = ${params.organizationId}
      AND namespace = ${params.namespace}
      AND deleted_at IS NULL
    ORDER BY id
    ${lock}
  `;
  const liveIds = new Set(rows.map((row) => row.id));
  const missing = rows.filter((row) => !params.mapping.has(row.id)).map((row) => row.id);
  const outside = [...params.mapping.keys()].filter((id) => !liveIds.has(id));
  if (missing.length > 0) {
    throw new IdentityRekeyError(
      `Mapping is incomplete for namespace '${params.namespace}'; missing live identity ids: ${missing.join(', ')}.`
    );
  }
  if (outside.length > 0) {
    throw new IdentityRekeyError(
      `Mapping contains identity ids outside this organization and namespace: ${outside.join(', ')}.`
    );
  }

  const changes = rows.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    fromScopeKey: row.scope_key,
    toScopeKey: params.mapping.get(row.id) ?? null,
  }));
  if (target.scope === 'tenant') {
    const nullIds = changes.filter((change) => change.toScopeKey === null).map((change) => change.id);
    if (nullIds.length > 0) {
      throw new IdentityRekeyError(
        `Tenant scope requires a non-empty tenant key for every live identity; null ids: ${nullIds.join(', ')}.`
      );
    }
  } else {
    const tenantIds = changes.filter((change) => change.toScopeKey !== null).map((change) => change.id);
    if (tenantIds.length > 0) {
      throw new IdentityRekeyError(
        `Organization scope requires null for every identity; tenant-key ids: ${tenantIds.join(', ')}.`
      );
    }
  }

  const proposed = new Map<string, string>();
  for (const change of changes) {
    const key = `${change.identifier}\u0000${change.toScopeKey ?? ''}`;
    const prior = proposed.get(key);
    if (prior) {
      throw new IdentityRekeyError(
        `Re-key collision for identifier '${change.identifier}' and scope ` +
          `'${change.toScopeKey ?? '<organization>'}': identity ids ${prior} and ${change.id}.`
      );
    }
    proposed.set(key, change.id);
  }

  // A previous scope is retained so append-only events observed under that key
  // keep resolving to the same entity. A new mapping therefore cannot assign a
  // historical key to a different identity, even when the proposed *current*
  // key set alone would be unique (for example, swapping tenant A and B).
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const retained = new Map<string, string>();
  for (const change of changes) {
    const row = rowById.get(change.id)!;
    const priorScopes = [
      ...row.scope_key_history,
      ...(change.fromScopeKey !== change.toScopeKey ? [change.fromScopeKey ?? ''] : []),
    ];
    for (const scopeKey of priorScopes) {
      const key = `${change.identifier}\u0000${scopeKey}`;
      const prior = retained.get(key);
      if (prior && prior !== change.id) {
        throw new IdentityRekeyError(
          `Historical re-key collision for identifier '${change.identifier}' and scope ` +
            `'${scopeKey || '<organization>'}': identity ids ${prior} and ${change.id}.`
        );
      }
      retained.set(key, change.id);
    }
  }
  for (const change of changes) {
    const key = `${change.identifier}\u0000${change.toScopeKey ?? ''}`;
    const historicalOwner = retained.get(key);
    if (historicalOwner && historicalOwner !== change.id) {
      throw new IdentityRekeyError(
        `Re-key collision for identifier '${change.identifier}' and scope ` +
          `'${change.toScopeKey ?? '<organization>'}': proposed identity id ${change.id} ` +
          `conflicts with retained historical scope on identity id ${historicalOwner}.`
      );
    }
  }

  return {
    namespace: params.namespace,
    targetScope: target.scope,
    targetScopeKeyPath: target.scopeKeyPath,
    connectorKeys: target.connectorKeys,
    liveIdentityCount: rows.length,
    changes,
    applied: false,
  };
}

/**
 * Rebuild the metric alias projection for entities touched by a re-key. The
 * identity rows are authoritative: organization-scoped identifiers live in
 * the flat alias array, while every identity carries its exact scope in a
 * reserved structured array. This runs in the same transaction as the row and
 * registry rewrite so metrics never observe a mixed key shape.
 */
async function refreshMetricIdentityAliases(params: {
  db: DbClient;
  organizationId: string;
  entityIds: number[];
}): Promise<void> {
  for (const entityId of [...params.entityIds].sort((left, right) => left - right)) {
    const entityRows = await params.db<{ metadata: Record<string, unknown> | null }>`
      SELECT metadata
      FROM entities
      WHERE id = ${entityId}
        AND organization_id = ${params.organizationId}
        AND deleted_at IS NULL
      FOR UPDATE
    `;
    if (entityRows.length === 0) continue;
    const identities = await params.db<{
      namespace: string;
      identifier: string;
      scope_key: string | null;
      scope_key_history: string[];
    }>`
      SELECT namespace, identifier, scope_key,
             to_json(scope_key_history) AS scope_key_history
      FROM entity_identities
      WHERE organization_id = ${params.organizationId}
        AND entity_id = ${entityId}
        AND deleted_at IS NULL
      ORDER BY namespace, identifier, COALESCE(scope_key, '')
    `;
    const organizationIdentifiers = new Set(
      identities.filter((identity) => identity.scope_key === null).map((identity) => identity.identifier)
    );
    const tenantIdentifiers = new Set(
      identities.filter((identity) => identity.scope_key !== null).map((identity) => identity.identifier)
    );
    const current = entityRows[0]?.metadata ?? {};
    const aliases = Array.isArray(current.aliases)
      ? current.aliases.filter((value): value is string => typeof value === 'string')
      : [];
    const nextAliases = [
      ...new Set([
        ...aliases.filter(
          (alias) => !tenantIdentifiers.has(alias) || organizationIdentifiers.has(alias)
        ),
        ...organizationIdentifiers,
      ]),
    ].sort();
    const projectionByKey = new Map<string, ScopedIdentityAliasProjection>();
    for (const identity of identities) {
      for (const scopeKey of [identity.scope_key ?? '', ...identity.scope_key_history]) {
        const projection = {
          namespace: identity.namespace,
          identifier: identity.identifier,
          scopeKey,
        };
        projectionByKey.set(scopedIdentityAliasProjectionKey(projection), projection);
      }
    }
    const projections = [...projectionByKey.values()].sort((left, right) =>
        scopedIdentityAliasProjectionKey(left).localeCompare(
          scopedIdentityAliasProjectionKey(right)
        )
      );
    await patchEntityRows({
      tx: params.db,
      ids: [entityId],
      patch: await validateEntityRowPatch({
        tx: params.db,
        ids: [entityId],
        patch: {
          metadata: {
            ...current,
            aliases: nextAliases,
            [SCOPED_IDENTITY_ALIASES_METADATA_KEY]: projections,
          },
        },
      }),
    });
  }
}

async function loadLiveIdentityEntityIds(params: {
  db: DbClient;
  organizationId: string;
  namespace: string;
}): Promise<number[]> {
  const rows = await params.db<{ entity_id: number | string }>`
    SELECT DISTINCT entity_id
    FROM entity_identities
    WHERE organization_id = ${params.organizationId}
      AND namespace = ${params.namespace}
      AND deleted_at IS NULL
    ORDER BY entity_id
  `;
  return rows.map((row) => Number(row.entity_id));
}

export async function rekeyEntityIdentities(params: {
  organizationId: string;
  namespace: string;
  mapping: unknown;
  apply?: boolean;
}): Promise<IdentityRekeyReport> {
  const namespace = params.namespace.trim();
  if (!namespace) throw new IdentityRekeyError('Identity namespace is required.');
  const mapping = normalizeMapping(params.mapping);
  const sql = getDb();
  if (!params.apply) {
    return buildReport({
      db: sql,
      organizationId: params.organizationId,
      namespace,
      mapping,
      forUpdate: false,
    });
  }

  for (let attempt = 1; attempt <= MAX_LOCK_ORDER_RETRIES; attempt++) {
    try {
      return await sql.begin(async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtext('lobu:identity-rekey'),
            hashtext(${`${params.organizationId}:${namespace}`})
          )
        `;

        // Every ordinary identity path that also touches entity metadata takes
        // entity rows before entity_identities (connector attribution and
        // merge/unmerge included). Match that global order: discover and lock
        // the current owners first, then take the brief table lock that closes
        // the insert gap a row-level FOR UPDATE cannot cover.
        const observedEntityIds = await loadLiveIdentityEntityIds({
          db: tx,
          organizationId: params.organizationId,
          namespace,
        });
        const lockedEntityIds =
          observedEntityIds.length === 0
            ? []
            : await tx<{ id: number | string }>`
                SELECT id
                FROM entities
                WHERE organization_id = ${params.organizationId}
                  AND id = ANY(${pgBigintArray(observedEntityIds)}::bigint[])
                ORDER BY id
                FOR UPDATE
              `;
        await tx`LOCK TABLE entity_identities IN SHARE ROW EXCLUSIVE MODE`;

        // An already-running merge can move an identity to an owner that was
        // not in the unlocked discovery snapshot before we reached its entity
        // lock. Never acquire that new row after the table lock (the old lock
        // inversion); roll back and retry the ordered acquisition instead.
        const stableEntityIds = await loadLiveIdentityEntityIds({
          db: tx,
          organizationId: params.organizationId,
          namespace,
        });
        const locked = new Set(lockedEntityIds.map((row) => Number(row.id)));
        if (stableEntityIds.some((entityId) => !locked.has(entityId))) {
          throw new IdentityRekeyLockRetry(
            `Identity namespace '${namespace}' changed owners during lock acquisition.`
          );
        }

        const report = await buildReport({
          db: tx,
          organizationId: params.organizationId,
          namespace,
          mapping,
          forUpdate: true,
        });
        const ids = report.changes.map((change) => change.id);
        if (ids.length > 0) {
          // Preserve the previous scope as an authoritative read projection before
          // moving the live uniqueness key. Events are append-only: an event
          // observed while this identity was organization-scoped has no tenant key
          // stamped on it, so dropping the old scope would strand that history from
          // identity recall and metrics. The empty string is the same unambiguous
          // organization sentinel used by the unique index.
          await tx`
        UPDATE entity_identities identity
        SET scope_key_history = CASE
          WHEN COALESCE(identity.scope_key, '') = COALESCE(proposed.scope_key, '')
            OR COALESCE(identity.scope_key, '') = ANY(identity.scope_key_history)
          THEN identity.scope_key_history
          ELSE array_append(identity.scope_key_history, COALESCE(identity.scope_key, ''))
        END
        FROM unnest(
          ${pgTextArray(ids)}::text[],
          ${pgTextArray(report.changes.map((change) => change.toScopeKey))}::text[]
        ) AS proposed(id, scope_key)
        WHERE identity.organization_id = ${params.organizationId}
          AND identity.namespace = ${namespace}
          AND identity.deleted_at IS NULL
          AND identity.id::text = proposed.id
          `;
          const temporaryPrefix = `__lobu_rekey__:${randomUUID()}:`;
          await tx`
        UPDATE entity_identities
        SET scope_key = ${temporaryPrefix} || id::text
        WHERE organization_id = ${params.organizationId}
          AND namespace = ${namespace}
          AND deleted_at IS NULL
          AND id::text = ANY(${pgTextArray(ids)}::text[])
          `;
          await tx`
        UPDATE entity_identities identity
        SET scope_key = proposed.scope_key
        FROM unnest(
          ${pgTextArray(ids)}::text[],
          ${pgTextArray(report.changes.map((change) => change.toScopeKey))}::text[]
        ) AS proposed(id, scope_key)
        WHERE identity.organization_id = ${params.organizationId}
          AND identity.namespace = ${namespace}
          AND identity.deleted_at IS NULL
          AND identity.id::text = proposed.id
          `;
        }
        const affectedEntities = await tx<{ entity_id: number | string }>`
          SELECT DISTINCT entity_id
          FROM entity_identities
          WHERE organization_id = ${params.organizationId}
            AND namespace = ${namespace}
            AND deleted_at IS NULL
            AND id::text = ANY(${pgTextArray(ids)}::text[])
          ORDER BY entity_id
        `;
        await refreshMetricIdentityAliases({
          db: tx,
          organizationId: params.organizationId,
          entityIds: affectedEntities.map((row) => Number(row.entity_id)),
        });
        await tx`
          UPDATE connector_identity_scope_registry
          SET scope = pending_scope,
              scope_key_path = pending_scope_key_path,
              pending_scope = NULL,
              pending_scope_key_path = NULL,
              shape_version = shape_version + 1,
              updated_at = now()
          WHERE organization_id = ${params.organizationId}
            AND namespace = ${namespace}
            AND connector_key = ANY(${pgTextArray(report.connectorKeys)}::text[])
            AND pending_scope IS NOT NULL
        `;
        return { ...report, applied: true };
      });
    } catch (error) {
      if (!(error instanceof IdentityRekeyLockRetry)) throw error;
      if (attempt === MAX_LOCK_ORDER_RETRIES) {
        throw new IdentityRekeyError(
          `Identity namespace '${namespace}' kept changing owners during re-key. Retry after concurrent merges finish.`
        );
      }
    }
  }

  throw new IdentityRekeyError(`Identity namespace '${namespace}' could not be re-keyed.`);
}
