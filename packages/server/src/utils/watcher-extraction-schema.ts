/**
 * Watcher extraction schema — derived from the target entity type (consolidation:
 * "schema lives on the entity type, not the watcher").
 *
 * A watcher that names an `entity_type` in its `keying_config` and supplies NO
 * inline `extraction_schema` derives its output contract from that entity type's
 * `metadata_schema`: the extraction must produce an array of records (at
 * `keying_config.entity_path`) that each conform to the type's schema. This is
 * the single source of truth — the same schema validates manual entity writes
 * (`schema-validation.ts`), so a record's shape is defined ONCE, on the type.
 *
 * Both the worker payload (poll.ts — ships the contract to the device) and
 * window completion (complete-window.ts — validates the returned data) resolve
 * the schema through this helper, so extraction and validation can never drift.
 * Returns null when the watcher isn't entity-typed or the type has no schema —
 * callers then fall back to the inline `extraction_schema` (the escape hatch for
 * heterogeneous / non-entity-shaped watchers).
 */

import type { DbClient } from '../db/client';
import type { KeyingConfig } from '../types/watchers';

/**
 * Resolve an entity type's `metadata_schema` (JSON Schema Draft-7), tenant-first
 * then public catalog — the same precedence as `schema-validation.ts` and the
 * keyed-promotion type resolver, so derivation and promotion agree on the type.
 */
async function resolveEntityTypeMetadataSchema(
  sql: DbClient,
  organizationId: string,
  entityTypeSlug: string
): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ metadata_schema: Record<string, unknown> | string | null }>`
    SELECT et.metadata_schema
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${entityTypeSlug}
      AND et.deleted_at IS NULL
      AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  const raw = rows[0]?.metadata_schema ?? null;
  if (raw == null) return null;
  const schema = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) {
    return null;
  }
  return schema as Record<string, unknown>;
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a per-record metadata schema as the full extraction-output schema: an
 * array of those records living at `entityPath`. A dotted path
 * (`analysis.results.problems`) becomes nested required objects, so the LLM's
 * output object is validated end to end, not just the leaf array.
 */
export function wrapMetadataSchemaAtPath(
  metadataSchema: Record<string, unknown>,
  entityPath: string
): Record<string, unknown> {
  const segments = entityPath.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) {
    // No path — the whole output is the array of records.
    return { type: 'array', items: metadataSchema };
  }
  // Build from the leaf array outward.
  let node: Record<string, unknown> = { type: 'array', items: metadataSchema };
  for (let i = segments.length - 1; i >= 0; i--) {
    node = {
      type: 'object',
      properties: { [segments[i]]: node },
      required: [segments[i]],
    };
  }
  return node;
}

/**
 * Derive a watcher's extraction schema from its target entity type. Returns null
 * when the watcher isn't entity-typed (no `keying_config.entity_type`) or the
 * type carries no schema — callers fall back to the inline `extraction_schema`.
 */
export async function deriveWatcherExtractionSchema(
  sql: DbClient,
  organizationId: string,
  keyingConfig: KeyingConfig | null | undefined
): Promise<Record<string, unknown> | null> {
  const entityType = keyingConfig?.entity_type?.trim();
  if (!entityType || !keyingConfig?.entity_path) return null;
  const metadataSchema = await resolveEntityTypeMetadataSchema(sql, organizationId, entityType);
  if (!metadataSchema) return null;
  return wrapMetadataSchemaAtPath(metadataSchema, keyingConfig.entity_path);
}
