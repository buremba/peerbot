/**
 * Source ownership for ordinary entity relationships.
 *
 * A live edge is one graph fact with one or more independent claims. Connector
 * claims are keyed by the same durable source identity as connector events:
 * (connection_id, origin_id). Reconciliation removes only that exact claim;
 * the edge is tombstoned only after its final claim disappears.
 */

import { type DbClient, pgTextArray } from '../db/client';
import { ToolUserError } from './errors';
import { insertEdgeChangeEventInTransaction } from './insert-event';
import {
  assertNotAclManagedEdge,
  canonicalizeSymmetricEdge,
  validateNoSelfReference,
  validateTypeRule,
} from './relationship-validation';

export const RELATIONSHIP_CLAIMS_METADATA_KEY = '_lobu_claims';
export const MANUAL_RELATIONSHIP_CLAIM_KEY = 'manual';

export interface ConnectorRelationshipDeclaration {
  type: string;
  from: string;
  to: string;
}

export interface DesiredConnectorRelationship {
  declaration: ConnectorRelationshipDeclaration;
  fromEntityId: number;
  toEntityId: number;
}

interface ConnectorRelationshipClaim extends Record<string, unknown> {
  rules: string[];
}

interface RelationshipTypeRow {
  id: number | string;
  slug: string;
  is_symmetric: boolean;
  purpose: string | null;
}

interface ClaimedRelationshipRow {
  id: number | string;
  from_entity_id: number | string;
  to_entity_id: number | string;
  relationship_type_id: number | string;
  relationship_type_slug: string | null;
  relationship_type_purpose?: string | null;
  metadata: unknown;
  confidence: number | null;
  source: string | null;
  inserted?: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function connectorRelationshipClaimKey(
  connectionId: number | string,
  originId: string
): string {
  return `feed:${connectionId}:${originId}`;
}

function connectorRelationshipClaimPrefix(connectionId: number | string): string {
  return `feed:${connectionId}:`;
}

export function relationshipMetadataWithoutClaims(value: unknown): Record<string, unknown> | null {
  const metadata = record(value);
  if (!metadata) return null;
  const { [RELATIONSHIP_CLAIMS_METADATA_KEY]: _claims, ...visible } = metadata;
  return Object.keys(visible).length > 0 ? visible : null;
}

function claimsFromMetadata(value: unknown): Record<string, unknown> | null {
  const metadata = record(value);
  return record(metadata?.[RELATIONSHIP_CLAIMS_METADATA_KEY]);
}

export function assertManualRelationshipMutationAllowed(
  row: { id: number | string; metadata: unknown },
  action: string
): void {
  const claims = claimsFromMetadata(row.metadata);
  if (!claims) throw migrationRequired(row);
  if (!Object.hasOwn(claims, MANUAL_RELATIONSHIP_CLAIM_KEY)) {
    throw new ToolUserError(
      `Relationship ${row.id} is source-managed and cannot be ${action} manually. ` +
        'Change or remove it through the connector that owns its remaining claims.',
      409
    );
  }
}

export function assertNoReservedRelationshipMetadata(metadata: unknown): void {
  if (record(metadata) && Object.hasOwn(metadata as object, RELATIONSHIP_CLAIMS_METADATA_KEY)) {
    throw new ToolUserError(
      `Metadata key '${RELATIONSHIP_CLAIMS_METADATA_KEY}' is reserved for relationship ownership.`,
      400
    );
  }
}

function migrationRequired(row: { id: number | string }): ToolUserError {
  return new ToolUserError(
    `Relationship ${row.id} has no ${RELATIONSHIP_CLAIMS_METADATA_KEY} ownership metadata. ` +
      'Migrate the relationship to a manual or source claim before connector ingestion.',
    409
  );
}

async function lockOrganization(tx: DbClient, organizationId: string): Promise<void> {
  const rows = await tx`
    SELECT 1 FROM organization
    WHERE id = ${organizationId}
    FOR KEY SHARE
  `;
  if (rows.length === 0) throw new ToolUserError('Organization not found', 404);
}

async function lockLiveConnection(
  tx: DbClient,
  organizationId: string,
  connectionId: number
): Promise<void> {
  const rows = await tx`
    SELECT 1 FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    FOR SHARE
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Connection ${connectionId} is not active`, 409);
  }
}

async function assertRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    fromEntityId: number;
    toEntityId: number;
    relationshipTypeId: number;
    relationshipTypeSlug: string;
    claimKey: string;
    claim: Record<string, unknown>;
    source: string;
    confidence?: number | null;
    createdBy?: string | null;
    clientId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<{ id: number; inserted: boolean; claimAdded: boolean }> {
  const initialMetadata = {
    ...(params.metadata ?? {}),
    [RELATIONSHIP_CLAIMS_METADATA_KEY]: { [params.claimKey]: params.claim },
  };
  const written = await tx<ClaimedRelationshipRow>`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by, created_at, updated_at
    ) VALUES (
      ${params.organizationId}, ${params.fromEntityId}, ${params.toEntityId},
      ${params.relationshipTypeId}, ${tx.json(initialMetadata)},
      ${params.confidence ?? null}, ${params.source}, ${params.createdBy ?? null},
      ${params.createdBy ?? null}, current_timestamp, current_timestamp
    )
    ON CONFLICT (from_entity_id, to_entity_id, relationship_type_id)
      WHERE deleted_at IS NULL
    DO UPDATE SET
      metadata = jsonb_set(
        COALESCE(entity_relationships.metadata, '{}'::jsonb),
        '{_lobu_claims}',
        (entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY})
          || jsonb_build_object(${params.claimKey}::text, ${tx.json(params.claim)}::jsonb),
        true
      ),
      updated_at = current_timestamp
    WHERE entity_relationships.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
      AND entity_relationships.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY} -> ${params.claimKey}
          IS DISTINCT FROM ${tx.json(params.claim)}::jsonb
    RETURNING id, from_entity_id, to_entity_id, relationship_type_id,
              metadata, confidence, source, (xmax = 0) AS inserted
  `;

  let row = written[0];
  if (!row) {
    const existing = await tx<ClaimedRelationshipRow>`
      SELECT id, from_entity_id, to_entity_id, relationship_type_id,
             metadata, confidence, source
      FROM entity_relationships
      WHERE organization_id = ${params.organizationId}
        AND from_entity_id = ${params.fromEntityId}
        AND to_entity_id = ${params.toEntityId}
        AND relationship_type_id = ${params.relationshipTypeId}
        AND deleted_at IS NULL
      LIMIT 1
      FOR UPDATE
    `;
    row = existing[0];
    if (!row) throw new Error('Relationship claim upsert returned no live relationship');
    const claims = claimsFromMetadata(row.metadata);
    if (!claims) throw migrationRequired(row);
    if (!Object.hasOwn(claims, params.claimKey)) {
      throw new Error(`Relationship ${row.id} did not persist claim '${params.claimKey}'`);
    }
    return { id: Number(row.id), inserted: false, claimAdded: false };
  }

  const inserted = row.inserted === true;
  if (inserted) {
    await insertEdgeChangeEventInTransaction(
      {
        organizationId: params.organizationId,
        relationshipId: Number(row.id),
        fromEntityId: params.fromEntityId,
        toEntityId: params.toEntityId,
        relationshipTypeId: params.relationshipTypeId,
        relationshipTypeSlug: params.relationshipTypeSlug,
        op: 'link',
        changes: [
          { field: 'exists', old: false, new: true },
          { field: 'metadata', old: null, new: params.metadata ?? null },
          { field: 'confidence', old: null, new: params.confidence ?? null },
          { field: 'source', old: null, new: params.source },
        ],
        createdBy: params.createdBy ?? null,
        clientId: params.clientId ?? null,
      },
      tx
    );
  }
  return { id: Number(row.id), inserted, claimAdded: true };
}

/** Add the caller-owned claim to a manual relationship assertion. */
export async function assertManualRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    fromEntityId: number;
    toEntityId: number;
    relationshipTypeId: number;
    relationshipTypeSlug: string;
    source: string;
    confidence?: number | null;
    createdBy?: string | null;
    clientId?: string | null;
    metadata?: Record<string, unknown> | null;
  }
): Promise<{ id: number; inserted: boolean; claimAdded: boolean }> {
  await lockOrganization(tx, params.organizationId);
  return assertRelationshipClaim(tx, {
    ...params,
    claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
    claim: {},
  });
}

async function retractLockedRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    claimKey: string;
    row: ClaimedRelationshipRow;
    updatedBy?: string | null;
    clientId?: string | null;
  }
): Promise<{ relationshipRemoved: boolean }> {
  const claims = claimsFromMetadata(params.row.metadata);
  if (!claims) throw migrationRequired(params.row);
  if (!Object.hasOwn(claims, params.claimKey)) {
    throw new Error(`Relationship ${params.row.id} does not carry claim '${params.claimKey}'`);
  }
  const relationshipId = Number(params.row.id);
  const remainingClaims = Object.keys(claims).filter((key) => key !== params.claimKey);
  if (remainingClaims.length > 0) {
    await tx`
      UPDATE entity_relationships
      SET metadata = jsonb_set(
            metadata,
            '{_lobu_claims}',
            (metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) - ${params.claimKey},
            true
          ),
          updated_by = COALESCE(${params.updatedBy ?? null}, updated_by),
          updated_at = current_timestamp
      WHERE id = ${relationshipId} AND deleted_at IS NULL
    `;
    return { relationshipRemoved: false };
  }

  await tx`
    UPDATE entity_relationships
    SET deleted_at = current_timestamp,
        updated_by = COALESCE(${params.updatedBy ?? null}, updated_by),
        updated_at = current_timestamp
    WHERE id = ${relationshipId} AND deleted_at IS NULL
  `;
  await insertEdgeChangeEventInTransaction(
    {
      organizationId: params.organizationId,
      relationshipId,
      fromEntityId: Number(params.row.from_entity_id),
      toEntityId: Number(params.row.to_entity_id),
      relationshipTypeId: Number(params.row.relationship_type_id),
      relationshipTypeSlug: params.row.relationship_type_slug,
      op: 'unlink',
      changes: [
        { field: 'exists', old: true, new: false },
        {
          field: 'metadata',
          old: relationshipMetadataWithoutClaims(params.row.metadata),
          new: null,
        },
        { field: 'confidence', old: params.row.confidence, new: null },
        { field: 'source', old: params.row.source, new: null },
      ],
      createdBy: params.updatedBy ?? null,
      clientId: params.clientId ?? null,
    },
    tx
  );
  return { relationshipRemoved: true };
}

/** Remove only the manual claim; retain a source-claimed edge. */
export async function retractManualRelationshipClaim(
  tx: DbClient,
  params: {
    organizationId: string;
    relationshipId: number;
    updatedBy?: string | null;
    clientId?: string | null;
  }
): Promise<{ relationshipRemoved: boolean }> {
  await lockOrganization(tx, params.organizationId);
  const rows = await tx<ClaimedRelationshipRow>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
           rt.slug AS relationship_type_slug, rt.purpose AS relationship_type_purpose,
           r.metadata, r.confidence, r.source
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.id = ${params.relationshipId}
      AND r.organization_id = ${params.organizationId}
      AND r.deleted_at IS NULL
    LIMIT 1
    FOR UPDATE OF r
  `;
  const row = rows[0];
  if (!row) throw new ToolUserError(`Relationship ${params.relationshipId} not found`, 404);
  assertNotAclManagedEdge(
    { slug: row.relationship_type_slug, purpose: row.relationship_type_purpose },
    'unlink'
  );
  assertManualRelationshipMutationAllowed(row, 'unlinked');
  return retractLockedRelationshipClaim(tx, {
    organizationId: params.organizationId,
    claimKey: MANUAL_RELATIONSHIP_CLAIM_KEY,
    row,
    updatedBy: params.updatedBy,
    clientId: params.clientId,
  });
}

async function retractRelationshipClaimExcept(
  tx: DbClient,
  params: {
    organizationId: string;
    claimKey: string;
    keepRelationshipIds: ReadonlySet<number>;
  }
): Promise<void> {
  const rows = await tx<ClaimedRelationshipRow>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relationship_type_id,
           rt.slug AS relationship_type_slug, r.metadata, r.confidence, r.source
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON rt.id = r.relationship_type_id
    WHERE r.organization_id = ${params.organizationId}
      AND r.deleted_at IS NULL
      AND r.metadata ? ${RELATIONSHIP_CLAIMS_METADATA_KEY}
      AND (r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}) ? ${params.claimKey}
    ORDER BY r.id
    FOR UPDATE OF r
  `;

  for (const row of rows) {
    if (params.keepRelationshipIds.has(Number(row.id))) continue;
    await retractLockedRelationshipClaim(tx, {
      organizationId: params.organizationId,
      claimKey: params.claimKey,
      row,
    });
  }
}

/** Reconcile one connector event's complete declared relationship set. */
export async function reconcileConnectorRelationshipClaims(
  tx: DbClient,
  params: {
    organizationId: string;
    connectionId: number;
    originId: string;
    desired: DesiredConnectorRelationship[];
  }
): Promise<void> {
  await lockOrganization(tx, params.organizationId);
  await lockLiveConnection(tx, params.organizationId, params.connectionId);

  const typeSlugs = [...new Set(params.desired.map((edge) => edge.declaration.type))];
  const typeRows =
    typeSlugs.length === 0
      ? []
      : await tx<RelationshipTypeRow>`
          SELECT id, slug, is_symmetric, purpose
          FROM entity_relationship_types
          WHERE organization_id = ${params.organizationId}
            AND slug = ANY(${pgTextArray(typeSlugs)}::text[])
            AND status = 'active'
            AND deleted_at IS NULL
        `;
  const typeBySlug = new Map(typeRows.map((row) => [row.slug, row]));
  for (const slug of typeSlugs) {
    const type = typeBySlug.get(slug);
    if (!type) {
      throw new ToolUserError(`Connector relationship type '${slug}' is not active`, 409);
    }
    assertNotAclManagedEdge(type, 'connector relationship materialization');
  }

  const aggregated = new Map<
    string,
    {
      fromEntityId: number;
      toEntityId: number;
      relationshipTypeId: number;
      relationshipTypeSlug: string;
      rules: Set<string>;
    }
  >();
  for (const desired of params.desired) {
    const type = typeBySlug.get(desired.declaration.type)!;
    validateNoSelfReference(desired.fromEntityId, desired.toEntityId);
    await validateTypeRule(
      Number(type.id),
      desired.fromEntityId,
      desired.toEntityId,
      tx
    );
    const endpoints = type.is_symmetric
      ? canonicalizeSymmetricEdge(desired.fromEntityId, desired.toEntityId)
      : { from: desired.fromEntityId, to: desired.toEntityId };
    const key = `${endpoints.from}:${endpoints.to}:${type.id}`;
    const declarationKey = `${desired.declaration.type}:${desired.declaration.from}->${desired.declaration.to}`;
    const current = aggregated.get(key);
    if (current) {
      current.rules.add(declarationKey);
    } else {
      aggregated.set(key, {
        fromEntityId: endpoints.from,
        toEntityId: endpoints.to,
        relationshipTypeId: Number(type.id),
        relationshipTypeSlug: type.slug,
        rules: new Set([declarationKey]),
      });
    }
  }

  const claimKey = connectorRelationshipClaimKey(params.connectionId, params.originId);
  const keepRelationshipIds = new Set<number>();
  for (const edge of aggregated.values()) {
    const claim: ConnectorRelationshipClaim = {
      rules: [...edge.rules].sort(),
    };
    const asserted = await assertRelationshipClaim(tx, {
      organizationId: params.organizationId,
      fromEntityId: edge.fromEntityId,
      toEntityId: edge.toEntityId,
      relationshipTypeId: edge.relationshipTypeId,
      relationshipTypeSlug: edge.relationshipTypeSlug,
      claimKey,
      claim,
      source: 'feed',
    });
    keepRelationshipIds.add(asserted.id);
  }

  await retractRelationshipClaimExcept(tx, {
    organizationId: params.organizationId,
    claimKey,
    keepRelationshipIds,
  });
}

/** Remove every connector-event claim owned by a connection. */
export async function retractConnectionRelationshipClaims(
  tx: DbClient,
  params: { organizationId: string; connectionId: number | string }
): Promise<void> {
  await lockOrganization(tx, params.organizationId);
  const prefix = connectorRelationshipClaimPrefix(params.connectionId);
  const keys = await tx<{ claim_key: string }>`
    SELECT DISTINCT claim.key AS claim_key
    FROM entity_relationships r
    CROSS JOIN LATERAL jsonb_object_keys(
      COALESCE(r.metadata -> ${RELATIONSHIP_CLAIMS_METADATA_KEY}, '{}'::jsonb)
    ) AS claim(key)
    WHERE r.organization_id = ${params.organizationId}
      AND r.deleted_at IS NULL
      AND left(claim.key, length(${prefix})) = ${prefix}
    ORDER BY claim.key
  `;

  for (const row of keys) {
    await retractRelationshipClaimExcept(tx, {
      organizationId: params.organizationId,
      claimKey: row.claim_key,
      keepRelationshipIds: new Set(),
    });
  }
}
