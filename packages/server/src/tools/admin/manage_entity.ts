/**
 * Tool: manage_entity
 *
 * Entity management - create, update, list, get, delete.
 * Also manages entity relationships (graph edges between entities).
 *
 * Actions:
 * - create: Create new entity
 * - update: Update existing entity
 * - list: List entities with filtering
 * - get: Get details for specific entity
 * - delete: Delete entity (with optional force for cascading deletes)
 * - link: Create a relationship between two entities
 * - unlink: Soft-delete a relationship
 * - update_link: Update metadata/confidence/source on a relationship
 * - list_links: List relationships for an entity with filters
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb, pgTextArray } from '../../db/client';
import type { Env } from '../../index';
import {
  batchLoadRelationships,
  createEntity,
  deleteEntity,
  type EntityData,
  getEntity,
  listEntities,
  type RelationshipColumnSpec,
  updateEntity,
} from '../../utils/entity-management';
import { ToolUserError } from '../../utils/errors';
import { recordChangeEvent } from '../../utils/insert-event';
import {
  canonicalizeSymmetricEdge,
  checkDuplicateEdge,
  validateConfidence,
  validateNoSelfReference,
  validateScopeRule,
  validateSource,
  validateTypeRule,
} from '../../utils/relationship-validation';
import { resolveMemberSchemaFieldsFromSchema } from '../../utils/member-entity-type';
import { validateEntityMetadata } from '../../utils/schema-validation';
import { buildEntityUrl } from '../../utils/url-builder';
import { trackWatcherReaction } from '../../utils/watcher-reactions';
import { isAdminOrOwnerRole } from '../access-control';
import { MEMBER_ENTITY_TYPE_SLUG } from '../constants';
import { proposeEntityFieldChange } from './entity-field-approval';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { buildEntityViewUrl, getOrgUrlContext, toEntityInfo } from '../view-urls';
import { defineFlatActionTool, flatAction } from './action-tool';
import { SortOrderField } from './schemas/common-fields';

// ============================================
// Typebox Schema
// ============================================

export const ManageEntitySchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('create'),
      Type.Literal('update'),
      Type.Literal('list'),
      Type.Literal('get'),
      Type.Literal('delete'),
      Type.Literal('link'),
      Type.Literal('unlink'),
      Type.Literal('update_link'),
      Type.Literal('list_links'),
    ],
    { description: 'Action to perform' }
  ),

  // Entity type (required for create, list)
  entity_type: Type.Optional(
    Type.String({
      description: 'Entity type as defined in your workspace',
    })
  ),

  // Entity ID (for get, update, delete, list_links)
  entity_id: Type.Optional(
    Type.Number({ description: '[get/update/delete/list_links] Entity ID to operate on' })
  ),

  // Common fields
  name: Type.Optional(Type.String({ description: '[create/update] Entity name', minLength: 1 })),
  content: Type.Optional(
    Type.String({
      description:
        '[create/update] Free-text content body. Used by memory entities and any entity that carries rich text.',
    })
  ),
  slug: Type.Optional(
    Type.String({
      description: '[create/update] URL-friendly slug (auto-generated from name if not provided)',
      pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
    })
  ),
  parent_id: Type.Optional(
    Type.Number({ description: '[create/update] Parent entity ID (for hierarchical entities)' })
  ),
  enabled_classifiers: Type.Optional(
    Type.Array(Type.String(), { description: '[create/update] Enabled classifier slugs' })
  ),

  // Optional fields (available on all entity types)
  domain: Type.Optional(
    Type.String({ description: '[create/update] Primary domain (e.g., spotify.com)' })
  ),
  category: Type.Optional(Type.String({ description: '[create/update/list] Industry category' })),
  platform_type: Type.Optional(
    Type.String({ description: '[create/update] Platform type (b2b, b2c, b2b2c)' })
  ),
  main_market: Type.Optional(
    Type.String({ description: '[create/update/list] Primary market (ISO 3166-1 alpha-2)' })
  ),
  market: Type.Optional(
    Type.String({ description: '[create/update/list] Market/region (ISO 3166-1 alpha-2)' })
  ),
  link: Type.Optional(Type.String({ description: '[create/update] Entity URL' })),

  // Custom metadata (validated against entity type's JSON schema)
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "[create/update/link/update_link] Custom metadata object. For entities: validated against the entity type's JSON schema. For links: relationship metadata. On update, fields a human owns are NOT overwritten — they are queued for the human's approval and reported in the result's `blocked_fields`/`approval_queued`; tell the user you PROPOSED those changes rather than claiming you set them. Unowned fields in the same call apply directly (`applied_fields`).",
    })
  ),

  // Human-correction annotation
  field_note: Type.Optional(
    Type.String({
      description:
        '[update] Optional note explaining a human correction. Stored on the per-field ownership marker for every metadata field this update sets, so a watcher (and the UI) can see why the value was set.',
    })
  ),

  // Approve/affirm: claim ownership of a field's current value without changing it
  affirm_fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "[update] Metadata field names whose CURRENT value the human approves as-is. No value change, but each is marked human-owned so a watcher can't later overwrite it without an approval. The 'approve' half of the recap feedback loop.",
    })
  ),

  // List/pagination
  search: Type.Optional(Type.String({ description: '[list] Search by name' })),
  limit: Type.Optional(
    Type.Number({ description: '[list/list_links] Page size (default: 100, max: 500)' })
  ),
  offset: Type.Optional(
    Type.Number({ description: '[list/list_links] Pagination offset (default: 0)' })
  ),
  sort_by: Type.Optional(
    Type.String({
      description:
        '[list] Sort by column (name, created_at, domain, total_content, active_connections, watchers_count, children_count)',
    })
  ),
  sort_order: SortOrderField('[list] Sort order (asc or desc)'),

  // Delete options
  force_delete_tree: Type.Optional(
    Type.Boolean({ description: '[delete] Force delete entity and all descendants' })
  ),

  // ---- Relationship (link) fields ----
  from_entity_id: Type.Optional(Type.Number({ description: '[link] Source entity ID' })),
  to_entity_id: Type.Optional(Type.Number({ description: '[link] Target entity ID' })),
  relationship_type_slug: Type.Optional(
    Type.String({
      description: '[link/list_links] Relationship type slug',
      minLength: 1,
    })
  ),
  confidence: Type.Optional(
    Type.Number({
      description: '[link/update_link] Confidence score 0-1. Defaults to 1.0 for ui/api source.',
      minimum: 0,
      maximum: 1,
    })
  ),
  source: Type.Optional(
    Type.Union(
      [Type.Literal('ui'), Type.Literal('llm'), Type.Literal('feed'), Type.Literal('api')],
      { description: '[link/update_link] Source of the relationship' }
    )
  ),
  relationship_id: Type.Optional(
    Type.Number({ description: '[update_link/unlink] Relationship ID' })
  ),
  direction: Type.Optional(
    Type.Union([Type.Literal('outbound'), Type.Literal('inbound'), Type.Literal('both')], {
      description: '[list_links] Direction filter. Default both.',
    })
  ),
  confidence_min: Type.Optional(
    Type.Number({
      description: '[list_links] Minimum confidence threshold',
      minimum: 0,
      maximum: 1,
    })
  ),
  include_deleted: Type.Optional(
    Type.Boolean({ description: '[list_links] Include soft-deleted relationships' })
  ),
  watcher_source: Type.Optional(
    Type.Object(
      {
        watcher_id: Type.Number({ description: 'Watcher that triggered this mutation' }),
        window_id: Type.Number({ description: 'Window that triggered this mutation' }),
      },
      { description: 'Attribution source when mutation is triggered by a watcher reaction' }
    )
  ),
});

type ManageEntityArgs = Static<typeof ManageEntitySchema>;

// ============================================
// Result Types
// ============================================

// Relationship row shape (used by link actions)
interface RelationshipRow {
  id: number;
  organization_id: string;
  from_entity_id: number;
  to_entity_id: number;
  relationship_type_id: number;
  relationship_type_slug: string;
  relationship_type_name: string;
  is_symmetric: boolean;
  from_entity_name?: string;
  from_entity_type?: string;
  to_entity_name?: string;
  to_entity_type?: string;
  metadata?: Record<string, unknown> | null;
  confidence: number;
  source: string;
  created_by?: string | null;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

interface RelationshipCountByType {
  relationship_type_slug: string;
  relationship_type_name: string;
  count: number;
}

type ManageEntityResult =
  | {
      action: 'create';
      entity: {
        id: number;
        entity_type: string;
        name: string;
        slug: string;
        parent_id?: number | null;
        parent_name?: string | null;
        parent_slug?: string | null;
        metadata?: Record<string, any>;
        enabled_classifiers?: string[] | null;
        created_at: string;
        view_url?: string;
      };
      warnings?: string[];
      next_steps: string[];
    }
  | {
      action: 'update';
      entity: {
        id: number;
        entity_type: string;
        name: string;
        slug: string;
        parent_id?: number | null;
        parent_name?: string | null;
        parent_slug?: string | null;
        metadata?: Record<string, any>;
        enabled_classifiers?: string[] | null;
        view_url?: string;
      };
      /** Fields the ownership-aware merge wrote (unowned for a watcher-source edit). */
      applied_fields?: string[];
      /** Human-owned fields the edit was blocked from writing — queued for approval. */
      blocked_fields?: string[];
      /** True when a blocked-field approval was queued this call. */
      approval_queued?: boolean;
      /** Permalink to the approval card, when one was queued. */
      approval_url?: string;
    }
  | {
      action: 'list';
      entities: Array<{
        id: number;
        entity_type: string;
        name: string;
        slug: string;
        parent_id?: number | null;
        parent_name?: string | null;
        parent_slug?: string | null;
        parent_entity_type?: string | null;
        metadata?: Record<string, any>;
        enabled_classifiers?: string[] | null;
        created_at?: Date;
        total_content?: number | null;
        active_connections?: number | null;
        watchers_count?: number | null;
        children_count?: number | null;
        space_name?: string | null;
        view_url?: string;
      }>;
      // Server-side resolution of every `x-link-entity-type` column referenced
      // by the page. Keyed by `${entityType}:${lookupField}`, then by the
      // lookup value from the row's metadata. Previously each entity-list page
      // fanned out one `manage_entity.list` per linked column (4× ~2.5 s on
      // the Company page); the FE now reads from this map instead.
      linked_entities?: Record<string, Record<string, { slug: string; entity_type: string; name: string }>>;
      metadata: {
        page_size: number;
        has_more: boolean;
        filtered_by_type?: string;
        total_count?: number;
        limit?: number;
        offset?: number;
        sort_by?: string;
        sort_order?: 'asc' | 'desc';
      };
    }
  | {
      action: 'get';
      entity: {
        id: number;
        entity_type: string;
        name: string;
        slug: string;
        parent_id?: number | null;
        parent_name?: string | null;
        parent_slug?: string | null;
        metadata?: Record<string, any>;
        enabled_classifiers?: string[] | null;
        created_at: string;
        view_url?: string;
      };
    }
  | {
      action: 'delete';
      success: boolean;
      message: string;
      deleted_count: number;
    }
  | { action: 'link'; relationship: RelationshipRow }
  | { action: 'update_link'; relationship: RelationshipRow }
  | { action: 'unlink'; success: boolean; message: string }
  | {
      action: 'list_links';
      relationships: RelationshipRow[];
      counts_by_type: RelationshipCountByType[];
      metadata: { total: number; limit: number; offset: number; has_more: boolean };
    };

function toIsoStringOrNow(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return new Date(value).toISOString();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ============================================
// Main Function (Action Router)
// ============================================

const runManageEntity = defineFlatActionTool<ManageEntityArgs, ManageEntityResult>(
  'manage_entity',
  {
    create: flatAction((args, ctx, env) => handleCreate(args, env, ctx)),
    update: flatAction((args, ctx, env) => handleUpdate(args.entity_id!, args, env, ctx), {
      requires: ['entity_id'],
    }),
    list: flatAction((args, ctx, env) => handleList(args, env, ctx)),
    get: flatAction((args, ctx, env) => handleGet(args.entity_id!, env, ctx), {
      requires: ['entity_id'],
    }),
    delete: flatAction(
      (args, ctx, env) => handleDelete(args.entity_id!, args.force_delete_tree ?? false, env, ctx),
      { requires: ['entity_id'] }
    ),
    link: flatAction((args, ctx, env) => handleLink(args, env, ctx)),
    unlink: flatAction(handleUnlink),
    update_link: flatAction(handleUpdateLink),
    list_links: flatAction(handleListLinks),
  }
);

export const manageEntity = withValidatedArgs(
  'manage_entity',
  ManageEntitySchema,
  manageEntityImpl
);

async function manageEntityImpl(
  args: ManageEntityArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  const result = await runManageEntity(args, env, ctx);

  // Track watcher reaction for mutating actions
  if (args.watcher_source && 'action' in result) {
    const reactionType =
      result.action === 'create'
        ? 'entity_created'
        : result.action === 'update'
          ? 'entity_updated'
          : result.action === 'link'
            ? 'entity_linked'
            : null;
    if (reactionType) {
      const entityId =
        result.action === 'create' && 'entity' in result
          ? (result as any).entity.id
          : args.entity_id;
      await trackWatcherReaction({
        organizationId: ctx.organizationId,
        watcherId: args.watcher_source.watcher_id,
        windowId: args.watcher_source.window_id,
        reactionType,
        toolName: 'manage_entity',
        toolArgs: {
          action: args.action,
          entity_type: args.entity_type,
          name: args.name,
          entity_id: args.entity_id,
        },
        toolResult: result as Record<string, unknown>,
        entityId,
      });
    }
  }

  return result;
}

// ============================================
// Action Handlers
// ============================================

async function handleCreate(
  args: ManageEntityArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  if (!args.entity_type) {
    throw new Error('entity_type is required for create action');
  }

  if (!args.name) {
    throw new Error('name is required for create action');
  }

  // (Derived-type rejection lives in createEntity — the single chokepoint that
  // also resolves public-catalog types.)

  // Validate metadata against entity type's JSON schema (if defined)
  if (args.metadata && Object.keys(args.metadata).length > 0) {
    const validation = await validateEntityMetadata(args.entity_type, args.metadata, ctx);
    if (!validation.valid) {
      const errorMessages =
        validation.errors?.map((e) => e.message).join('; ') ?? 'Invalid metadata';
      throw new Error(`Metadata validation failed: ${errorMessages}`);
    }
  }

  // Build entity data with organization_id from context
  const entityData: EntityData = {
    entity_type: args.entity_type,
    name: args.name,
    slug: args.slug,
    parent_id: args.parent_id ?? null,
    metadata: args.metadata ?? {},
    enabled_classifiers: args.enabled_classifiers ?? null,
    organization_id: ctx.organizationId,
  };
  (entityData as any).created_by = ctx.userId ?? 'system';

  // All fields available on all entity types - DB constraints handle validation
  entityData.domain = args.domain ?? null;
  entityData.category = args.category ?? null;
  entityData.platform_type = args.platform_type ?? null;
  entityData.main_market = args.main_market ?? null;
  entityData.market = args.market ?? null;
  entityData.link = args.link ?? null;

  // Content body (used by memory entities)
  if (args.content !== undefined) {
    entityData.content = args.content;
  }

  const entity = await createEntity(entityData, {
    hookContext: { organizationId: ctx.organizationId, userId: ctx.userId, env },
  });

  const entityTypeLabel = capitalize(entity.entity_type);

  // Build next steps
  const nextSteps: string[] = [
    `${entityTypeLabel} "${entity.name}" created successfully with ID ${entity.id}.`,
  ];

  if (!entity.parent_id) {
    // Root entity (no parent)
    nextSteps.push(
      `Use manage_connections(action='create') to install a connector, then manage_feeds(action='create_feed', entity_ids=[${entity.id}]) to target this entity.`,
      `Use manage_watchers(action='create', entity_id=${entity.id}) to schedule watchers.`
    );
  } else {
    // Child entity (has parent)
    nextSteps.push(
      `${entityTypeLabel} belongs to ${entity.parent_name ? `"${entity.parent_name}"` : 'parent'} (ID: ${entity.parent_id}).`,
      `Use manage_connections(action='create') to install a connector, then manage_feeds(action='create_feed', entity_ids=[${entity.id}]) to target this entity.`
    );
  }

  const entityDetails = (await getEntity(entity.id, env, ctx)) ?? entity;
  const createdAtIso = toIsoStringOrNow(entityDetails.created_at);
  const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

  return {
    action: 'create',
    entity: {
      id: entityDetails.id,
      entity_type: entityDetails.entity_type,
      name: entityDetails.name,
      slug: entityDetails.slug,
      parent_id: entityDetails.parent_id,
      parent_name: entityDetails.parent_name,
      parent_slug: entityDetails.parent_slug ?? null,
      metadata: entityDetails.metadata ?? {},
      enabled_classifiers: entityDetails.enabled_classifiers,
      created_at: createdAtIso,
      view_url: viewUrl,
    },
    warnings: entity.warnings,
    next_steps: nextSteps,
  };
}

async function handleUpdate(
  entityId: number,
  args: ManageEntityArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  const sql = getDb();

  // Fetch before state for change tracking and validation
  const beforeRows = await sql`
    SELECT e.name, e.slug, e.parent_id, e.metadata, et.slug AS entity_type
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.id = ${entityId} AND e.deleted_at IS NULL
  `;
  if (beforeRows.length === 0) {
    throw new Error(`Entity with ID ${entityId} not found`);
  }
  const before = beforeRows[0];

  // Validate metadata against entity type's JSON schema (if being updated)
  if (args.metadata !== undefined && Object.keys(args.metadata).length > 0) {
    const validation = await validateEntityMetadata(
      before.entity_type as string,
      args.metadata,
      ctx
    );
    if (!validation.valid) {
      const errorMessages =
        validation.errors?.map((e) => e.message).join('; ') ?? 'Invalid metadata';
      throw new Error(`Metadata validation failed: ${errorMessages}`);
    }
  }

  // Build update data (only include fields that are present)
  const updateData: Partial<EntityData> = {};

  if (args.name !== undefined) updateData.name = args.name;
  if (args.slug !== undefined) updateData.slug = args.slug;
  if (args.parent_id !== undefined) updateData.parent_id = args.parent_id;
  if (args.enabled_classifiers !== undefined)
    updateData.enabled_classifiers = args.enabled_classifiers;

  // Type-specific fields
  if (args.domain !== undefined) updateData.domain = args.domain;
  if (args.category !== undefined) updateData.category = args.category;
  if (args.platform_type !== undefined) updateData.platform_type = args.platform_type;
  if (args.main_market !== undefined) updateData.main_market = args.main_market;
  if (args.market !== undefined) updateData.market = args.market;
  if (args.link !== undefined) updateData.link = args.link;

  // Content body
  if (args.content !== undefined) updateData.content = args.content;

  // Metadata (replaces entire object)
  if (args.metadata !== undefined) updateData.metadata = args.metadata;

  // Human-correction note: annotates the field_controls marker for the fields
  // this edit claims (why the human set/overrode the value).
  if (args.field_note !== undefined) updateData.field_note = args.field_note;

  // Approve/affirm: claim ownership of these fields' current values as-is.
  if (args.affirm_fields !== undefined) updateData.affirm_fields = args.affirm_fields;

  const updatedEntity = await updateEntity(entityId, updateData, env, ctx);
  const entityDetails = (await getEntity(updatedEntity.id, env, ctx)) ?? updatedEntity;

  // Record field changes as a system event
  const beforeMetadata =
    typeof before.metadata === 'string'
      ? JSON.parse(before.metadata as string)
      : (before.metadata ?? {});
  const afterMetadata =
    typeof entityDetails.metadata === 'string'
      ? JSON.parse(entityDetails.metadata as string)
      : (entityDetails.metadata ?? {});

  const changes: Array<{ field: string; old: unknown; new: unknown }> = [];

  if (before.name !== entityDetails.name) {
    changes.push({ field: 'name', old: before.name, new: entityDetails.name });
  }
  if (before.slug !== entityDetails.slug) {
    changes.push({ field: 'slug', old: before.slug, new: entityDetails.slug });
  }
  const beforeParentId = before.parent_id != null ? Number(before.parent_id) : null;
  const afterParentId = entityDetails.parent_id ?? null;
  if (beforeParentId !== afterParentId) {
    changes.push({ field: 'parent_id', old: beforeParentId, new: afterParentId });
  }
  if (args.content !== undefined) {
    changes.push({ field: 'content', old: '[changed]', new: '[changed]' });
  }

  // Diff metadata keys (includes convenience fields like domain, category, etc.)
  const allMetadataKeys = new Set([...Object.keys(beforeMetadata), ...Object.keys(afterMetadata)]);
  for (const key of allMetadataKeys) {
    if (JSON.stringify(beforeMetadata[key]) !== JSON.stringify(afterMetadata[key])) {
      changes.push({
        field: key,
        old: beforeMetadata[key] ?? null,
        new: afterMetadata[key] ?? null,
      });
    }
  }

  if (changes.length > 0) {
    const contentLines = changes.map(
      (c) => `- ${c.field}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`
    );

    recordChangeEvent({
      entityIds: [entityId],
      organizationId: ctx.organizationId,
      title: `Entity updated: ${changes.map((c) => c.field).join(', ')}`,
      content: `Entity "${entityDetails.name}" (id: ${entityId}) updated:\n${contentLines.join('\n')}`,
      metadata: { changes },
      createdBy: ctx.userId ?? null,
      clientId: ctx.clientId ?? null,
    });
  }

  const viewUrl = await buildEntityViewUrl(ctx, entityDetails);

  // Post-commit: any blocked (human-owned) fields become a single durable
  // approval card. Done AFTER the entity tx + change event so the approval
  // (run + event + notification) is never rolled back with the edit — same
  // rule as complete_window's blockedProposals.
  const blocked = updatedEntity.fieldMerge?.blocked ?? {};
  const blockedPaths = Object.keys(blocked);
  let approvalQueued = false;
  let approvalUrl: string | undefined;
  if (blockedPaths.length > 0) {
    const fields = Object.fromEntries(blockedPaths.map((p) => [p, blocked[p].proposed]));
    const current = Object.fromEntries(blockedPaths.map((p) => [p, blocked[p].current]));
    const res = await proposeEntityFieldChange(ctx, {
      entity_id: entityId,
      fields,
      current,
      watcher_id: args.watcher_source?.watcher_id ?? null,
      attribution: args.watcher_source ? 'watcher' : 'agent',
      reason: args.watcher_source
        ? `A watcher proposes updating ${blockedPaths.join(', ')} on this entity.`
        : `An agent proposes updating ${blockedPaths.join(', ')} on this entity.`,
    });
    approvalQueued = true;
    approvalUrl = res.approvalUrl;
  }

  return {
    action: 'update',
    entity: {
      id: entityDetails.id,
      entity_type: entityDetails.entity_type,
      name: entityDetails.name,
      slug: entityDetails.slug,
      parent_id: entityDetails.parent_id,
      parent_name: entityDetails.parent_name,
      parent_slug: entityDetails.parent_slug ?? null,
      metadata: entityDetails.metadata ?? {},
      enabled_classifiers: entityDetails.enabled_classifiers,
      view_url: viewUrl,
    },
    applied_fields: updatedEntity.fieldMerge?.applied,
    blocked_fields: blockedPaths.length > 0 ? blockedPaths : undefined,
    approval_queued: approvalQueued || undefined,
    approval_url: approvalUrl,
  };
}

// Access policy for the built-in $member entity type:
//  - Anyone who isn't a member of the org cannot see the member list at all.
//  - Members who aren't admin/owner see names + non-PII metadata, but not the
//    email address.
//  - Only admin/owner see the email field.
function canSeeMemberList(ctx: ToolContext): boolean {
  return !!ctx.memberRole;
}

function canSeeMemberEmail(ctx: ToolContext): boolean {
  return isAdminOrOwnerRole(ctx.memberRole);
}

function redactMemberEmail(
  metadata: Record<string, unknown>,
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const { emailField } = resolveMemberSchemaFieldsFromSchema(schema);
  if (!(emailField in metadata)) return metadata;
  const { [emailField]: _removed, ...rest } = metadata;
  return rest;
}

async function handleList(
  args: ManageEntityArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  if (args.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(ctx)) {
    throw new Error(
      'The member list is only visible to members of this workspace. Join the workspace to see members.'
    );
  }

  const sql = getDb();

  // Run list query and entity type schema fetch in parallel
  const [listResult, entityTypeRow] = await Promise.all([
    listEntities(
      {
        entity_type: args.entity_type,
        parent_id: args.parent_id,
        search: args.search,
        category: args.category,
        main_market: args.main_market,
        market: args.market,
        limit: args.limit,
        offset: args.offset,
        sort_by: args.sort_by,
        sort_order: args.sort_order,
      },
      env,
      ctx
    ),
    args.entity_type
      ? sql`SELECT metadata_schema FROM entity_types WHERE slug = ${args.entity_type} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`.then(
          (r) => r[0] ?? null
        )
      : Promise.resolve(null),
  ]);

  const { entities, hasMore, totalCount, limit, offset, sortBy, sortOrder } = listResult;

  // Batch-load relationships if schema declares x-table-relationships
  const schema = entityTypeRow?.metadata_schema as Record<string, unknown> | null;
  const relSpecs = (schema?.['x-table-relationships'] ?? []) as RelationshipColumnSpec[];
  const entityIds = entities.map((e) => e.id);

  // Batch-load relationships and linked-column lookups in parallel.
  const [relMap, linkedEntities] = await Promise.all([
    relSpecs.length > 0 && entityIds.length > 0
      ? batchLoadRelationships(entityIds, relSpecs, ctx.organizationId)
      : Promise.resolve(new Map()),
    resolveLinkedColumns(entities, schema, ctx.organizationId),
  ]);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  const hideMemberEmail = !canSeeMemberEmail(ctx);

  return {
    action: 'list',
    entities: entities.map((e) => {
      const entityInfo = ownerSlug ? toEntityInfo(ownerSlug, e) : null;
      const rawMetadata = e.metadata ?? {};
      const metadata =
        hideMemberEmail && e.entity_type === MEMBER_ENTITY_TYPE_SLUG
          ? redactMemberEmail(rawMetadata, schema)
          : rawMetadata;
      return {
        id: e.id,
        entity_type: e.entity_type,
        name: e.name,
        slug: e.slug,
        parent_id: e.parent_id,
        parent_name: e.parent_name,
        parent_slug: e.parent_slug,
        parent_entity_type: e.parent_entity_type,
        metadata,
        enabled_classifiers: e.enabled_classifiers,
        created_at: e.created_at,
        total_content: e.total_content,
        active_connections: e.active_connections,
        watchers_count: e.watchers_count,
        children_count: e.children_count,
        view_url: entityInfo ? buildEntityUrl(entityInfo, baseUrl) : undefined,
        ...(relMap.size > 0 && relMap.has(e.id) ? { relationships: relMap.get(e.id) } : {}),
      };
    }),
    ...(Object.keys(linkedEntities).length > 0 ? { linked_entities: linkedEntities } : {}),
    metadata: {
      page_size: entities.length,
      has_more: hasMore,
      total_count: totalCount,
      limit,
      offset,
      sort_by: sortBy,
      sort_order: sortOrder,
      filtered_by_type: args.entity_type,
    },
  };
}

/**
 * Resolve every `x-link-entity-type` column on the schema to `{slug, name}`
 * pairs in one batch per (entityType, lookupField). Replaces the previous
 * FE pattern of `useQueries` fanning out one full-table fetch per linked
 * column. Returns a map keyed `${entityType}:${lookupField}` → lookup-value
 * → ref. Empty object if the schema declares no linked columns or none of
 * the visible rows reference linked values.
 */
async function resolveLinkedColumns(
  entities: Array<{ metadata?: Record<string, any> | null }>,
  schema: Record<string, unknown> | null,
  organizationId: string
): Promise<Record<string, Record<string, { slug: string; entity_type: string; name: string }>>> {
  if (!schema || entities.length === 0) return {};
  const properties = (schema as { properties?: Record<string, any> }).properties;
  if (!properties) return {};

  // Collect (linkedType, lookupField) → set of referenced values from the rows.
  const buckets = new Map<
    string,
    { entityType: string; lookupField: string; values: Set<string> }
  >();
  for (const [columnKey, prop] of Object.entries(properties)) {
    const linkedType = (prop as { 'x-link-entity-type'?: unknown })['x-link-entity-type'];
    if (typeof linkedType !== 'string' || linkedType === '') continue;
    const lookupFieldRaw = (prop as { 'x-link-lookup-field'?: unknown })['x-link-lookup-field'];
    const lookupField = typeof lookupFieldRaw === 'string' && lookupFieldRaw ? lookupFieldRaw : 'slug';
    const bucketKey = `${linkedType}:${lookupField}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = { entityType: linkedType, lookupField, values: new Set() };
      buckets.set(bucketKey, bucket);
    }
    for (const e of entities) {
      const raw = e.metadata?.[columnKey];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const v of list) {
        if (v == null) continue;
        const s = String(v).trim();
        if (s !== '') bucket.values.add(s);
      }
    }
  }
  if (buckets.size === 0) return {};

  const sql = getDb();
  const out: Record<string, Record<string, { slug: string; entity_type: string; name: string }>> = {};

  await Promise.all(
    [...buckets.entries()].map(async ([bucketKey, { entityType, lookupField, values }]) => {
      if (values.size === 0) return;
      const valuesArr = [...values];
      const valuesLiteral = pgTextArray(valuesArr);
      const rows =
        lookupField === 'slug'
          ? await sql<{ slug: string; entity_type: string; name: string; lookup_value: string }>`
              SELECT e.slug, et.slug AS entity_type, e.name, e.slug AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND e.slug = ANY(${valuesLiteral}::text[])
            `
          : await sql<{ slug: string; entity_type: string; name: string; lookup_value: string }>`
              SELECT e.slug, et.slug AS entity_type, e.name, (e.metadata->>${lookupField}) AS lookup_value
              FROM entities e
              JOIN entity_types et ON et.id = e.entity_type_id
              WHERE e.organization_id = ${organizationId}
                AND e.deleted_at IS NULL
                AND et.slug = ${entityType}
                AND (e.metadata->>${lookupField}) = ANY(${valuesLiteral}::text[])
            `;
      if (rows.length === 0) return;
      const bucketMap: Record<string, { slug: string; entity_type: string; name: string }> = {};
      for (const r of rows) {
        if (r.lookup_value == null) continue;
        bucketMap[r.lookup_value] = { slug: r.slug, entity_type: r.entity_type, name: r.name };
      }
      out[bucketKey] = bucketMap;
    })
  );

  return out;
}

async function handleGet(
  entityId: number,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  const entity = await getEntity(entityId, env, ctx);

  if (!entity) {
    throw new Error(`Entity with ID ${entityId} not found`);
  }

  if (entity.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(ctx)) {
    throw new Error(
      'Member details are only visible to members of this workspace. Join the workspace to see members.'
    );
  }

  const viewUrl = await buildEntityViewUrl(ctx, entity);

  let metadata = entity.metadata ?? {};
  if (entity.entity_type === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberEmail(ctx)) {
    const sql = getDb();
    const rows = await sql`
      SELECT metadata_schema FROM entity_types
      WHERE slug = ${MEMBER_ENTITY_TYPE_SLUG} AND organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      LIMIT 1
    `;
    const memberSchema = (rows[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
    metadata = redactMemberEmail(metadata, memberSchema);
  }

  return {
    action: 'get',
    entity: {
      id: entity.id,
      entity_type: entity.entity_type,
      name: entity.name,
      slug: entity.slug,
      parent_id: entity.parent_id,
      parent_name: entity.parent_name,
      parent_slug: entity.parent_slug ?? null,
      metadata,
      enabled_classifiers: entity.enabled_classifiers,
      created_at: toIsoStringOrNow(entity.created_at),
      view_url: viewUrl,
    },
  };
}

async function handleDelete(
  entityId: number,
  force: boolean,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  // Get entity info before deletion
  const entity = await getEntity(entityId, env, ctx);
  if (!entity) {
    throw new Error(`Entity with ID ${entityId} not found`);
  }

  const result = await deleteEntity(entityId, force, env, ctx);

  return {
    action: 'delete',
    success: true,
    message: result.message,
    deleted_count: result.deleted,
  };
}

// ============================================
// Relationship (Link) Helpers
// ============================================

const RELATIONSHIP_SELECT = `
  r.id,
  r.organization_id,
  r.from_entity_id,
  r.to_entity_id,
  r.relationship_type_id,
  rt.slug as relationship_type_slug,
  rt.name as relationship_type_name,
  rt.is_symmetric,
  fe.name as from_entity_name,
  fet.slug as from_entity_type,
  te.name as to_entity_name,
  tet.slug as to_entity_type,
  r.metadata,
  r.confidence,
  r.source,
  r.created_by,
  r.updated_by,
  r.created_at,
  r.updated_at,
  r.deleted_at
`;

const RELATIONSHIP_JOINS = `
  FROM entity_relationships r
  JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
  LEFT JOIN entities fe ON r.from_entity_id = fe.id
  LEFT JOIN entity_types fet ON fet.id = fe.entity_type_id
  LEFT JOIN entities te ON r.to_entity_id = te.id
  LEFT JOIN entity_types tet ON tet.id = te.entity_type_id
`;

// ============================================
// Relationship (Link) Action Handlers
// ============================================

async function handleLink(
  args: ManageEntityArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  if (!args.from_entity_id) throw new ToolUserError('from_entity_id is required for link', 400);
  if (!args.to_entity_id) throw new ToolUserError('to_entity_id is required for link', 400);
  if (!args.relationship_type_slug) throw new ToolUserError('relationship_type_slug is required for link', 400);

  const sql = getDb();

  validateNoSelfReference(args.from_entity_id, args.to_entity_id);
  await validateScopeRule(args.from_entity_id, args.to_entity_id, env, ctx);

  // Schema search path for relationship types: tenant first, then any
  // visibility='public' catalog. Mirrors createEntity's resolver so a tenant
  // can use a canonical relationship type like `works_at` defined in
  // public-uk-finance without registering a local copy. Tenant-local types
  // win when both exist.
  const typeRows = await sql`
    SELECT rt.id, rt.is_symmetric
    FROM entity_relationship_types rt
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${args.relationship_type_slug}
      AND rt.deleted_at IS NULL
      AND (
        rt.organization_id = ${ctx.organizationId}
        OR o.visibility = 'public'
      )
    ORDER BY (rt.organization_id = ${ctx.organizationId}) DESC, rt.id ASC
    LIMIT 1
  `;
  if (typeRows.length === 0) {
    throw new Error(`Relationship type "${args.relationship_type_slug}" not found`);
  }
  const typeId = Number(typeRows[0].id);
  const isSymmetric = Boolean(typeRows[0].is_symmetric);

  await validateTypeRule(typeId, args.from_entity_id, args.to_entity_id, sql);

  let fromId = args.from_entity_id;
  let toId = args.to_entity_id;
  if (isSymmetric) {
    // For symmetric same-org pairs we canonicalize by id so dedup catches
    // a → b and b → a as the same edge. For cross-org pairs (target in a
    // public catalog), keep the caller's-org entity as `from` even if its
    // id is higher, so the stored source matches the semantic source. The
    // canonical form would otherwise leave rows where `from_entity_id`
    // points at a public catalog row under a tenant `organization_id` —
    // tenant-owned but cosmetically inverted.
    const orgRows = await sql<{ id: number; organization_id: string }>`
      SELECT id, organization_id FROM entities WHERE id IN (${fromId}, ${toId})
    `;
    const orgOf = (id: number) =>
      String(orgRows.find((r) => Number(r.id) === id)?.organization_id);
    const sameOrg =
      orgOf(fromId) === ctx.organizationId && orgOf(toId) === ctx.organizationId;
    if (sameOrg) {
      const canonical = canonicalizeSymmetricEdge(fromId, toId);
      fromId = canonical.from;
      toId = canonical.to;
    }
    // else: cross-org symmetric — preserve caller-from / public-to.
    // validateScopeRule already required `from` to be in caller's org.
  }

  await checkDuplicateEdge(fromId, toId, typeId, sql);

  validateConfidence(args.confidence);
  validateSource(args.source);
  const source = args.source ?? 'api';
  const confidence = args.confidence ?? (source === 'ui' || source === 'api' ? 1.0 : null);

  const inserted = await sql`
    INSERT INTO entity_relationships (
      organization_id, from_entity_id, to_entity_id, relationship_type_id,
      metadata, confidence, source, created_by, updated_by,
      created_at, updated_at
    ) VALUES (
      ${ctx.organizationId},
      ${fromId},
      ${toId},
      ${typeId},
      ${args.metadata ? sql.json(args.metadata) : null},
      ${confidence},
      ${source},
      ${ctx.userId},
      ${ctx.userId},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  const relationshipId = Number((inserted[0] as { id: unknown }).id);

  const created = await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
    [relationshipId]
  );

  return { action: 'link', relationship: created[0] };
}

async function handleUnlink(args: ManageEntityArgs, ctx: ToolContext): Promise<ManageEntityResult> {
  if (!args.relationship_id) throw new Error('relationship_id is required for unlink');

  const sql = getDb();

  const existing = await sql`
    SELECT id, organization_id FROM entity_relationships
    WHERE id = ${args.relationship_id} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) {
    throw new Error(`Relationship ${args.relationship_id} not found`);
  }
  if (String(existing[0].organization_id) !== ctx.organizationId) {
    throw new Error('Access denied: relationship belongs to another organization');
  }

  await sql`
    UPDATE entity_relationships
    SET deleted_at = current_timestamp, updated_at = current_timestamp, updated_by = ${ctx.userId}
    WHERE id = ${args.relationship_id}
  `;

  return {
    action: 'unlink',
    success: true,
    message: `Relationship ${args.relationship_id} deleted`,
  };
}

async function handleUpdateLink(
  args: ManageEntityArgs,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  if (!args.relationship_id) throw new Error('relationship_id is required for update_link');

  const sql = getDb();

  const existing = await sql`
    SELECT id, organization_id FROM entity_relationships
    WHERE id = ${args.relationship_id} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) {
    throw new Error(`Relationship ${args.relationship_id} not found`);
  }
  if (String(existing[0].organization_id) !== ctx.organizationId) {
    throw new Error('Access denied: relationship belongs to another organization');
  }

  validateConfidence(args.confidence);
  validateSource(args.source);

  const hasMetadata = args.metadata !== undefined;
  const metadataJson = hasMetadata ? sql.json(args.metadata) : null;

  await sql`
    UPDATE entity_relationships SET
      metadata = CASE
        WHEN ${hasMetadata} THEN ${metadataJson}
        ELSE metadata
      END,
      confidence = COALESCE(${args.confidence ?? null}, confidence),
      source = COALESCE(${args.source ?? null}, source),
      updated_by = ${ctx.userId},
      updated_at = current_timestamp
    WHERE id = ${args.relationship_id}
  `;

  const updated = await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS} WHERE r.id = $1`,
    [args.relationship_id]
  );

  return { action: 'update_link', relationship: updated[0] };
}

async function handleListLinks(
  args: ManageEntityArgs,
  ctx: ToolContext
): Promise<ManageEntityResult> {
  if (!args.entity_id) throw new ToolUserError('entity_id is required for list_links', 400);

  const sql = getDb();
  const direction = args.direction ?? 'both';
  const includeDeleted = args.include_deleted ?? false;
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const offset = Math.max(args.offset ?? 0, 0);

  const conditions: string[] = ['r.organization_id = $1'];
  const params: unknown[] = [ctx.organizationId];
  let paramIdx = 2;

  if (!includeDeleted) {
    conditions.push('r.deleted_at IS NULL');
  }

  if (direction === 'outbound') {
    conditions.push(`(r.from_entity_id = $${paramIdx})`);
    params.push(args.entity_id);
    paramIdx++;
  } else if (direction === 'inbound') {
    conditions.push(`(r.to_entity_id = $${paramIdx})`);
    params.push(args.entity_id);
    paramIdx++;
  } else {
    conditions.push(`(r.from_entity_id = $${paramIdx} OR r.to_entity_id = $${paramIdx})`);
    params.push(args.entity_id);
    paramIdx++;
  }

  if (args.relationship_type_slug) {
    conditions.push(`rt.slug = $${paramIdx}`);
    params.push(args.relationship_type_slug);
    paramIdx++;
  }

  if (args.source) {
    conditions.push(`r.source = $${paramIdx}`);
    params.push(args.source);
    paramIdx++;
  }

  if (args.confidence_min !== undefined) {
    conditions.push(`r.confidence >= $${paramIdx}`);
    params.push(args.confidence_min);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await sql.unsafe<{ total: number }>(
    `SELECT COUNT(*)::int as total ${RELATIONSHIP_JOINS} WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total ?? 0);

  const rows = await sql.unsafe<RelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} ${RELATIONSHIP_JOINS}
     WHERE ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT ${limit + 1}
     OFFSET ${offset}`,
    params
  );

  const hasMore = rows.length > limit;
  const relationships = hasMore ? rows.slice(0, limit) : rows;

  const countsResult = await sql.unsafe<RelationshipCountByType>(
    `SELECT
      rt.slug as relationship_type_slug,
      rt.name as relationship_type_name,
      COUNT(*)::int as count
    ${RELATIONSHIP_JOINS}
    WHERE ${whereClause}
    GROUP BY rt.slug, rt.name
    ORDER BY count DESC`,
    params
  );

  return {
    action: 'list_links',
    relationships,
    counts_by_type: countsResult,
    metadata: { total, limit, offset, has_more: hasMore },
  };
}
