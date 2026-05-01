/**
 * Relationship Validation Helpers
 *
 * Validates entity relationship constraints: self-reference, confidence bounds,
 * source enums, symmetric canonicalization, scope enforcement, type-pair rules, and
 * duplicate edge detection.
 */

import { type DbClient, getDb } from '../db/client';
import type { Env } from '../index';
import type { ToolContext } from '../tools/registry';

// Valid relationship sources
const RELATIONSHIP_SOURCES = ['ui', 'llm', 'feed', 'api'] as const;
type RelationshipSource = (typeof RELATIONSHIP_SOURCES)[number];

/**
 * Validate that a relationship does not reference itself.
 */
export function validateNoSelfReference(fromId: number, toId: number): void {
  if (fromId === toId) {
    throw new Error('Self-referencing relationships are not allowed');
  }
}

/**
 * Validate confidence is in [0, 1] range.
 */
export function validateConfidence(confidence: number | undefined | null): void {
  if (confidence === undefined || confidence === null) return;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new Error('Confidence must be a number between 0 and 1');
  }
}

/**
 * Validate source is a known enum value.
 */
export function validateSource(source: string | undefined | null): void {
  if (source === undefined || source === null) return;
  if (!RELATIONSHIP_SOURCES.includes(source as RelationshipSource)) {
    throw new Error(
      `Invalid source "${source}". Must be one of: ${RELATIONSHIP_SOURCES.join(', ')}`
    );
  }
}

/**
 * Canonicalize a symmetric edge so from_entity_id < to_entity_id.
 */
export function canonicalizeSymmetricEdge(
  fromId: number,
  toId: number
): { from: number; to: number } {
  return fromId <= toId ? { from: fromId, to: toId } : { from: toId, to: fromId };
}

/**
 * Validate scope rule for a relationship.
 *
 * The from_entity must belong to the caller's organization (relationships are
 * always authored from the source's org). The to_entity may be either in the
 * same org or in a public-catalog org (`organization.visibility='public'`),
 * which lets a tenant's relationship reference canonical world entities like
 * HMRC or Barclays without copying them locally.
 *
 * Public → tenant references are forbidden — public catalogs never reach into
 * private orgs. The relationship row's organization_id always matches the
 * source's org (the caller's), keeping the assertion under the caller's
 * delete/visibility control.
 */
export async function validateScopeRule(
  fromEntityId: number,
  toEntityId: number,
  _env: Env,
  ctx: ToolContext
): Promise<void> {
  const sql = getDb();

  const rows = await sql`
    SELECT e.id, e.organization_id, o.visibility
    FROM entities e
    LEFT JOIN organization o ON o.id = e.organization_id
    WHERE e.id IN (${fromEntityId}, ${toEntityId})
  `;

  if (rows.length < 2) {
    const foundIds = rows.map((r) => r.id);
    const missingId = [fromEntityId, toEntityId].find((id) => !foundIds.includes(id));
    throw new Error(`Entity ${missingId} not found`);
  }

  const fromEntity = rows.find((r) => Number(r.id) === fromEntityId)!;
  const toEntity = rows.find((r) => Number(r.id) === toEntityId)!;

  // Source must always be in the caller's org — you can't author relationships
  // *from* someone else's entity.
  if (String(fromEntity.organization_id) !== ctx.organizationId) {
    throw new Error(`Entity ${fromEntityId} does not belong to your organization`);
  }

  // Target may be same-org OR a public-catalog entity. Anything else (a
  // private org you don't control) is rejected.
  const toOrgId = String(toEntity.organization_id);
  const toVisibility = String(toEntity.visibility ?? 'private');
  if (toOrgId !== ctx.organizationId && toVisibility !== 'public') {
    throw new Error(
      `Entity ${toEntityId} is in a private organization that does not belong to you. Cross-org references are only allowed to entities in public catalogs.`
    );
  }
}

/**
 * Validate that the relationship type allows the given entity type pair.
 * For symmetric types, checks both directions.
 */
export async function validateTypeRule(
  relationshipTypeId: number,
  fromEntityId: number,
  toEntityId: number,
  sql: DbClient
): Promise<void> {
  // Get the relationship type to check if it's symmetric
  const typeRows = await sql`
    SELECT is_symmetric
    FROM entity_relationship_types
    WHERE id = ${relationshipTypeId}
      AND deleted_at IS NULL
  `;
  if (typeRows.length === 0) {
    throw new Error(`Relationship type ${relationshipTypeId} not found`);
  }
  const isSymmetric = Boolean(typeRows[0].is_symmetric);

  // Get entity types for both entities
  const entityRows = await sql`
    SELECT e.id, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id IN (${fromEntityId}, ${toEntityId})
  `;
  const fromEntityType = String(entityRows.find((r) => Number(r.id) === fromEntityId)?.entity_type);
  const toEntityType = String(entityRows.find((r) => Number(r.id) === toEntityId)?.entity_type);

  // Check if there are any rules for this relationship type
  const ruleRows = await sql`
    SELECT source_entity_type_slug, target_entity_type_slug
    FROM entity_relationship_type_rules
    WHERE relationship_type_id = ${relationshipTypeId}
      AND deleted_at IS NULL
  `;

  // No rules = any pair is allowed
  if (ruleRows.length === 0) return;

  // Check if the pair matches any rule (check both directions for symmetric types)
  const matches = ruleRows.some((rule) => {
    const srcSlug = String(rule.source_entity_type_slug);
    const tgtSlug = String(rule.target_entity_type_slug);

    if (srcSlug === fromEntityType && tgtSlug === toEntityType) return true;
    if (isSymmetric && srcSlug === toEntityType && tgtSlug === fromEntityType) return true;
    return false;
  });

  if (!matches) {
    throw new Error(
      `Relationship type ${relationshipTypeId} does not allow ${fromEntityType} → ${toEntityType}`
    );
  }
}

/**
 * Check for duplicate active edge between two entities of the same type.
 */
export async function checkDuplicateEdge(
  fromId: number,
  toId: number,
  typeId: number,
  sql: DbClient
): Promise<void> {
  const existing = await sql`
    SELECT id FROM entity_relationships
    WHERE from_entity_id = ${fromId}
      AND to_entity_id = ${toId}
      AND relationship_type_id = ${typeId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) {
    throw new Error(
      `An active relationship of this type already exists between entities ${fromId} and ${toId}`
    );
  }
}
