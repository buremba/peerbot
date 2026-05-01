/**
 * Tool: manage_entity_schema
 *
 * Unified management for entity type definitions and relationship type definitions.
 * Uses `schema_type` discriminator to select between 'entity_type' and 'relationship_type'.
 *
 * Entity Type Actions: list, get, create, update, delete, audit
 * Relationship Type Actions: list, get, create, update, delete, add_rule, remove_rule, list_rules
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AutoCreateWhenRule } from '@lobu/connector-sdk';
import { type DbClient, getDb } from '../../db/client';
import type { Env } from '../../index';
import logger from '../../utils/logger';
import { compileRulesMetadata, ruleHashFor } from '../../identity/rules';
import { ensureMemberEntityType } from '../../utils/member-entity-type';
import { RESERVED_ENTITY_TYPES } from '../../utils/reserved';
import { resolveUsernames } from '../../utils/resolve-usernames';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';

// ============================================
// Typebox Schema
// ============================================

const AutoCreateWhenRuleInputSchema = Type.Object(
  {
    sourceNamespace: Type.String({ minLength: 1 }),
    targetField: Type.String({ minLength: 1 }),
    assuranceRequired: Type.Union([
      Type.Literal('oauth_verified_admin_role'),
      Type.Literal('oauth_verified'),
      Type.Literal('cookie_session'),
      Type.Literal('self_attested'),
    ]),
    matchStrategy: Type.Union([Type.Literal('unique_only'), Type.Literal('all_matches')]),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);

export const ManageEntitySchemaSchema = Type.Object({
  schema_type: Type.Union([Type.Literal('entity_type'), Type.Literal('relationship_type')], {
    description: 'Whether to manage entity types or relationship types',
  }),

  action: Type.Union(
    [
      // Shared actions
      Type.Literal('list'),
      Type.Literal('get'),
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('delete'),
      // Entity type only
      Type.Literal('audit'),
      // Relationship type only
      Type.Literal('add_rule'),
      Type.Literal('remove_rule'),
      Type.Literal('list_rules'),
    ],
    { description: 'Action to perform' }
  ),

  // Identification
  slug: Type.Optional(
    Type.String({
      description: '[get/create/update/delete/audit/add_rule/remove_rule/list_rules] Type slug',
      minLength: 1,
    })
  ),

  // Shared create/update fields
  name: Type.Optional(Type.String({ description: '[create/update] Display name', minLength: 1 })),
  description: Type.Optional(Type.String({ description: '[create/update] Description' })),
  metadata_schema: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: '[create/update] JSON Schema for metadata validation',
    })
  ),

  // Entity type fields
  icon: Type.Optional(Type.String({ description: '[entity_type: create/update] Emoji or icon' })),
  color: Type.Optional(
    Type.String({ description: '[entity_type: create/update] Color for UI display' })
  ),
  event_kinds: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Object({
        description: Type.Optional(Type.String()),
        metadataSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      {
        description:
          '[entity_type: create/update] Event semantic types this type produces, keyed by semantic_type slug. Each entry can have a description and optional metadataSchema (JSON Schema).',
      }
    )
  ),

  // Relationship type fields
  is_symmetric: Type.Optional(
    Type.Boolean({
      description:
        '[relationship_type: create] Whether the relationship is symmetric (A↔B = B↔A). Default false.',
    })
  ),
  inverse_type_slug: Type.Optional(
    Type.String({
      description:
        '[relationship_type: create/update] Slug of the inverse relationship type (e.g., "depends_on" ↔ "dependency_of")',
    })
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('active'), Type.Literal('archived')], {
      description: '[relationship_type: create/update] Status. Default active.',
    })
  ),
  auto_create_when: Type.Optional(
    Type.Array(AutoCreateWhenRuleInputSchema, {
      maxItems: 16,
      description:
        '[relationship_type: create/update] Identity-engine auto-derivation rules stored on relationship_type.metadata.autoCreateWhen',
    })
  ),

  // Rule fields (relationship_type only)
  source_entity_type_slug: Type.Optional(
    Type.String({ description: '[relationship_type: add_rule] Source entity type slug' })
  ),
  target_entity_type_slug: Type.Optional(
    Type.String({ description: '[relationship_type: add_rule] Target entity type slug' })
  ),
  rule_id: Type.Optional(
    Type.Number({ description: '[relationship_type: remove_rule] Rule ID to remove' })
  ),

  // List filters
  include_deleted: Type.Optional(
    Type.Boolean({ description: '[relationship_type: list] Include soft-deleted types' })
  ),
});

type ManageEntitySchemaArgs = Static<typeof ManageEntitySchemaSchema>;

// ============================================
// Result Types
// ============================================

interface EntityTypeRow {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  metadata_schema?: Record<string, unknown> | null;
  event_kinds?: Record<string, unknown> | null;
  is_system: boolean;
  created_by?: string | null;
  organization_id?: string | null;
  organization_slug?: string | null;
  created_at: Date;
  updated_at: Date;
  entity_count?: number;
  current_view_template_version_id?: number | null;
}

interface AuditEntry {
  id: number;
  entity_type_id: number;
  action: string;
  actor: string | null;
  before_payload: Record<string, unknown> | null;
  after_payload: Record<string, unknown> | null;
  created_at: string;
}

interface RelationshipTypeRow {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  organization_id?: string | null;
  organization_slug?: string | null;
  created_by?: string | null;
  metadata_schema?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  is_symmetric: boolean;
  inverse_type_id?: number | null;
  inverse_type_slug?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  relationship_count?: number;
}

interface RelationshipTypeRuleRow {
  id: number;
  relationship_type_id: number;
  source_entity_type_slug: string;
  target_entity_type_slug: string;
  created_at: string;
}

type ManageEntitySchemaResult =
  // Entity type results
  | { schema_type: 'entity_type'; action: 'list'; entity_types: EntityTypeRow[] }
  | { schema_type: 'entity_type'; action: 'get'; entity_type: EntityTypeRow | null }
  | { schema_type: 'entity_type'; action: 'create'; entity_type: EntityTypeRow }
  | { schema_type: 'entity_type'; action: 'update'; entity_type: EntityTypeRow }
  | { schema_type: 'entity_type'; action: 'delete'; success: boolean; message: string }
  | { schema_type: 'entity_type'; action: 'audit'; audit_entries: AuditEntry[] }
  // Relationship type results
  | { schema_type: 'relationship_type'; action: 'list'; relationship_types: RelationshipTypeRow[] }
  | {
      schema_type: 'relationship_type';
      action: 'get';
      relationship_type: RelationshipTypeRow | null;
    }
  | { schema_type: 'relationship_type'; action: 'create'; relationship_type: RelationshipTypeRow }
  | { schema_type: 'relationship_type'; action: 'update'; relationship_type: RelationshipTypeRow }
  | { schema_type: 'relationship_type'; action: 'delete'; success: boolean; message: string }
  | { schema_type: 'relationship_type'; action: 'add_rule'; rule: RelationshipTypeRuleRow }
  | { schema_type: 'relationship_type'; action: 'remove_rule'; success: boolean; message: string }
  | { schema_type: 'relationship_type'; action: 'list_rules'; rules: RelationshipTypeRuleRow[] };

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageEntitySchema(
  args: ManageEntitySchemaArgs,
  _env: Env,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (args.schema_type === 'entity_type') {
    return routeAction('manage_entity_schema', args.action, ctx, {
      list: () => etHandleList(ctx),
      get: () => etHandleGet(args.slug, ctx),
      create: () => etHandleCreate(args, ctx),
      update: () => etHandleUpdate(args, ctx),
      delete: () => etHandleDelete(args.slug, ctx),
      audit: () => etHandleAudit(args.slug, ctx),
    });
  }

  return routeAction('manage_entity_schema', args.action, ctx, {
    list: () => rtHandleList(args, ctx),
    get: () => rtHandleGet(args, ctx),
    create: () => rtHandleCreate(args, ctx),
    update: () => rtHandleUpdate(args, ctx),
    delete: () => rtHandleDelete(args, ctx),
    add_rule: () => rtHandleAddRule(args, ctx),
    remove_rule: () => rtHandleRemoveRule(args, ctx),
    list_rules: () => rtHandleListRules(args, ctx),
  });
}

// ============================================
// Entity Type Helpers
// ============================================

const ENTITY_TYPE_COLUMNS =
  'id, slug, name, description, icon, color, metadata_schema, event_kinds, created_by, organization_id, created_at, updated_at, current_view_template_version_id';

const ENTITY_TYPE_COLUMNS_WITH_ORG = `et.id, et.slug, et.name, et.description, et.icon, et.color,
  et.metadata_schema, et.event_kinds, et.created_by, et.organization_id,
  et.created_at, et.updated_at, et.current_view_template_version_id,
  o.slug AS organization_slug`;

function mapRowToEntityType(row: Record<string, unknown>): EntityTypeRow {
  return {
    ...(row as unknown as EntityTypeRow),
    is_system: row.created_by === null || row.created_by === undefined,
    entity_count: Number(row.entity_count) || 0,
  };
}

function validateEntityMetadataSchemaDisplayConfig(
  metadataSchema: Record<string, unknown> | undefined
): void {
  if (!metadataSchema || typeof metadataSchema !== 'object' || Array.isArray(metadataSchema)) {
    return;
  }

  const properties = metadataSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return;
  }

  let tableColumnCount = 0;

  for (const [field, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue;

    const tableColumn = (prop as Record<string, unknown>)['x-table-column'];
    if (tableColumn === true) {
      tableColumnCount += 1;
    } else if (tableColumn !== undefined && typeof tableColumn !== 'boolean') {
      throw new Error(`metadata_schema.properties.${field}.x-table-column must be a boolean`);
    }

    const tableLabel = (prop as Record<string, unknown>)['x-table-label'];
    if (tableLabel !== undefined && typeof tableLabel !== 'string') {
      throw new Error(`metadata_schema.properties.${field}.x-table-label must be a string`);
    }
  }

  if (tableColumnCount > 4) {
    throw new Error('At most 4 metadata fields can have x-table-column=true.');
  }
}

async function getEntityCountsByType(organizationId: string): Promise<Map<number, number>> {
  const sql = getDb();
  const rows = await sql`
    SELECT e.entity_type_id AS entity_type_id, COUNT(*)::int as entity_count
    FROM entities e
    WHERE e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
    GROUP BY e.entity_type_id
  `;
  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(Number(row.entity_type_id), Number(row.entity_count));
  }
  return counts;
}

async function getEntityCountForType(typeId: number, organizationId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT COUNT(*)::int as count
    FROM entities e
    WHERE e.entity_type_id = ${typeId}
      AND e.organization_id = ${organizationId}
      AND e.deleted_at IS NULL
  `;
  return Number(rows[0]?.count || 0);
}

async function recordAudit(
  sql: DbClient,
  entityTypeId: number,
  action: 'create' | 'update' | 'delete',
  actor: string | null,
  beforePayload: Record<string, unknown> | null,
  afterPayload: Record<string, unknown> | null
): Promise<void> {
  try {
    await sql`
      INSERT INTO entity_type_audit (entity_type_id, action, actor, before_payload, after_payload, created_at)
      VALUES (${entityTypeId}, ${action}, ${actor}, ${beforePayload ? sql.json(beforePayload) : null}, ${afterPayload ? sql.json(afterPayload) : null}, current_timestamp)
    `;
  } catch (err) {
    logger.warn({ err, entityTypeId, action }, 'Failed to record entity_type audit entry');
  }
}

// ============================================
// Entity Type Action Handlers
// ============================================

async function etHandleList(ctx: ToolContext): Promise<ManageEntitySchemaResult> {
  const sql = getDb();

  const rows = await sql.unsafe(
    `SELECT ${ENTITY_TYPE_COLUMNS_WITH_ORG}
     FROM entity_types et
     LEFT JOIN organization o ON o.id = et.organization_id
     WHERE et.deleted_at IS NULL
       AND (et.organization_id = $1 OR o.visibility = 'public')
     ORDER BY (et.organization_id = $1) DESC, et.name ASC`,
    [ctx.organizationId]
  );

  const counts = await getEntityCountsByType(ctx.organizationId);
  const resolved = await resolveUsernames(
    rows as unknown as Record<string, unknown>[],
    'created_by'
  );

  const entityTypes = resolved.map((row) => {
    const mapped = mapRowToEntityType(row);
    mapped.entity_count = counts.get(mapped.id) || 0;
    return mapped;
  });

  entityTypes.sort((a, b) => {
    const aLocal = a.organization_id === ctx.organizationId ? 0 : 1;
    const bLocal = b.organization_id === ctx.organizationId ? 0 : 1;
    if (aLocal !== bLocal) return aLocal - bLocal;
    const countDiff = (b.entity_count || 0) - (a.entity_count || 0);
    if (countDiff !== 0) return countDiff;
    return a.name.localeCompare(b.name);
  });

  return { schema_type: 'entity_type', action: 'list', entity_types: entityTypes };
}

async function etHandleGet(
  slug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!slug) throw new Error('slug is required for get action');

  const sql = getDb();
  const fetchRow = () =>
    sql.unsafe(
      `SELECT ${ENTITY_TYPE_COLUMNS_WITH_ORG}
       FROM entity_types et
       LEFT JOIN organization o ON o.id = et.organization_id
       WHERE et.slug = $1
         AND et.deleted_at IS NULL
         AND (et.organization_id = $2 OR o.visibility = 'public')
       ORDER BY (et.organization_id = $2) DESC, et.id ASC
       LIMIT 1`,
      [slug, ctx.organizationId]
    );

  let rows = await fetchRow();

  // $member is per-tenant: if the resolved row is cross-org (or missing), provision in the caller's org.
  const needsMemberProvision =
    slug === '$member' &&
    (rows.length === 0 || rows[0].organization_id !== ctx.organizationId);
  if (needsMemberProvision) {
    await ensureMemberEntityType(ctx.organizationId);
    rows = await fetchRow();
  }

  if (rows.length === 0) {
    return { schema_type: 'entity_type', action: 'get', entity_type: null };
  }

  const [resolved] = await resolveUsernames([rows[0] as Record<string, unknown>], 'created_by');
  const mapped = mapRowToEntityType(resolved);
  mapped.entity_count = await getEntityCountForType(Number(mapped.id), ctx.organizationId);

  return { schema_type: 'entity_type', action: 'get', entity_type: mapped };
}

async function etHandleCreate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new Error('slug is required for create action');
  if (!args.name) throw new Error('name is required for create action');
  if (!ctx.userId) throw new Error('Authentication required to create entity types');

  if (args.slug.startsWith('$')) {
    throw new Error("Entity type slugs starting with '$' are reserved for system types");
  }

  const slug = args.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  if (RESERVED_ENTITY_TYPES.includes(slug)) {
    throw new Error(
      `Cannot create entity type with reserved slug '${slug}'. Reserved: ${RESERVED_ENTITY_TYPES.join(', ')}`
    );
  }

  const sql = getDb();

  const existing = await sql`
    SELECT id FROM entity_types
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    throw new Error(`Entity type with slug '${slug}' already exists`);
  }

  validateEntityMetadataSchemaDisplayConfig(args.metadata_schema);

  const metadataSchema = args.metadata_schema ? sql.json(args.metadata_schema) : null;
  const eventKinds = args.event_kinds ? sql.json(args.event_kinds) : null;

  const inserted = await sql`
    INSERT INTO entity_types (
      slug, name, description, icon, color,
      metadata_schema, event_kinds,
      organization_id, created_by,
      created_at, updated_at
    ) VALUES (
      ${slug},
      ${args.name},
      ${args.description ?? null},
      ${args.icon ?? null},
      ${args.color ?? null},
      ${metadataSchema},
      ${eventKinds},
      ${ctx.organizationId},
      ${ctx.userId},
      current_timestamp,
      current_timestamp
    )
    RETURNING ${sql.unsafe(ENTITY_TYPE_COLUMNS)}
  `;

  if (inserted.length === 0) throw new Error('Failed to create entity type');

  const created = mapRowToEntityType(inserted[0] as Record<string, unknown>);
  created.entity_count = 0;

  await recordAudit(
    sql,
    Number(created.id),
    'create',
    ctx.userId,
    null,
    inserted[0] as Record<string, unknown>
  );

  return { schema_type: 'entity_type', action: 'create', entity_type: created };
}

async function etHandleUpdate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new Error('slug is required for update action');
  if (!ctx.userId) throw new Error('Authentication required to update entity types');

  const sql = getDb();

  const existing = await sql`
    SELECT * FROM entity_types
    WHERE slug = ${args.slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length === 0) throw new Error(`Entity type '${args.slug}' not found`);

  const current = existing[0];

  const beforePayload = { ...current } as Record<string, unknown>;
  const hasMetadataSchema = args.metadata_schema !== undefined;
  if (hasMetadataSchema) {
    validateEntityMetadataSchemaDisplayConfig(args.metadata_schema);
  }
  const metadataSchemaJson = hasMetadataSchema
    ? args.metadata_schema
      ? sql.json(args.metadata_schema)
      : null
    : null;
  const hasEventKinds = args.event_kinds !== undefined;
  const eventKindsJson = hasEventKinds && args.event_kinds ? sql.json(args.event_kinds) : null;

  await sql`
    UPDATE entity_types SET
      name = COALESCE(${args.name ?? null}, name),
      description = COALESCE(${args.description ?? null}, description),
      icon = COALESCE(${args.icon ?? null}, icon),
      color = COALESCE(${args.color ?? null}, color),
      metadata_schema = CASE
        WHEN ${hasMetadataSchema} THEN ${metadataSchemaJson}
        ELSE metadata_schema
      END,
      event_kinds = CASE
        WHEN ${hasEventKinds} THEN ${eventKindsJson}
        ELSE event_kinds
      END,
      updated_by = ${ctx.userId},
      updated_at = current_timestamp
    WHERE id = ${current.id}
  `;

  const updated = await sql.unsafe(
    `SELECT ${ENTITY_TYPE_COLUMNS} FROM entity_types WHERE id = $1 LIMIT 1`,
    [current.id]
  );
  if (updated.length === 0) throw new Error(`Entity type '${args.slug}' not found after update`);

  const result = mapRowToEntityType(updated[0] as Record<string, unknown>);
  result.entity_count = await getEntityCountForType(Number(result.id), ctx.organizationId);

  await recordAudit(
    sql,
    Number(current.id),
    'update',
    ctx.userId,
    beforePayload,
    updated[0] as Record<string, unknown>
  );

  return { schema_type: 'entity_type', action: 'update', entity_type: result };
}

async function etHandleDelete(
  slug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!slug) throw new Error('slug is required for delete action');
  if (!ctx.userId) throw new Error('Authentication required to delete entity types');

  const sql = getDb();

  const existing = await sql`
    SELECT * FROM entity_types
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length === 0) throw new Error(`Entity type '${slug}' not found`);

  const current = existing[0];
  const entityCount = await getEntityCountForType(Number(current.id), ctx.organizationId);
  if (entityCount > 0) {
    throw new Error(
      `Cannot delete entity type '${slug}': ${entityCount} entities of this type exist. Remove or reassign them first.`
    );
  }

  await sql`
    UPDATE entity_types SET
      deleted_at = current_timestamp,
      updated_by = ${ctx.userId},
      updated_at = current_timestamp
    WHERE id = ${current.id}
  `;

  await recordAudit(
    sql,
    Number(current.id),
    'delete',
    ctx.userId,
    current as Record<string, unknown>,
    null
  );

  return {
    schema_type: 'entity_type',
    action: 'delete',
    success: true,
    message: `Entity type '${slug}' deleted successfully`,
  };
}

async function etHandleAudit(
  slug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!slug) throw new Error('slug is required for audit action');

  const sql = getDb();

  const existing = await sql.unsafe(
    `SELECT id FROM entity_types
     WHERE slug = $1
       AND deleted_at IS NULL
       AND organization_id = $2
     LIMIT 1`,
    [slug, ctx.organizationId]
  );
  if (existing.length === 0) throw new Error(`Entity type '${slug}' not found`);

  const entityTypeId = existing[0].id;

  const rows = await sql.unsafe(
    `SELECT id, entity_type_id, action, actor, before_payload, after_payload, created_at
     FROM entity_type_audit
     WHERE entity_type_id = $1
     ORDER BY created_at DESC`,
    [entityTypeId]
  );

  const resolvedRows = await resolveUsernames(
    rows as unknown as Record<string, unknown>[],
    'actor'
  );

  const auditEntries: AuditEntry[] = resolvedRows.map((row) => ({
    id: Number(row.id),
    entity_type_id: Number(row.entity_type_id),
    action: row.action as string,
    actor: (row.actor_username as string) || (row.actor as string) || null,
    before_payload: row.before_payload
      ? typeof row.before_payload === 'string'
        ? JSON.parse(row.before_payload)
        : (row.before_payload as Record<string, unknown>)
      : null,
    after_payload: row.after_payload
      ? typeof row.after_payload === 'string'
        ? JSON.parse(row.after_payload)
        : (row.after_payload as Record<string, unknown>)
      : null,
    created_at: String(row.created_at),
  }));

  return { schema_type: 'entity_type', action: 'audit', audit_entries: auditEntries };
}

// ============================================
// Relationship Type Helpers
// ============================================

/**
 * Look up a relationship type by slug.
 *
 * - `mode: 'write'` (default): require the caller's org to own the type. Used
 *   by add_rule / remove_rule / update / delete.
 * - `mode: 'read'`: also resolve types from any visibility=public catalog the
 *   caller can see. Used by list_rules so cross-org public RTs surfaced via
 *   list/get can have their rules read without 403.
 *
 * Tenant-first ordering means a tenant slug shadowing a public slug always
 * wins.
 */
async function requireRelationshipType(
  slug: string | undefined,
  action: string,
  ctx: ToolContext,
  mode: 'read' | 'write' = 'write'
): Promise<{ typeId: number; sql: ReturnType<typeof getDb> }> {
  if (!slug) throw new Error(`slug is required for ${action} action`);

  const sql = getDb();

  if (mode === 'read') {
    const rows = await sql`
      SELECT rt.id
      FROM entity_relationship_types rt
      LEFT JOIN organization o ON o.id = rt.organization_id
      WHERE rt.slug = ${slug}
        AND rt.deleted_at IS NULL
        AND (rt.organization_id = ${ctx.organizationId} OR o.visibility = 'public')
      ORDER BY (rt.organization_id = ${ctx.organizationId}) DESC, rt.id ASC
      LIMIT 1
    `;
    if (rows.length === 0) throw new Error(`Relationship type "${slug}" not found`);
    return { typeId: Number(rows[0].id), sql };
  }

  const existing = await sql`
    SELECT id, organization_id FROM entity_relationship_types
    WHERE slug = ${slug} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) throw new Error(`Relationship type "${slug}" not found`);

  const typeId = Number(existing[0].id);
  const typeOrgId = String(existing[0].organization_id ?? '');

  if (typeOrgId && typeOrgId !== ctx.organizationId) {
    throw new Error('Access denied: relationship type belongs to another organization');
  }

  return { typeId, sql };
}

function buildRelationshipIdentityMetadata(
  rules: AutoCreateWhenRule[] | undefined,
  existingMetadata: unknown,
): Record<string, unknown> | null | undefined {
  if (rules === undefined) return undefined;
  const existing =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? (existingMetadata as Record<string, unknown>)
      : {};
  const nextHash = ruleHashFor(rules);
  const priorHash = typeof existing.ruleHash === 'string' ? existing.ruleHash : null;
  const priorVersion =
    typeof existing.ruleVersion === 'number' && Number.isFinite(existing.ruleVersion)
      ? existing.ruleVersion
      : 0;
  const nextVersion = priorHash === nextHash ? Math.max(priorVersion, 1) : priorVersion + 1;
  return {
    ...existing,
    ...compileRulesMetadata(rules, nextVersion),
  };
}

// ============================================
// Relationship Type Action Handlers
// ============================================

async function rtHandleList(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const sql = getDb();
  const includeDeleted = args.include_deleted ?? false;
  const deletedClause = includeDeleted ? '' : 'AND rt.deleted_at IS NULL';

  const rows = await sql.unsafe<RelationshipTypeRow>(
    `SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.created_at, rt.updated_at, rt.deleted_at,
      o.slug AS organization_slug,
      COALESCE(rc.relationship_count, 0) as relationship_count
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    LEFT JOIN organization o ON o.id = rt.organization_id
    LEFT JOIN (
      SELECT relationship_type_id, COUNT(*)::int as relationship_count
      FROM entity_relationships
      WHERE deleted_at IS NULL
        AND organization_id = $1
      GROUP BY relationship_type_id
    ) rc ON rc.relationship_type_id = rt.id
    WHERE (rt.organization_id = $1 OR o.visibility = 'public')
      ${deletedClause}
    ORDER BY (rt.organization_id = $1) DESC, rt.name ASC`,
    [ctx.organizationId]
  );

  const resolvedRts = await resolveUsernames(
    rows as unknown as Record<string, unknown>[],
    'created_by'
  );

  return {
    schema_type: 'relationship_type',
    action: 'list',
    relationship_types: resolvedRts.map((r) => ({
      ...(r as unknown as RelationshipTypeRow),
      relationship_count: Number(r.relationship_count) || 0,
    })),
  };
}

async function rtHandleGet(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new Error('slug is required for get action');

  const sql = getDb();
  const rows = await sql`
    SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.created_at, rt.updated_at, rt.deleted_at,
      o.slug AS organization_slug
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${args.slug}
      AND (rt.organization_id = ${ctx.organizationId} OR o.visibility = 'public')
      AND rt.deleted_at IS NULL
    ORDER BY (rt.organization_id = ${ctx.organizationId}) DESC, rt.id ASC
    LIMIT 1
  `;

  const resolvedRt =
    rows.length > 0
      ? (await resolveUsernames([rows[0] as Record<string, unknown>], 'created_by'))[0]
      : null;

  return {
    schema_type: 'relationship_type',
    action: 'get',
    relationship_type: (resolvedRt as unknown as RelationshipTypeRow) ?? null,
  };
}

async function rtHandleCreate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new Error('slug is required for create action');
  if (!args.name) throw new Error('name is required for create action');

  if (args.slug.startsWith('$')) {
    throw new Error("Relationship type slugs starting with '$' are reserved for system types");
  }

  const sql = getDb();

  const existing = await sql`
    SELECT id FROM entity_relationship_types
    WHERE slug = ${args.slug} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length > 0) {
    throw new Error(`Relationship type with slug "${args.slug}" already exists`);
  }

  let inverseTypeId: number | null = null;
  if (args.inverse_type_slug) {
    const inverseRows = await sql`
      SELECT id FROM entity_relationship_types
      WHERE slug = ${args.inverse_type_slug} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (inverseRows.length === 0) {
      throw new Error(`Inverse relationship type "${args.inverse_type_slug}" not found`);
    }
    inverseTypeId = Number(inverseRows[0].id);
  }

  const identityMetadata = buildRelationshipIdentityMetadata(args.auto_create_when, null);

  const inserted = await sql`
    INSERT INTO entity_relationship_types (
      slug, name, description, organization_id, created_by,
      metadata_schema, metadata, is_symmetric, inverse_type_id, status,
      created_at, updated_at
    ) VALUES (
      ${args.slug},
      ${args.name},
      ${args.description ?? null},
      ${ctx.organizationId},
      ${ctx.userId},
      ${args.metadata_schema ? sql.json(args.metadata_schema) : null},
      ${identityMetadata ? sql.json(identityMetadata) : null},
      ${args.is_symmetric ?? false},
      ${inverseTypeId},
      ${args.status ?? 'active'},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  const typeId = Number((inserted[0] as { id: unknown }).id);

  if (inverseTypeId !== null) {
    await sql`
      UPDATE entity_relationship_types
      SET inverse_type_id = ${typeId}, updated_at = current_timestamp
      WHERE id = ${inverseTypeId}
    `;
  }

  const created = await sql`
    SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.created_at, rt.updated_at
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    WHERE rt.id = ${typeId}
  `;

  return {
    schema_type: 'relationship_type',
    action: 'create',
    relationship_type: created[0] as unknown as RelationshipTypeRow,
  };
}

async function rtHandleUpdate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const { typeId, sql } = await requireRelationshipType(args.slug, 'update', ctx);

  let inverseTypeId: number | null | undefined;
  if (args.inverse_type_slug !== undefined) {
    if (args.inverse_type_slug === null || args.inverse_type_slug === '') {
      inverseTypeId = null;
    } else {
      const inverseRows = await sql`
        SELECT id FROM entity_relationship_types
        WHERE slug = ${args.inverse_type_slug} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (inverseRows.length === 0) {
        throw new Error(`Inverse relationship type "${args.inverse_type_slug}" not found`);
      }
      const resolvedId = Number(inverseRows[0].id);
      if (resolvedId === typeId) throw new Error('inverse_type_id cannot point to self');
      inverseTypeId = resolvedId;
    }
  }

  const currentMetadataRows = await sql<{ metadata: unknown }>`
    SELECT metadata FROM entity_relationship_types WHERE id = ${typeId} LIMIT 1
  `;
  const identityMetadata = buildRelationshipIdentityMetadata(
    args.auto_create_when,
    currentMetadataRows[0]?.metadata ?? null
  );

  await sql`
    UPDATE entity_relationship_types SET
      name = COALESCE(${args.name ?? null}, name),
      description = CASE
        WHEN ${args.description !== undefined} THEN ${args.description ?? null}
        ELSE description
      END,
      metadata_schema = CASE
        WHEN ${args.metadata_schema !== undefined} THEN ${args.metadata_schema ? sql.json(args.metadata_schema) : null}
        ELSE metadata_schema
      END,
      metadata = CASE
        WHEN ${identityMetadata !== undefined} THEN ${identityMetadata ? sql.json(identityMetadata) : null}
        ELSE metadata
      END,
      inverse_type_id = CASE
        WHEN ${inverseTypeId !== undefined} THEN ${inverseTypeId ?? null}
        ELSE inverse_type_id
      END,
      status = COALESCE(${args.status ?? null}, status),
      updated_at = current_timestamp
    WHERE id = ${typeId}
  `;

  const updated = await sql`
    SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.created_at, rt.updated_at
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    WHERE rt.id = ${typeId}
  `;

  return {
    schema_type: 'relationship_type',
    action: 'update',
    relationship_type: updated[0] as unknown as RelationshipTypeRow,
  };
}

async function rtHandleDelete(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const { typeId, sql } = await requireRelationshipType(args.slug, 'delete', ctx);

  await sql`
    UPDATE entity_relationship_types
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE id = ${typeId}
  `;

  await sql`
    UPDATE entity_relationship_type_rules
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
  `;

  return {
    schema_type: 'relationship_type',
    action: 'delete',
    success: true,
    message: `Relationship type "${args.slug}" deleted`,
  };
}

async function rtHandleAddRule(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.source_entity_type_slug)
    throw new Error('source_entity_type_slug is required for add_rule action');
  if (!args.target_entity_type_slug)
    throw new Error('target_entity_type_slug is required for add_rule action');

  const { typeId, sql } = await requireRelationshipType(args.slug, 'add_rule', ctx);

  const existingRule = await sql`
    SELECT id FROM entity_relationship_type_rules
    WHERE relationship_type_id = ${typeId}
      AND source_entity_type_slug = ${args.source_entity_type_slug}
      AND target_entity_type_slug = ${args.target_entity_type_slug}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existingRule.length > 0) {
    throw new Error(
      `Rule already exists for ${args.source_entity_type_slug} → ${args.target_entity_type_slug}`
    );
  }

  const inserted = await sql`
    INSERT INTO entity_relationship_type_rules (
      relationship_type_id, source_entity_type_slug, target_entity_type_slug,
      created_at, updated_at
    ) VALUES (
      ${typeId},
      ${args.source_entity_type_slug},
      ${args.target_entity_type_slug},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  const ruleId = Number((inserted[0] as { id: unknown }).id);

  const created = await sql`
    SELECT id, relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
    FROM entity_relationship_type_rules
    WHERE id = ${ruleId}
  `;

  return {
    schema_type: 'relationship_type',
    action: 'add_rule',
    rule: created[0] as unknown as RelationshipTypeRuleRow,
  };
}

async function rtHandleRemoveRule(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.rule_id) throw new Error('rule_id is required for remove_rule action');

  const sql = getDb();

  const ruleRows = await sql`
    SELECT r.id, rt.organization_id
    FROM entity_relationship_type_rules r
    JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
    WHERE r.id = ${args.rule_id} AND r.deleted_at IS NULL
    LIMIT 1
  `;
  if (ruleRows.length === 0) throw new Error(`Rule ${args.rule_id} not found`);

  const ruleOrgId = String(ruleRows[0].organization_id ?? '');
  if (ruleOrgId && ruleOrgId !== ctx.organizationId) {
    throw new Error('Access denied: rule belongs to another organization');
  }

  await sql`
    UPDATE entity_relationship_type_rules
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE id = ${args.rule_id}
  `;

  return {
    schema_type: 'relationship_type',
    action: 'remove_rule',
    success: true,
    message: `Rule ${args.rule_id} removed`,
  };
}

async function rtHandleListRules(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const { typeId, sql } = await requireRelationshipType(args.slug, 'list_rules', ctx, 'read');

  const rules = await sql`
    SELECT id, relationship_type_id, source_entity_type_slug, target_entity_type_slug, created_at
    FROM entity_relationship_type_rules
    WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
    ORDER BY id ASC
  `;

  return {
    schema_type: 'relationship_type',
    action: 'list_rules',
    rules: rules as unknown as RelationshipTypeRuleRow[],
  };
}
