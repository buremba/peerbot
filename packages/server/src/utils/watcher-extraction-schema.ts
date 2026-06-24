/**
 * Watcher extraction schema — derived from the target entity type (consolidation:
 * "schema lives on the entity type, not the watcher").
 *
 * A watcher that names an `entity_type` in its `keying_config` derives its output
 * contract from that entity type's `metadata_schema`: the extraction must produce
 * an array of records (at `keying_config.entity_path`) that each conform to the
 * type's schema. This is the single source of truth — the same schema validates
 * manual entity writes (`schema-validation.ts`), so a record's shape is defined
 * ONCE, on the type.
 *
 * Both the worker payload (poll.ts / get_content — ships the contract to the
 * device) and window completion (complete-window.ts — validates the returned
 * data) resolve the schema through this helper, so extraction and validation can
 * never drift. Returns null when the watcher isn't entity-typed or the type has
 * no schema — callers then run the worker's free-form `{ summary }` fallback
 * (there is no inline extraction schema; that path was removed).
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
 * Derive a watcher's extraction schema. Precedence:
 *  1. Entity-typed (`keying_config.entity_type`) → the type's `metadata_schema`
 *     wrapped as an array at `entity_path`.
 *  2. Reaction watcher → the reaction's exported `input` schema, cached on
 *     `watchers.reaction_input_schema` at set_reaction_script time. This is how
 *     "the reaction owns the schema" reaches the worker: the device extracts
 *     against exactly what the reaction will `Value.Parse`.
 *  3. Otherwise null — the worker runs the free-form `{ summary }` fallback.
 *
 * Both the worker payload and complete_window validation resolve through here,
 * so extraction and validation can never drift. `watcherId` enables the reaction
 * lookup; omit it to skip step 2 (entity-typed-only callers).
 */
export async function deriveWatcherExtractionSchema(
  sql: DbClient,
  organizationId: string,
  keyingConfig: KeyingConfig | null | undefined,
  watcherId?: string | number | null
): Promise<Record<string, unknown> | null> {
  const entityType = keyingConfig?.entity_type?.trim();
  if (entityType && keyingConfig?.entity_path) {
    const metadataSchema = await resolveEntityTypeMetadataSchema(sql, organizationId, entityType);
    if (metadataSchema) return wrapMetadataSchemaAtPath(metadataSchema, keyingConfig.entity_path);
  }
  if (watcherId != null && watcherId !== '') {
    const rows = await sql<{ reaction_input_schema: Record<string, unknown> | string | null }>`
      SELECT reaction_input_schema FROM watchers
      WHERE id = ${watcherId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    const raw = rows[0]?.reaction_input_schema ?? null;
    if (raw == null) return null;
    const schema = typeof raw === 'string' ? safeParse(raw) : raw;
    if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
      return schema as Record<string, unknown>;
    }
  }
  return null;
}
