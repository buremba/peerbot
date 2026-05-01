/**
 * Schema Validation Utility
 *
 * Validates entity metadata against JSON Schema (Draft 7) stored in entity_types table.
 * Uses ajv for validation with format support (uri, date, email, etc.).
 */

import { getDb } from '../db/client';
import type { ToolContext } from '../tools/registry';
import { formatAjvError, getAjv } from './ajv-singleton';

// ============================================
// Types
// ============================================

interface ValidationError {
  path: string;
  message: string;
}

interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

/**
 * Fetch the metadata schema for an entity type from the database.
 * Returns null if no schema is defined (allowing any metadata).
 *
 * Cross-org tolerance: an entity created in the caller's org may carry a
 * type from a public catalog (resolved via the schema search path in
 * `entity-management.ts:249-260`). To validate that entity's metadata we
 * must load the catalog's schema, not the caller's. Same lookup shape as
 * the create-side resolver: tenant first, then public catalogs.
 */
async function getEntityTypeSchema(
  entityType: string,
  ctx: ToolContext
): Promise<Record<string, unknown> | null> {
  const sql = getDb();

  const rows = await sql.unsafe(
    `SELECT et.metadata_schema
     FROM entity_types et
     LEFT JOIN organization o ON o.id = et.organization_id
     WHERE et.slug = $1
       AND et.deleted_at IS NULL
       AND (et.organization_id = $2 OR o.visibility = 'public')
     ORDER BY (et.organization_id = $2) DESC, et.id ASC
     LIMIT 1`,
    [entityType, ctx.organizationId]
  );

  return (rows[0]?.metadata_schema as Record<string, unknown>) ?? null;
}

// ============================================
// Validation Functions
// ============================================

/**
 * Validate entity metadata against the entity type's JSON schema.
 *
 * Returns { valid: true } if:
 * - Metadata passes schema validation
 * - No schema is defined for the entity type (allows any metadata)
 * - Metadata is empty/undefined
 *
 * Returns { valid: false, errors: [...] } if validation fails.
 */
export async function validateEntityMetadata(
  entityType: string,
  metadata: Record<string, unknown> | undefined | null,
  ctx: ToolContext
): Promise<ValidationResult> {
  // No metadata provided - valid (defaults to empty object)
  if (!metadata || Object.keys(metadata).length === 0) {
    return { valid: true };
  }

  // Fetch schema for this entity type
  const schema = await getEntityTypeSchema(entityType, ctx);

  // No schema defined - allow any metadata
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true };
  }

  // Validate metadata against schema
  const ajv = getAjv();
  const validate = ajv.compile(schema);
  const isValid = validate(metadata);

  if (isValid) {
    return { valid: true };
  }

  // Format errors for client consumption
  const errors: ValidationError[] = (validate.errors ?? []).map((err) => ({
    path: err.instancePath || '/',
    message: formatAjvError(err),
  }));

  return { valid: false, errors };
}
