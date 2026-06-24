/**
 * Watcher window render — derived from the target entity type (consolidation:
 * "render lives on the entity type, not the watcher").
 *
 * The sibling of `watcher-extraction-schema.ts`: just as an entity-typed watcher
 * derives its extraction *schema* from the entity type's `metadata_schema`, it
 * derives its window *render* from that type's view template. A watcher whose
 * `keying_config.entity_type` names a type, and which carries NO inline
 * `json_template`, renders each extracted record with the entity type's render —
 * the SAME template the entity detail page uses, so a record looks identical
 * whether viewed in the watcher window or as a promoted entity.
 *
 * Composition note: an entity-type render renders ONE record; a watcher window
 * holds an ARRAY of records (at `keying_config.entity_path`). So this returns the
 * per-record template plus the path, and the renderer iterates — it does NOT wrap
 * the template server-side (the render DSL's iteration node binds item scope on
 * the client, which would require rewriting every binding path). Returns null
 * when the watcher isn't entity-typed or the type has no render — callers fall
 * back to the inline `json_template` (the escape hatch for bespoke renders).
 */

import type { DbClient } from '../db/client';
import type { KeyingConfig } from '../types/watchers';

/**
 * Resolve an entity type's current default render template, tenant-first then
 * public catalog — the same precedence as `resolveEntityTypeMetadataSchema`, so
 * schema derivation and render derivation agree on which type they resolve. The
 * render is the version pointed to by `entity_types.current_view_template_version_id`
 * (the default/overview tab). Returns null when the type carries no render.
 */
async function resolveEntityTypeRender(
  sql: DbClient,
  organizationId: string,
  entityTypeSlug: string
): Promise<Record<string, unknown> | null> {
  const rows = await sql<{ json_template: Record<string, unknown> | string | null }>`
    SELECT vtv.json_template
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    JOIN view_template_versions vtv ON vtv.id = et.current_view_template_version_id
    WHERE et.slug = ${entityTypeSlug}
      AND et.deleted_at IS NULL
      AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
    ORDER BY (et.organization_id = ${organizationId}) DESC, et.id ASC
    LIMIT 1
  `;
  const raw = rows[0]?.json_template ?? null;
  if (raw == null) return null;
  const template = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!template || typeof template !== 'object' || Object.keys(template).length === 0) {
    return null;
  }
  return template as Record<string, unknown>;
}

function safeParse(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export interface DerivedWatcherRender {
  /** The entity type's per-record render template (JsonTemplate root). */
  render: Record<string, unknown>;
  /**
   * Dotted path into a window's `extracted_data` where the record array lives
   * (from `keying_config.entity_path`). The renderer maps this array, rendering
   * each record with `render`. Always non-empty — `deriveWatcherRender` returns
   * null when `entity_path` is missing (the same contract as the schema helper).
   */
  entityPath: string;
}

/**
 * Derive a watcher's window render from its target entity type. Returns null when
 * the watcher isn't entity-typed (no `keying_config.entity_type`) or the type has
 * no render — callers fall back to the inline `json_template`.
 */
export async function deriveWatcherRender(
  sql: DbClient,
  organizationId: string,
  keyingConfig: KeyingConfig | null | undefined
): Promise<DerivedWatcherRender | null> {
  const entityType = keyingConfig?.entity_type?.trim();
  if (!entityType || !keyingConfig?.entity_path) return null;
  const render = await resolveEntityTypeRender(sql, organizationId, entityType);
  if (!render) return null;
  return { render, entityPath: keyingConfig.entity_path };
}
