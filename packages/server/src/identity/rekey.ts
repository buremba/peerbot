import { randomUUID } from 'node:crypto';
import { type DbClient, getDb, pgTextArray } from '../db/client';

export class IdentityRekeyError extends Error {}

type RekeyTarget = {
  scope: 'organization' | 'tenant';
  scopeKeyPath: string | null;
  connectorKeys: string[];
};

type LiveIdentity = {
  id: string;
  identifier: string;
  scope_key: string | null;
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
    const targetScopeKeyPath =
      row.pending_scope === null ? row.scope_key_path : row.pending_scope_key_path;
    if (targetScope !== first.pending_scope || targetScopeKeyPath !== first.pending_scope_key_path) {
      throw new IdentityRekeyError(
        `Identity namespace '${namespace}' cannot be re-keyed while connector ` +
          `'${row.connector_key}' remains registered with a different declaration shape. ` +
          'Every connector sharing the namespace must already match or have the same pending target.'
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
    SELECT id::text AS id, identifier, scope_key
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

  return sql.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext('lobu:identity-rekey'),
        hashtext(${`${params.organizationId}:${namespace}`})
      )
    `;
    // The mapping must cover the complete live set observed below. A row-level
    // FOR UPDATE cannot lock a not-yet-inserted identity, so briefly stop all
    // identity writers during this rare administrative rewrite; reads continue.
    await tx`LOCK TABLE entity_identities IN SHARE ROW EXCLUSIVE MODE`;
    const report = await buildReport({
      db: tx,
      organizationId: params.organizationId,
      namespace,
      mapping,
      forUpdate: true,
    });
    const ids = report.changes.map((change) => change.id);
    if (ids.length > 0) {
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
}
