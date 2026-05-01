/**
 * Entity Management Utility
 *
 * Minimal CRUD operations for entities table.
 * All validation handled by database constraints and triggers.
 * Organization scoping ensures data isolation.
 */

import {
  createDbClientFromEnv,
  type DbClient,
  getDb,
  pgBigintArray,
  pgTextArray,
} from '../db/client';
import type { Env } from '../index';
import type { ToolContext } from '../tools/registry';
import { entityLinkMatchSql } from './content-search';
import { type EntityHookContext, getEntityHooks } from './entity-hooks';
import { ToolUserError } from './errors';
import { requireWriteAccess } from './organization-access';
import { RESERVED_ENTITY_TYPES } from './reserved';

interface EntityCreateOptions {
  skipHooks?: boolean;
  hookContext?: EntityHookContext;
}

// ============================================
// Shared Helpers
// ============================================

const CONVENIENCE_FIELDS = [
  'domain',
  'category',
  'platform_type',
  'main_market',
  'market',
  'link',
  'external_ids',
] as const;

/**
 * Merge convenience fields (domain, category, etc.) into a metadata object.
 * For creates, uses truthiness; for updates, uses `!== undefined` to allow clearing fields.
 */
function mergeConvenienceFields(
  data: Partial<EntityData>,
  base: Record<string, any>,
  mode: 'create' | 'update'
): Record<string, any> {
  const out = { ...base };
  for (const key of CONVENIENCE_FIELDS) {
    const value = data[key];
    if (mode === 'update') {
      if (value !== undefined) out[key] = value;
    } else if (key === 'external_ids') {
      if (value && typeof value === 'object' && Object.keys(value).length > 0) {
        out[key] = value;
      }
    } else if (value) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Convert a numeric embedding array to a PostgreSQL vector literal.
 */
export function toVectorLiteral(embedding: number[] | null | undefined): string | null {
  if (!embedding || embedding.length === 0) return null;
  return `[${embedding.join(',')}]`;
}

// ============================================
// Type Definitions
// ============================================

export interface EntityData {
  entity_type: string;
  name: string;
  slug?: string; // Auto-generated from name if not provided
  parent_id?: number | null;

  // Organization scoping
  organization_id?: string;

  // Common fields
  enabled_classifiers?: string[] | null;

  // Content & embeddings (used by memory entities and any content-bearing entity)
  content?: string | null;
  embedding?: number[] | null;
  content_hash?: string | null;

  // Metadata - contains all type-specific fields
  metadata?: Record<string, any>;

  // Convenience fields - will be merged into metadata
  domain?: string | null;
  category?: string | null;
  platform_type?: string | null;
  main_market?: string | null;
  external_ids?: Record<string, any>;
  market?: string | null;
  link?: string | null;
}

/**
 * Generate a URL-safe slug from a string.
 * NOTE: duplicated in packages/web/src/lib/url.ts (separate package boundary).
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}

export interface CreatedEntity {
  id: number;
  entity_type: string;
  name: string;
  slug: string;
  parent_id: number | null;
  parent_name?: string | null;
  parent_slug?: string | null;
  parent_entity_type?: string | null;
  metadata?: Record<string, any> | null;
  enabled_classifiers?: string[] | null;
  created_at: Date;
  total_content?: number | null;
  active_connections?: number | null;
  watchers_count?: number | null;
  children_count?: number | null;
  current_view_template_version_id?: number | null;
  warnings?: string[];
}

// ============================================
// Validation Helpers
// ============================================

/**
 * Check for circular parent references in entity hierarchy.
 * Replaces the PostgreSQL `prevent_entity_cycles()` trigger.
 *
 * Walks up the ancestor chain from the proposed parent_id.
 * If we encounter `entityId` as an ancestor, that would create a cycle.
 */
async function preventEntityCycles(
  entityId: number | null,
  parentId: number | null
): Promise<void> {
  if (parentId === null) return;

  const sql = getDb();
  const MAX_DEPTH = 10;
  let currentId: number | null = parentId;
  let depth = 0;

  while (currentId !== null) {
    if ((entityId !== null && currentId === entityId) || ++depth >= MAX_DEPTH) {
      throw new Error('Circular reference detected or hierarchy too deep (max 10 levels)');
    }

    const rows: Array<Record<string, unknown>> = await sql`
      SELECT parent_id FROM entities WHERE id = ${currentId}
    `;
    currentId = rows.length > 0 ? (rows[0].parent_id as number | null) : null;
  }
}

async function loadEntityTreeIds(sql: DbClient, entityId: number): Promise<number[]> {
  const rows = await sql<{ id: number }>`
    WITH RECURSIVE entity_tree AS (
      SELECT id
      FROM entities
      WHERE id = ${entityId}
      UNION ALL
      SELECT e.id
      FROM entities e
      JOIN entity_tree et ON e.parent_id = et.id
    )
    SELECT id
    FROM entity_tree
  `;

  return rows.map((row) => Number(row.id));
}

// ============================================
// CRUD Operations
// ============================================

/**
 * Create new entity
 * Entity is created in the user's organization
 */
export async function createEntity(
  data: EntityData,
  opts?: EntityCreateOptions
): Promise<CreatedEntity> {
  // Input validation
  if (!data.name || data.name.trim().length === 0) {
    throw new Error('Entity name is required');
  }

  if (!data.entity_type || data.entity_type.trim().length === 0) {
    throw new Error('Entity type is required');
  }

  // Check for reserved entity types
  if (RESERVED_ENTITY_TYPES.includes(data.entity_type.toLowerCase())) {
    throw new Error(
      `Cannot create entity with reserved type '${data.entity_type}'. Reserved types: ${RESERVED_ENTITY_TYPES.join(', ')}`
    );
  }

  if (!data.organization_id) {
    throw new Error('Organization ID is required');
  }

  // Run beforeCreate hook
  if (!opts?.skipHooks && opts?.hookContext) {
    const hooks = getEntityHooks(data.entity_type);
    if (hooks?.beforeCreate) {
      data = await hooks.beforeCreate(data, opts.hookContext);
    }
  }

  const sql = getDb();

  // Resolve entity_type slug → entity_types(id) via the schema search path:
  //   1. The entity's own org (the user's tenant — local types win).
  //   2. Any org with visibility='public' (canonical/world-knowledge catalogs).
  // First match wins. The resolved id is materialized on the row so reads
  // never need to repeat the search. `ORDER BY (et.organization_id = own_org)
  // DESC` keeps tenant-local types ahead of public ones when both exist.
  //
  // KNOWN LIMITATION: this trusts every visibility='public' org as a curated
  // catalog. If a tenant can flip their own org public *and* register types
  // before another tenant references the same slug, they could squat on
  // common slugs (`brand`, `tax_filing`). Operationally we restrict
  // visibility flips to admins; long-term the right fix is either an
  // explicit `is_catalog` flag on `organization` or per-agent `uses_catalog`
  // declarations narrowing the search scope.
  const typeRow = await sql<{ id: number }>`
    SELECT et.id
    FROM entity_types et
    LEFT JOIN organization o ON o.id = et.organization_id
    WHERE et.slug = ${data.entity_type}
      AND et.deleted_at IS NULL
      AND (
        et.organization_id = ${data.organization_id}
        OR o.visibility = 'public'
      )
    ORDER BY (et.organization_id = ${data.organization_id}) DESC, et.id ASC
    LIMIT 1
  `;
  if (typeRow.length === 0) {
    throw new ToolUserError(
      `Unknown entity type '${data.entity_type}'. Use manage_entity_schema(schema_type="entity_type", action="list") to list available types or create a custom type first.`,
      400
    );
  }
  const entityTypeId = typeRow[0].id;

  // Generate slug from name if not provided
  const slug = data.slug || generateSlug(data.name);

  const metadata = mergeConvenienceFields(data, data.metadata || {}, 'create');

  const createdBy = (data as any).created_by || 'system';

  // Validate parent hierarchy (replaces prevent_entity_cycles trigger)
  if (data.parent_id) {
    await preventEntityCycles(null, data.parent_id);
  }

  const contentValue = data.content?.trim() || null;
  const embeddingLiteral = toVectorLiteral(data.embedding);
  const contentHash = data.content_hash || null;

  try {
    const result = await sql<Omit<CreatedEntity, 'entity_type'>>`
      INSERT INTO entities (
        organization_id, entity_type_id, name, slug, parent_id, metadata, enabled_classifiers, created_by, content, embedding, content_hash, created_at, updated_at
      ) VALUES (
        ${data.organization_id}, ${entityTypeId}, ${data.name.trim()}, ${slug}, ${data.parent_id || null},
        ${sql.json(metadata)}, ${data.enabled_classifiers || null}, ${createdBy},
        ${contentValue}, ${embeddingLiteral}::vector, ${contentHash}, current_timestamp, current_timestamp
      )
      RETURNING id, name, slug, parent_id, metadata, created_at
    `;

    if (result.length === 0) {
      throw new Error('Failed to create entity');
    }

    // The validator above already resolved data.entity_type → entityTypeId.
    // Pass the slug back through directly rather than JOIN-ing on every insert.
    const created: CreatedEntity = { ...result[0], entity_type: data.entity_type };

    // Run afterCreate hook
    if (!opts?.skipHooks && opts?.hookContext) {
      const hooks = getEntityHooks(created.entity_type);
      if (hooks?.afterCreate) {
        await hooks.afterCreate(created, opts.hookContext);
      }
    }

    return created;
  } catch (error: any) {
    const msg = error.message ?? '';

    // Handle database constraint violations
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      throw new Error('Entity already exists with this name/domain');
    }
    if (msg.includes('foreign key')) {
      throw new Error(`Parent entity ${data.parent_id} does not exist`);
    }
    if (msg.includes('check constraint')) {
      throw new Error(`Invalid entity data: ${msg}`);
    }
    if (msg.includes('Circular reference')) {
      throw new Error('Cannot create circular entity hierarchy');
    }
    throw error;
  }
}

/**
 * Update existing entity
 * Database handles validation
 * Requires write access (entity must belong to user's organization)
 */
export async function updateEntity(
  entityId: number,
  data: Partial<EntityData>,
  env: Env,
  ctx: ToolContext
): Promise<CreatedEntity> {
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();

  // Validate write access (uses PG for auth tables)
  await requireWriteAccess(pgSql, entityId, ctx);

  // Validate parent hierarchy (replaces prevent_entity_cycles trigger)
  if (data.parent_id !== undefined && data.parent_id !== null) {
    await preventEntityCycles(entityId, data.parent_id);
  }

  // Generate new slug if provided or name is being updated
  const newSlug = data.slug ?? (data.name ? generateSlug(data.name) : null);

  const metadataUpdates = mergeConvenienceFields(data, data.metadata ?? {}, 'update');
  const hasMetadataUpdates = Object.keys(metadataUpdates).length > 0;

  // First get the current entity so we can merge metadata
  const current = await sql`
    SELECT metadata FROM entities WHERE id = ${entityId} AND deleted_at IS NULL
  `;
  if (current.length === 0) {
    throw new Error(`Entity ${entityId} not found`);
  }

  // Merge metadata in TypeScript
  let mergedMetadata: Record<string, unknown> | null = null;
  if (hasMetadataUpdates) {
    const existing =
      typeof current[0].metadata === 'string'
        ? JSON.parse(current[0].metadata as string)
        : (current[0].metadata ?? {});
    mergedMetadata = { ...existing, ...metadataUpdates };
  }

  const hasContent = data.content !== undefined;
  const contentValue = data.content?.trim() || null;
  const hasEmbedding = data.embedding !== undefined;
  const embeddingLiteral = toVectorLiteral(data.embedding);

  await sql`
    UPDATE entities SET
      name = COALESCE(${data.name ?? null}, name),
      slug = COALESCE(${newSlug}, slug),
      parent_id = CASE WHEN ${data.parent_id !== undefined} THEN ${data.parent_id ?? null}::bigint ELSE parent_id END,
      metadata = CASE WHEN ${hasMetadataUpdates} THEN ${mergedMetadata ? sql.json(mergedMetadata) : null} ELSE metadata END,
      enabled_classifiers = CASE WHEN ${data.enabled_classifiers !== undefined} THEN ${data.enabled_classifiers ?? null}::text[] ELSE enabled_classifiers END,
      content = CASE WHEN ${hasContent} THEN ${contentValue} ELSE content END,
      embedding = CASE WHEN ${hasEmbedding} THEN ${embeddingLiteral}::vector ELSE embedding END,
      updated_at = current_timestamp
    WHERE id = ${entityId} AND deleted_at IS NULL
  `;

  const result = await sql<CreatedEntity>`
    SELECT e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId}
    LIMIT 1
  `;

  if (result.length === 0) {
    throw new Error(`Entity ${entityId} not found`);
  }

  return result[0];
}

/**
 * Get entity by ID
 * Only returns entity if user has read access (own org or public)
 */
export async function getEntity(
  entityId: number,
  _env: Env,
  ctx: ToolContext
): Promise<CreatedEntity | null> {
  const sql = getDb();
  if (!ctx.organizationId) return null;

  // Operational counts always scope to the caller's org. When `e` is a
  // public-catalog entity, totals reflect the caller's events/feeds/watchers/
  // children that reference it — never cross-tenant activity around the
  // public row.
  //
  // Visibility branches checked here:
  //   1. caller's own org (always readable)
  //   2. public-catalog entity (anyone reads, except `$member`)
  const result = await sql<CreatedEntity>`
    SELECT
      e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at,
      e.current_view_template_version_id,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type,
      (
        SELECT COUNT(*) FROM current_event_records ev
        WHERE ${sql.unsafe(entityLinkMatchSql('e.id::bigint', 'ev'))}
          AND ev.organization_id = ${ctx.organizationId}
      ) as total_content,
      (
        SELECT COUNT(DISTINCT c.connector_key)
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id
        WHERE e.id = ANY(f.entity_ids)
          AND f.organization_id = ${ctx.organizationId}
          AND f.deleted_at IS NULL
          AND c.deleted_at IS NULL
      ) as active_connections,
      (
        SELECT COUNT(*) FROM watchers i
        WHERE e.id = ANY(i.entity_ids)
          AND i.organization_id = ${ctx.organizationId}
      ) as watchers_count,
      (
        SELECT COUNT(*) FROM entities c
        WHERE c.parent_id = e.id
          AND c.organization_id = ${ctx.organizationId}
          AND c.deleted_at IS NULL
      ) as children_count
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    LEFT JOIN organization eo ON eo.id = e.organization_id
    WHERE e.id = ${entityId}
      AND (
        e.organization_id = ${ctx.organizationId}
        OR (eo.visibility = 'public' AND et.slug <> '$member')
      )
      AND e.deleted_at IS NULL
  `;

  return result.length > 0 ? result[0] : null;
}

/**
 * Delete entity
 * Soft delete by default (sets deleted_at), hard delete with force=true.
 * Requires write access (entity must belong to user's organization)
 */
export async function deleteEntity(
  entityId: number,
  force: boolean = false,
  env: Env,
  ctx: ToolContext,
  opts?: { skipHooks?: boolean }
): Promise<{ message: string; deleted: number }> {
  const pgSql = createDbClientFromEnv(env);
  const sql = getDb();

  // Validate write access (uses PG for auth tables)
  await requireWriteAccess(pgSql, entityId, ctx);

  // Run beforeDelete hook
  if (!opts?.skipHooks) {
    const entityRow = await sql`
      SELECT et.slug AS entity_type, e.metadata
      FROM entities e
      JOIN entity_types et ON et.id = e.entity_type_id
      WHERE e.id = ${entityId} AND e.deleted_at IS NULL
    `;
    if (entityRow.length > 0) {
      const hooks = getEntityHooks(entityRow[0].entity_type as string);
      if (hooks?.beforeDelete) {
        await hooks.beforeDelete(
          {
            id: entityId,
            entity_type: entityRow[0].entity_type as string,
            metadata: entityRow[0].metadata as Record<string, unknown> | null,
          },
          { organizationId: ctx.organizationId, userId: ctx.userId }
        );
      }
    }
  }

  // Check if entity has children
  if (!force) {
    const children = await sql`
      SELECT COUNT(*) as count
      FROM entities
      WHERE parent_id = ${entityId}
        AND deleted_at IS NULL
    `;

    const childCount = Number(children[0]?.count || 0);
    if (childCount > 0) {
      throw new Error(
        `Cannot delete entity: it has ${childCount} child entities. Use force_delete_tree=true to delete the entire hierarchy.`
      );
    }
  }

  if (force) {
    const entityTreeIds = await loadEntityTreeIds(sql, entityId);
    const entityTreeIdsLiteral = pgBigintArray(entityTreeIds);

    const eventHistory = await sql`
      SELECT COUNT(*) as count
      FROM current_event_records ev
      WHERE ev.entity_ids && ${entityTreeIdsLiteral}::bigint[]
    `;

    const eventCount = Number(eventHistory[0]?.count || 0);
    if (eventCount > 0) {
      throw new Error(
        `Cannot hard delete entity tree: ${eventCount} event rows reference this entity tree. Soft delete the entity instead to preserve event history.`
      );
    }

    await sql.begin(async (tx) => {
      await tx`
        DELETE FROM entity_relationships
        WHERE from_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
           OR to_entity_id = ANY(${entityTreeIdsLiteral}::bigint[])
      `;

      await tx`
        DELETE FROM watcher_window_events
        WHERE window_id IN (
          SELECT ww.id
          FROM watcher_windows ww
          JOIN watchers w ON ww.watcher_id = w.id
          WHERE COALESCE(w.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
        )
      `;
      await tx`
        DELETE FROM watcher_windows
        WHERE watcher_id IN (
          SELECT id
          FROM watchers
          WHERE COALESCE(entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
        )
      `;
      // Before hard-deleting watchers: if any of those rows are group roots
      // (id = watcher_group_id) with surviving siblings, transfer ownership
      // of the shared watcher_versions chain to a sibling so the upcoming
      // ON DELETE CASCADE doesn't wipe out the version row that the rest
      // of the group still depends on.
      await tx`
        UPDATE watcher_versions wv
        SET watcher_id = s.new_root
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND COALESCE(w.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[])
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE wv.watcher_id = s.old_root
      `;
      await tx`
        UPDATE watchers w
        SET watcher_group_id = s.new_root,
            source_watcher_id = CASE WHEN w.source_watcher_id = s.old_root THEN s.new_root ELSE w.source_watcher_id END
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND COALESCE(w.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND NOT (COALESCE(s.entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[])
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE w.watcher_group_id = s.old_root
      `;
      await tx`
        DELETE FROM watchers
        WHERE COALESCE(entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
      `;
      await tx`
        UPDATE watchers
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(COALESCE(entity_ids, '{}'::bigint[])) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;
      await tx`
        DELETE FROM watcher_window_events
        WHERE window_id IN (
          SELECT ww.id
          FROM watcher_windows ww
          JOIN watchers w ON ww.watcher_id = w.id
          WHERE cardinality(COALESCE(w.entity_ids, '{}'::bigint[])) = 0
        )
      `;
      await tx`
        DELETE FROM watcher_windows
        WHERE watcher_id IN (
          SELECT id
          FROM watchers
          WHERE cardinality(COALESCE(entity_ids, '{}'::bigint[])) = 0
        )
      `;
      // Same group-root ownership transfer as above — predicate here is
      // "now-orphaned watcher rows" (entity_ids is empty after the array
      // pruning a few statements up).
      await tx`
        UPDATE watcher_versions wv
        SET watcher_id = s.new_root
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND cardinality(COALESCE(w.entity_ids, '{}'::bigint[])) = 0
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND cardinality(COALESCE(s.entity_ids, '{}'::bigint[])) > 0
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE wv.watcher_id = s.old_root
      `;
      await tx`
        UPDATE watchers w
        SET watcher_group_id = s.new_root,
            source_watcher_id = CASE WHEN w.source_watcher_id = s.old_root THEN s.new_root ELSE w.source_watcher_id END
        FROM (
          SELECT r.old_root, MIN(s.id) AS new_root
          FROM (
            SELECT w.id AS old_root
            FROM watchers w
            WHERE w.id = w.watcher_group_id
              AND cardinality(COALESCE(w.entity_ids, '{}'::bigint[])) = 0
          ) r
          JOIN watchers s
            ON s.watcher_group_id = r.old_root
           AND s.id <> r.old_root
           AND cardinality(COALESCE(s.entity_ids, '{}'::bigint[])) > 0
           AND NOT EXISTS (
             SELECT 1 FROM watcher_versions vv WHERE vv.watcher_id = s.id
           )
          GROUP BY r.old_root
        ) s
        WHERE w.watcher_group_id = s.old_root
      `;
      await tx`
        DELETE FROM watchers
        WHERE cardinality(COALESCE(entity_ids, '{}'::bigint[])) = 0
      `;

      await tx`
        DELETE FROM feeds
        WHERE COALESCE(entity_ids, '{}'::bigint[]) <@ ${entityTreeIdsLiteral}::bigint[]
      `;
      await tx`
        UPDATE feeds
        SET entity_ids = ARRAY(
          SELECT linked_id
          FROM unnest(COALESCE(entity_ids, '{}'::bigint[])) AS linked_id
          WHERE NOT (linked_id = ANY(${entityTreeIdsLiteral}::bigint[]))
        )
        WHERE entity_ids && ${entityTreeIdsLiteral}::bigint[]
      `;
      await tx`
        DELETE FROM feeds
        WHERE cardinality(COALESCE(entity_ids, '{}'::bigint[])) = 0
      `;

      await tx`
        DELETE FROM entities
        WHERE id = ANY(${entityTreeIdsLiteral}::bigint[])
      `;
    });

    return {
      message: 'Entity and all descendants deleted successfully',
      deleted: entityTreeIds.length,
    };
  }

  // Soft delete: set deleted_at timestamp
  await sql`
    UPDATE entities
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE id = ${entityId} AND deleted_at IS NULL
  `;

  return {
    message: 'Entity soft-deleted successfully',
    deleted: 1,
  };
}

/**
 * List entities with filters
 * Uses dynamic query fragments for scoped filtering
 * Only returns entities from readable organizations (user's org + public)
 */
export async function listEntities(
  filters: {
    entity_type?: string;
    parent_id?: number | null;
    search?: string;
    category?: string;
    main_market?: string;
    market?: string;
    limit?: number;
    offset?: number;
    sort_by?: string;
    sort_order?: 'asc' | 'desc';
  },
  _env: Env,
  ctx: ToolContext
): Promise<{
  entities: CreatedEntity[];
  hasMore: boolean;
  totalCount: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}> {
  const sql = getDb();
  const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);

  if (!ctx.organizationId) {
    return {
      entities: [],
      hasMore: false,
      totalCount: 0,
      limit,
      offset,
      sortBy: filters.sort_by ?? 'created_at',
      sortOrder: filters.sort_order === 'asc' ? 'asc' : 'desc',
    };
  }

  const conditions: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  let paramIdx = 1;

  // Organization filter
  conditions.push(`e.organization_id = $${paramIdx++}`);
  params.push(ctx.organizationId);

  if (filters.entity_type) {
    conditions.push(`et.slug = $${paramIdx++}`);
    params.push(filters.entity_type);
  }

  if (filters.parent_id !== undefined) {
    if (filters.parent_id === null) {
      conditions.push('e.parent_id IS NULL');
    } else {
      conditions.push(`e.parent_id = $${paramIdx++}`);
      params.push(filters.parent_id);
    }
  }

  if (filters.search) {
    conditions.push(`(e.name ILIKE $${paramIdx} OR e.metadata->>'domain' ILIKE $${paramIdx})`);
    params.push(`%${filters.search}%`);
    paramIdx++;
  }

  if (filters.category) {
    conditions.push(`e.metadata->>'category' = $${paramIdx++}`);
    params.push(filters.category);
  }

  if (filters.main_market) {
    conditions.push(`e.metadata->>'main_market' = $${paramIdx++}`);
    params.push(filters.main_market);
  }

  if (filters.market) {
    conditions.push(`e.metadata->>'market' = $${paramIdx++}`);
    params.push(filters.market);
  }

  const whereClause = conditions.join(' AND ');

  const sortColumnMap: Record<string, string> = {
    name: 'e.name',
    created_at: 'e.created_at',
    total_content: 'total_content',
    active_connections: 'active_connections',
    watchers_count: 'watchers_count',
    children_count: 'children_count',
  };

  const sortBy = filters.sort_by && sortColumnMap[filters.sort_by] ? filters.sort_by : 'created_at';
  const normalizedSortOrder = filters.sort_order === 'asc' ? 'asc' : 'desc';
  const sortOrderSql = normalizedSortOrder === 'asc' ? 'ASC' : 'DESC';
  const orderBy = `${sortColumnMap[sortBy]} ${sortOrderSql}, e.id ASC`;

  const baseQuery = `
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    LEFT JOIN entities pe ON e.parent_id = pe.id
    LEFT JOIN entity_types pet ON pet.id = pe.entity_type_id
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM current_event_records ev WHERE ${entityLinkMatchSql('e.id::bigint', 'ev')}) tc ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT c.connector_key) as cnt
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE e.id = ANY(f.entity_ids)
        AND f.deleted_at IS NULL
        AND c.deleted_at IS NULL
    ) ac ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM watchers i WHERE e.id = ANY(i.entity_ids)) ic ON true
    LEFT JOIN LATERAL (SELECT COUNT(*) as cnt FROM entities c WHERE c.parent_id = e.id) cc ON true
    WHERE ${whereClause}
  `;

  const totalCountResult = await sql.unsafe<{ total_count: number }>(
    `SELECT CAST(COUNT(*) AS INTEGER) as total_count ${baseQuery}`,
    params
  );

  const result = await sql.unsafe<CreatedEntity>(
    `SELECT
      e.id, et.slug AS entity_type, e.name, e.slug, e.parent_id, e.metadata, e.created_at,
      COALESCE(tc.cnt, 0) as total_content,
      COALESCE(ac.cnt, 0) as active_connections,
      COALESCE(ic.cnt, 0) as watchers_count,
      COALESCE(cc.cnt, 0) as children_count,
      pe.name as parent_name, pe.slug as parent_slug, pet.slug as parent_entity_type
    ${baseQuery}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
    OFFSET ${offset}`,
    params
  );

  const hasMore = result.length > limit;
  const entities = hasMore
    ? (result.slice(0, limit) as unknown as CreatedEntity[])
    : (result as unknown as CreatedEntity[]);

  const totalCount = Number(totalCountResult[0]?.total_count || 0);

  return { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder: normalizedSortOrder };
}

// ============================================
// Relationship Batch Loading
// ============================================

export interface RelationshipColumnSpec {
  relationship_type: string;
  direction?: 'outbound' | 'inbound' | 'both';
  label: string;
}

interface RelatedEntityInfo {
  id: number;
  name: string;
  slug: string;
  entity_type: string;
}

export async function batchLoadRelationships(
  entityIds: number[],
  specs: RelationshipColumnSpec[],
  organizationId: string
): Promise<Map<number, Record<string, RelatedEntityInfo[]>>> {
  const result = new Map<number, Record<string, RelatedEntityInfo[]>>();
  if (entityIds.length === 0 || specs.length === 0) return result;

  const sql = getDb();
  const typeSlugs = pgTextArray([...new Set(specs.map((s) => s.relationship_type))]);
  const idArray = pgBigintArray(entityIds);

  const rows = await sql`
    SELECT
      r.from_entity_id,
      r.to_entity_id,
      rt.slug AS relationship_type_slug,
      fe.id AS from_id, fe.name AS from_name, fe.slug AS from_slug, fet.slug AS from_entity_type,
      te.id AS to_id, te.name AS to_name, te.slug AS to_slug, tet.slug AS to_entity_type
    FROM entity_relationships r
    JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
    LEFT JOIN entities fe ON r.from_entity_id = fe.id
    LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
    LEFT JOIN entities te ON r.to_entity_id = te.id
    LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
    WHERE r.organization_id = ${organizationId}
      AND r.deleted_at IS NULL
      AND rt.slug = ANY(${typeSlugs}::text[])
      AND (r.from_entity_id = ANY(${idArray}) OR r.to_entity_id = ANY(${idArray}))
  `;

  // Build a direction lookup per spec
  const specByType = new Map<string, 'outbound' | 'inbound' | 'both'>();
  for (const spec of specs) {
    specByType.set(spec.relationship_type, spec.direction ?? 'both');
  }

  for (const row of rows) {
    const relType = row.relationship_type_slug as string;
    const direction = specByType.get(relType) ?? 'both';
    const fromId = Number(row.from_entity_id);
    const toId = Number(row.to_entity_id);

    const pairs: Array<[number, RelatedEntityInfo]> = [];

    if ((direction === 'outbound' || direction === 'both') && entityIds.includes(fromId)) {
      pairs.push([
        fromId,
        {
          id: Number(row.to_id),
          name: row.to_name as string,
          slug: row.to_slug as string,
          entity_type: row.to_entity_type as string,
        },
      ]);
    }
    if ((direction === 'inbound' || direction === 'both') && entityIds.includes(toId)) {
      pairs.push([
        toId,
        {
          id: Number(row.from_id),
          name: row.from_name as string,
          slug: row.from_slug as string,
          entity_type: row.from_entity_type as string,
        },
      ]);
    }

    for (const [entityId, related] of pairs) {
      let record = result.get(entityId);
      if (!record) {
        record = {};
        result.set(entityId, record);
      }
      if (!record[relType]) record[relType] = [];
      // Deduplicate by related entity id
      if (!record[relType].some((r) => r.id === related.id)) {
        record[relType].push(related);
      }
    }
  }

  return result;
}
