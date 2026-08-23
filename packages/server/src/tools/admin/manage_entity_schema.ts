/**
 * Tool: manage_entity_schema
 *
 * Unified management for entity type definitions and relationship type definitions.
 * Uses `schema_type` discriminator to select between 'entity_type' and 'relationship_type'.
 *
 * Entity Type Actions: list, get, create, update, delete, audit
 * Relationship Type Actions: list, get, create, update, delete, add_rule, remove_rule, list_rules
 */

import {
  ManageEntitySchemaResultSchema,
  ManageEntitySchemaSchema,
  ManageEntitySchemaProposalSchema,
  type AuditEntry,
  type EntityTypeRow,
  type ManageEntitySchemaArgs,
  type ManageEntitySchemaProposal,
  type ManageEntitySchemaResult,
  type RelationshipTypeRow,
  type RelationshipTypeRuleRow,
  type ViewTemplateTab,
} from '@lobu/core/contracts/tools/manage-entity-schema';
import { Value } from '@sinclair/typebox/value';
import { validateEntityMetrics } from '@lobu/connector-sdk';
import {
  isPlatformEventType,
  platformEventKinds,
} from '../../automations/platform-event-catalog';
import { compileEntityRule } from '../../authz/entity-rule-executor';
import { type DbClient, getDb } from '../../db/client';
import {
  currentMcpActivityAttribution,
  currentMcpActivityEventMetadata,
} from '../../lobu/stores/mcp-client-conversations';
import { validateMetricReadModes } from '../../metrics/read-mode';
import { resolveActionOrigin } from '../../notifications/action-origin';
import { notifyActionApprovalNeeded } from '../../notifications/triggers';
import { recordToolConfigChange } from './helpers/config-audit';
import {
  type DataSourceContext,
  type DataSourceInput,
  executeDataSources,
} from '../../utils/execute-data-sources';
import { isAdminOrOwnerRole, isInProcessSystemCall } from '../access-control';
import {
  assertNotAuthorizationType,
  isAclManagedRelationshipSlug,
} from '../../utils/relationship-validation';
import { measureColumns } from '../../utils/infer-measures';
import type { Env } from '../../index';
import logger from '../../utils/logger';
import { insertEvent } from '../../utils/insert-event';
import { ensureMemberEntityType } from '../../utils/member-entity-type';
import {
  countEntitiesOfType,
  countStoredEntitiesOfType,
  getEntityCountsByTypes,
} from '../../utils/entity-management';
import {
  isReservedEntityTypeSlug,
  normalizeEntityTypeSlug,
  RESERVED_ENTITY_TYPE_SLUGS,
} from '../../utils/reserved';
import { resolveUsernames } from '../../utils/resolve-usernames';
import { ToolUserError } from '../../utils/errors';
import { isUniqueViolation } from '../../utils/pg-errors';
import { buildResourcePermalink } from '../../utils/url-builder';
import type { ToolContext } from '../registry';
import { enforceRoleScopeAccess } from '../access-control';
import { resolveRunInitiator } from '../initiator';
import { withValidatedArgs } from '../validate-args';
import { getOrgUrlContext } from '../view-urls';
import { resolveApprovalChatOrigin } from './approval-delivery';
import { defineFlatActionTool, flatAction } from './action-tool';

export { ManageEntitySchemaResultSchema, ManageEntitySchemaSchema };

/** `runs.action_key` for an MCP-authored entity-type create held for approval. */
export const MANAGE_ENTITY_SCHEMA_ACTION_KEY = 'manage_entity_schema';

export type { ManageEntitySchemaProposal };

// ============================================
// Main Function (Action Router)
// ============================================

const runEntityTypeActions = defineFlatActionTool<ManageEntitySchemaArgs, ManageEntitySchemaResult>(
  'manage_entity_schema',
  {
    list: flatAction(etHandleList),
    get: flatAction((args, ctx) => etHandleGet(args.slug, ctx)),
    create: flatAction((args, ctx) => etHandleCreate(args, ctx)),
    update: flatAction((args, ctx) => etHandleUpdate(args, ctx)),
    delete: flatAction((args, ctx) => etHandleDelete(args.slug, ctx)),
    audit: flatAction((args, ctx) => etHandleAudit(args.slug, ctx)),
  }
);

const runRelationshipTypeActions = defineFlatActionTool<
  ManageEntitySchemaArgs,
  ManageEntitySchemaResult
>('manage_entity_schema', {
  list: flatAction(rtHandleList),
  get: flatAction(rtHandleGet),
  create: flatAction(rtHandleCreate),
  update: flatAction(rtHandleUpdate),
  delete: flatAction(rtHandleDelete),
  add_rule: flatAction(rtHandleAddRule),
  remove_rule: flatAction(rtHandleRemoveRule),
  list_rules: flatAction(rtHandleListRules),
});

export const manageEntitySchema = withValidatedArgs(
  'manage_entity_schema',
  ManageEntitySchemaSchema,
  manageEntitySchemaImpl
);

async function manageEntitySchemaImpl(
  args: ManageEntitySchemaArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
	if (
		(args.action === 'create' || args.action === 'update') &&
		Object.hasOwn(args as object, 'properties')
	) {
		throw new ToolUserError(
			"[invalid_schema] top-level properties is not supported; put JSON Schema fields under metadata_schema.properties",
			422
		);
	}
  if (args.schema_type === 'entity_type') {
    // MCP clients propose entity-type creation; they never apply it inline.
    // Direct browser/CLI calls carry no MCP transport identity and retain the
    // existing owner/admin route below.
    if (args.action === 'create' && ctx.mcpSessionId) {
      return queueEntityTypeCreateForApproval(args, ctx);
    }
    return runEntityTypeActions(args, env, ctx);
  }
  return runRelationshipTypeActions(args, env, ctx);
}

/** Validate the durable proposal shape before the approval registry claims it. */
export function isManageEntitySchemaProposal(
  value: unknown
): value is ManageEntitySchemaProposal {
  if (!Value.Check(ManageEntitySchemaProposalSchema, value)) return false;
  const proposal = value as ManageEntitySchemaProposal;
  return (
    proposal.schema_type === 'entity_type' &&
    proposal.action === 'create' &&
    Value.Check(ManageEntitySchemaSchema, proposal.args) &&
    proposal.args.schema_type === 'entity_type' &&
    proposal.args.action === 'create'
  );
}

/**
 * Apply a held MCP entity-type proposal after manage_operations has verified a
 * human owner/admin. The original proposer remains the row/audit author.
 */
export async function applyManageEntitySchemaProposal(
  proposal: ManageEntitySchemaProposal,
  ctx: ToolContext,
  _env: Env,
  requesterUserId: string | null
): Promise<ManageEntitySchemaResult> {
  if (!isManageEntitySchemaProposal(proposal)) {
    throw new ToolUserError('Invalid manage_entity_schema approval proposal', 400);
  }
  return etHandleCreate(proposal.args as ManageEntitySchemaArgs, {
    ...ctx,
    userId: requesterUserId,
  });
}

async function queueEntityTypeCreateForApproval(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!ctx.userId) {
    throw new ToolUserError(
      'Entity type proposals require an authenticated workspace member',
      401
    );
  }
  enforceRoleScopeAccess('write', ctx.memberRole, ctx.scopes, {
    adminRole: 'Entity type proposals require workspace membership.',
    writeRole: 'Entity type proposals require workspace membership with write access.',
    readScope: 'Entity type proposals require an MCP session with read access.',
    writeScope: 'Entity type proposals require an MCP session with write access.',
    adminScope: 'Entity type proposals require an MCP session with admin access.',
  });

  // Reject malformed, reserved, duplicate, or uncompilable proposals before a
  // durable card is created. Approval repeats the same validation against the
  // then-current database state.
  const prepared = await prepareEntityTypeCreate(args, ctx);
  const proposal: ManageEntitySchemaProposal = {
    schema_type: 'entity_type',
    action: 'create',
    args: { ...args, slug: prepared.slug },
  };
  const initiator = resolveRunInitiator(ctx);
  const label = `create entity type ${prepared.slug}`;
  const sql = getDb();
  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);

  const { runId, eventId } = await sql.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO runs (
        organization_id, run_type, action_key, action_input,
        created_by_user_id, initiator_kind, initiator_ref,
        approval_status, status, created_at
      ) VALUES (
        ${ctx.organizationId}, 'internal', ${MANAGE_ENTITY_SCHEMA_ACTION_KEY},
        ${tx.json(proposal as unknown as Record<string, unknown>)},
        ${initiator.createdByUserId},
        ${initiator.initiatorKind},
        ${tx.json(initiator.initiatorRef)},
        'pending', 'pending', current_timestamp
      )
      RETURNING id
    `;
    const runId = Number((inserted[0] as { id: unknown }).id);
    const event = await insertEvent(
      {
        entityIds: [],
        organizationId: ctx.organizationId,
        originId: `run_${runId}_pending`,
        title: `${label} — pending approval`,
        content: `MCP client requested: ${label}`,
        semanticType: 'operation',
        runId,
        interactionType: 'approval',
        interactionStatus: 'pending',
        interactionInput: proposal as unknown as Record<string, unknown>,
        metadata: {
          tool: 'manage_entity_schema',
          action_key: MANAGE_ENTITY_SCHEMA_ACTION_KEY,
          schema_type: 'entity_type',
          action: 'create',
          slug: prepared.slug,
          proposal,
          current: null,
          initiator: {
            kind: initiator.initiatorKind,
            ...initiator.initiatorRef,
          },
          status: 'pending_approval',
          ...currentMcpActivityEventMetadata(ctx),
        },
        authorName: ctx.clientId ?? 'MCP client',
        clientId: ctx.tokenType === 'oauth' ? (ctx.clientId ?? null) : null,
      },
      { sql: tx }
    );
    return { runId, eventId: Number(event.id) };
  });

  const approvalUrl = buildResourcePermalink(
    ownerSlug,
    { kind: 'run', runId },
    baseUrl
  );
  const chatOrigin = await resolveApprovalChatOrigin(ctx);
  const actionOrigin = await resolveActionOrigin(ctx);
  notifyActionApprovalNeeded({
    orgId: ctx.organizationId,
    runId,
    actionKey: MANAGE_ENTITY_SCHEMA_ACTION_KEY,
    connectionName: label,
    eventId,
    approvalUrl,
    connectionId: chatOrigin.connectionId,
    channelId: chatOrigin.channelId,
    teamId: chatOrigin.teamId,
    requesterUserId: ctx.userId,
    mcpActivity: currentMcpActivityAttribution(ctx),
    actionOrigin,
  }).catch((error) =>
    logger.error(error, 'Failed to send entity type approval notification')
  );

  return {
    schema_type: 'entity_type',
    action: 'create',
    status: 'pending_approval',
    run_id: runId,
    event_id: eventId,
    ...(approvalUrl ? { approval_url: approvalUrl } : {}),
    message: approvalUrl
      ? `Entity type '${prepared.slug}' is queued for human approval. Call get_approval with run_id ${runId} to show the embedded confirmation, or give the user approval_url.`
      : `Entity type '${prepared.slug}' is queued for human approval. Call get_approval with run_id ${runId} to show the embedded confirmation.`,
    proposal,
    current: null,
  };
}

// ============================================
// Entity Type Helpers
// ============================================

/**
 * Compile a type's write rules, surfacing a compile error to the AUTHOR.
 *
 * Returns null for absent or cleared rules, which is what every existing type
 * already stores and what the write seam reads as "no rule for this type".
 */
async function compileRulesOrThrow(source: string | null): Promise<string | null> {
  if (!source || !source.trim()) return null;
  try {
    return await compileEntityRule(source);
  } catch (err) {
    throw new ToolUserError(
      `[invalid_rules] write rules failed to compile: ${(err as Error).message}`,
      422
    );
  }
}

const ENTITY_TYPE_COLUMNS =
  'id, slug, name, description, icon, color, metadata_schema, event_kinds, backing_sql, backing_source, metrics_config, rules_source, created_by, organization_id, created_at, updated_at, current_view_template_version_id';

const ENTITY_TYPE_COLUMNS_WITH_ORG = `et.id, et.slug, et.name, et.description, et.icon, et.color,
  et.metadata_schema, et.event_kinds, et.backing_sql, et.backing_source, et.metrics_config,
  et.rules_source,
  et.created_by, et.organization_id,
  et.created_at, et.updated_at, et.current_view_template_version_id,
  o.slug AS organization_slug`;

function mapRowToEntityType(row: Record<string, unknown>): EntityTypeRow {
  const slug = typeof row.slug === 'string' ? row.slug : '';
  return {
    ...(row as unknown as EntityTypeRow),
    // Sole platform signal: $ prefix ($member, $resource). Not created_by.
    is_system: slug.startsWith('$'),
    entity_count: Number(row.entity_count) || 0,
  };
}

/**
 * Schema-validation failures are user input errors, not duplicates: they carry
 * a `[invalid_schema]` marker + httpStatus 422 so REST callers (`lobu apply`)
 * can tell them apart from create-on-duplicate (`[entity_type_exists]`, 409)
 * instead of guessing from the status code alone (issue #1177 — a 422 here
 * used to be mistaken for "already exists", triggering a doomed update retry
 * that buried the real message under "Entity type not found").
 */
function invalidSchema(message: string): ToolUserError {
  return new ToolUserError(`[invalid_schema] ${message}`, 422);
}

/**
 * Authoritative server-side validation of a declared metrics_config. Catches
 * the referential/shape errors the CLI also checks (a measure naming a missing
 * eventSet/segment, a non-`count` measure without `expr`), so a non-CLI writer
 * (SDK / API) cannot persist a broken metric contract. No-op for null/omitted.
 *
 * `reads` modes are checked here rather than inside `validateEntityMetrics`
 * because their lowering — and therefore what counts as a valid `asOf` — belongs
 * to the server's metric compiler, not to the shared contract types. A malformed
 * `asOf` must fail at apply, not at the first query.
 */
function assertValidMetricsConfig(metricsConfig: unknown): void {
  if (metricsConfig == null) return;
  const errors = [
    ...validateEntityMetrics(metricsConfig),
    ...validateMetricReadModes(metricsConfig),
  ];
  if (errors.length > 0) {
    throw invalidSchema(`invalid metrics_config: ${errors.join('; ')}`);
  }
}

/**
 * Reject event kinds that collide with the platform's own `<subject>.<op>`
 * vocabulary.
 *
 * `event_kinds` is the registry `save_content` validates against, so a type
 * declared here becomes postable as ordinary content. Declaring
 * `connection.deleted` would therefore let any caller with content-write
 * access post a row that Automations subscribed to real connection deletions
 * would activate on. Blocking the collision at declaration is the chokepoint —
 * checking on every save would leave already-declared collisions live.
 */
function assertEventKindsAvoidPlatformVocabulary(
  eventKinds: Record<string, unknown> | null | undefined
): void {
  if (!eventKinds || typeof eventKinds !== 'object') return;
  const reserved = Object.keys(eventKinds).filter(isPlatformEventType);
  if (reserved.length > 0) {
    throw invalidSchema(
      `event_kinds may not redeclare platform event types: ${reserved.join(', ')}`
    );
  }
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

  for (const [field, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) continue;

    const tableColumn = (prop as Record<string, unknown>)['x-table-column'];
    if (tableColumn !== undefined && typeof tableColumn !== 'boolean') {
      throw invalidSchema(`metadata_schema.properties.${field}.x-table-column must be a boolean`);
    }

    const tableLabel = (prop as Record<string, unknown>)['x-table-label'];
    if (tableLabel !== undefined && typeof tableLabel !== 'string') {
      throw invalidSchema(`metadata_schema.properties.${field}.x-table-label must be a string`);
    }
  }
}

/**
 * Reject an empty/whitespace `backing.sql`. TypeBox `minLength: 1` accepts a
 * whitespace-only string, so boundary validation alone would let a caller
 * persist a "derived" type whose view is blank — unqueryable and with no
 * inferable measures. `backing: null` (revert to stored) is fine. The
 * `[invalid_schema]`/422 error shape here is a contract `lobu apply` parses.
 */
function assertValidBacking(backing: ManageEntitySchemaArgs['backing']): void {
  if (backing && typeof backing.sql === 'string' && backing.sql.trim() === '') {
    throw invalidSchema('backing.sql cannot be empty');
  }
  // Symmetric guard: an empty `connection` would persist backing_source='' — a
  // slug that resolves to no connection, failing only at read time.
  if (backing && typeof backing.connection === 'string' && backing.connection.trim() === '') {
    throw invalidSchema('backing.connection cannot be empty');
  }
}

async function getRelationshipCountForType(
  typeId: number,
  organizationId: string
): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    SELECT COUNT(*)::int as count
    FROM entity_relationships r
    WHERE r.relationship_type_id = ${typeId}
      AND r.organization_id = ${organizationId}
      AND r.deleted_at IS NULL
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

async function etHandleList(
	args: ManageEntitySchemaArgs,
	ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const sql = getDb();
	const scopePredicate =
		args.list_scope === 'organization'
			? 'et.organization_id = $1'
			: "(et.organization_id = $1 OR o.visibility = 'public')";

  const rows = await sql.unsafe(
    `SELECT ${ENTITY_TYPE_COLUMNS_WITH_ORG}
     FROM entity_types et
     LEFT JOIN organization o ON o.id = et.organization_id
     WHERE et.deleted_at IS NULL
		 AND ${scopePredicate}
     ORDER BY (et.organization_id = $1) DESC, et.name ASC`,
    [ctx.organizationId]
  );

  const resolved = await resolveUsernames(
    rows as unknown as Record<string, unknown>[],
    'created_by'
  );

  const mappedTypes = resolved.map((row) => mapRowToEntityType(row));
  // Stored + derived counts share one path with list/detail (entity-management).
  // Derived types are excluded here: their backing SQL is expensive (multi-second
  // on large event tables) and this list endpoint is called on every page load —
  // a live badge count is not worth that. They report entity_count 0.
  const counts = await getEntityCountsByTypes(
    mappedTypes
      .filter((t) => t.backing_sql == null)
      .map((t) => ({
        id: Number(t.id),
        slug: t.slug,
        backing_sql: null,
        backing_source: null,
      })),
    ctx
  );

  const entityTypes = mappedTypes.map((mapped) => {
    mapped.entity_count = counts.get(Number(mapped.id)) || 0;
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

	return {
		schema_type: 'entity_type',
		action: 'list',
		entity_types: entityTypes,
		// Computed, never stored — same catalog trigger validation consults, so
		// the picker cannot drift from what a subscription will accept.
		platform_event_kinds: platformEventKinds(),
		list_scope: args.list_scope ?? 'accessible',
		organization_id: ctx.organizationId,
	};
}

/**
 * Fetch the entity-TYPE-scoped authored view templates for a type and run each
 * template's `data_sources` LIVE (mirrors resolve_path's fetchTabs +
 * processTabsDataSources, for the list scope). The list context has no specific
 * entity, so `entityIds` is unset — a data source that references `{{entityId}}`
 * simply resolves empty. `data_sources` is stripped from the returned
 * `json_template`; the results ride on `template_data`. Fails soft per-tab: a
 * broken data source yields `template_data: null` rather than failing `get`.
 */
async function fetchTypeViewTemplates(
  sql: DbClient,
  // The entity-type SLUG. view_template_active_tabs keys entity_type-scoped rows
  // by slug (matching manage_view_templates' `resource_id` and resolve_path's
  // fetchTabs('entity_type', entityRow.entity_type)), NOT the numeric id.
  entityTypeSlug: string,
  organizationId: string,
  userId: string | null,
  /** Exclude workspace-identity audit rows for ordinary-member / public reads. */
  excludeWorkspaceAudit: boolean
): Promise<ViewTemplateTab[]> {
  const rows = await sql`
    SELECT
      vtat.tab_name,
      vtat.tab_order,
      vtv.json_template,
      vtv.version,
      vtv.id as version_id
    FROM view_template_active_tabs vtat
    JOIN view_template_versions vtv ON vtv.id = vtat.current_version_id
    WHERE vtat.resource_type = 'entity_type'
      AND vtat.resource_id = ${entityTypeSlug}
      AND vtat.organization_id = ${organizationId}
    ORDER BY vtat.tab_order ASC, vtat.tab_name ASC
  `;

  const context: DataSourceContext = { organizationId, userId };

  return Promise.all(
    rows.map(async (row) => {
      const jsonTemplate = row.json_template as Record<string, unknown>;
      const dataSources = jsonTemplate.data_sources as DataSourceInput | undefined;
      let cleanTemplate = jsonTemplate;
      let templateData: Record<string, unknown[]> | null = null;
      if (dataSources) {
        const { data_sources: _dropped, ...rest } = jsonTemplate;
        cleanTemplate = rest;
        try {
          templateData = await executeDataSources(dataSources, context, sql, {
            excludeWorkspaceAudit,
          });
        } catch (err) {
          logger.warn(
            { err, tab: String(row.tab_name), entityTypeSlug },
            'view-template data source failed; returning tab without data'
          );
          templateData = null;
        }
      }
      return {
        tab_name: String(row.tab_name),
        tab_order: Number(row.tab_order),
        json_template: cleanTemplate,
        version: Number(row.version),
        version_id: Number(row.version_id),
        template_data: templateData,
      };
    })
  );
}

async function etHandleGet(
  slug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!slug) throw new ToolUserError('slug is required for get action', 400);
  const normalizedSlug = normalizeEntityTypeSlug(slug);

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
      [normalizedSlug, ctx.organizationId]
    );

  let rows = await fetchRow();

  // $member is per-tenant: if the resolved row is cross-org (or missing), provision in the caller's org.
  const needsMemberProvision =
    normalizedSlug === '$member' &&
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
  // Derived counts run the full backing SQL (multi-second on large event
  // tables) and this endpoint is called on every entity page open. The page
  // header shows the list response's total_count instead, so derived types
  // report 0 here. Same policy as the schema list + resolve_path bootstrap.
  mapped.entity_count = mapped.backing_sql
    ? 0
    : await countEntitiesOfType(
        {
          id: Number(mapped.id),
          slug: mapped.slug,
          backing_sql: mapped.backing_sql,
          backing_source: mapped.backing_source,
        },
        ctx
      );
  // Classify the view's measure columns on read (never persisted).
  if (mapped.backing_sql) mapped.measure_columns = measureColumns(mapped.backing_sql);
  // Authored type-level list-view templates, with their data_sources run live.
  // Workspace-identity audit rows are owner/admin/system-only; type templates
  // are org-scoped (no entityIds) so an events SELECT would otherwise leak them.
  mapped.view_templates = await fetchTypeViewTemplates(
    sql,
    mapped.slug,
    ctx.organizationId,
    ctx.userId,
    !isInProcessSystemCall(ctx) && !isAdminOrOwnerRole(ctx.memberRole)
  );

  return { schema_type: 'entity_type', action: 'get', entity_type: mapped };
}

interface PreparedEntityTypeCreate {
  slug: string;
  rulesCompiled: string | null;
}

/** Validate an entity-type create without mutating durable state. */
async function prepareEntityTypeCreate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<PreparedEntityTypeCreate> {
  if (!args.slug) throw new ToolUserError('slug is required for create action', 400);
  if (!args.name) throw new ToolUserError('name is required for create action', 400);
  if (!ctx.userId) throw new ToolUserError('Authentication required to create entity types', 401);

  // Preserve `$` for the reserved-slug check (isReservedEntityTypeSlug); domain
  // creates still get a normalized slug for storage when not reserved.
  if (isReservedEntityTypeSlug(args.slug)) {
    throw new ToolUserError(
      `Cannot create entity type with reserved slug '${args.slug}'. Reserved names: $…, ${RESERVED_ENTITY_TYPE_SLUGS.join(', ')}`,
      422
    );
  }

  const slug = normalizeEntityTypeSlug(args.slug);

  const sql = getDb();

  const existing = await sql`
    SELECT id FROM entity_types
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    // Coded 409 (not a generic 400): `lobu apply` upserts by probing `create`
    // and retrying as `update` ONLY on an explicit duplicate signal.
    throw new ToolUserError(`[entity_type_exists] Entity type with slug '${slug}' already exists`, 409);
  }

  validateEntityMetadataSchemaDisplayConfig(args.metadata_schema);
  assertValidBacking(args.backing);

  // metadata_schema is stored as the author sent it — measure/dimension roles for
  // a derived type are classified ON READ (see etHandleGet), never persisted.
  assertValidMetricsConfig(args.metrics_config);
  assertEventKindsAvoidPlatformVocabulary(args.event_kinds);
  // Compile during validation so malformed rules never become approval cards;
  // apply-time validation repeats the check against the current proposal.
  const rulesCompiled = await compileRulesOrThrow(args.rules_source ?? null);
  return { slug, rulesCompiled };
}

async function etHandleCreate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  const { slug, rulesCompiled } = await prepareEntityTypeCreate(args, ctx);
  const sql = getDb();
  const metadataSchema = args.metadata_schema ? sql.json(args.metadata_schema) : null;
  const eventKinds = args.event_kinds ? sql.json(args.event_kinds) : null;
  const metricsConfig = args.metrics_config ? sql.json(args.metrics_config) : null;

  let inserted: unknown[];
  try {
    inserted = await sql`
    INSERT INTO entity_types (
      slug, name, description, icon, color,
      metadata_schema, event_kinds,
      backing_sql, backing_source, metrics_config,
      rules_source, rules_compiled,
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
      ${args.backing?.sql ?? null},
      ${args.backing?.connection ?? null},
      ${metricsConfig},
      ${args.rules_source ?? null},
      ${rulesCompiled},
      ${ctx.organizationId},
      ${ctx.userId},
      current_timestamp,
      current_timestamp
    )
    RETURNING ${sql.unsafe(ENTITY_TYPE_COLUMNS)}
  `;
  } catch (err) {
    // The precheck above is not a lock: two concurrent replicas can both pass
    // it, and the loser hits the partial unique index. Translate that specific
    // 23505 to the SAME coded 409 the precheck emits, so `lobu apply`'s
    // probe-create-then-update path (and the documented ensure-then-write
    // flow) see one stable duplicate signal instead of a raw Postgres error.
    if (isUniqueViolation(err, 'idx_entity_types_org_slug')) {
      throw new ToolUserError(
        `[entity_type_exists] Entity type with slug '${slug}' already exists`,
        409
      );
    }
    throw err;
  }

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

  recordToolConfigChange(ctx, {
    resourceKind: 'entity-type',
    resourceId: slug,
    op: 'created',
    summary: `Entity type '${args.name}' created`,
    state: inserted[0] as Record<string, unknown>,
  });

  return { schema_type: 'entity_type', action: 'create', entity_type: created };
}

async function etHandleUpdate(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new ToolUserError('slug is required for update action', 400);
  if (!ctx.userId) throw new ToolUserError('Authentication required to update entity types', 401);

  const slug = normalizeEntityTypeSlug(args.slug);
  const sql = getDb();

  const existing = await sql`
    SELECT * FROM entity_types
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length === 0) throw new ToolUserError(`Entity type '${args.slug}' not found`, 404);

  const current = existing[0];

  const beforePayload = { ...current } as Record<string, unknown>;
  if (args.metadata_schema !== undefined) {
    validateEntityMetadataSchemaDisplayConfig(args.metadata_schema);
  }
  assertValidMetricsConfig(args.metrics_config);
  assertValidBacking(args.backing);
  assertEventKindsAvoidPlatformVocabulary(args.event_kinds);
  // Converting a populated stored type to a derived (view-backed) type would
  // orphan its existing rows (the view ignores them). Reject it.
  if (args.backing?.sql) {
    const existingCount = await countStoredEntitiesOfType(
      Number(current.id),
      ctx.organizationId
    );
    if (existingCount > 0) {
      throw new ToolUserError(
        `Cannot make entity type '${args.slug}' derived: ${existingCount} stored ${existingCount === 1 ? 'entity exists' : 'entities exist'}. Delete them first.`,
        409
      );
    }
  }
  // metadata_schema is stored verbatim (measure roles are classified on read).
  const hasMetadataSchema = args.metadata_schema !== undefined;
  const metadataSchemaJson = args.metadata_schema ? sql.json(args.metadata_schema) : null;
  const hasEventKinds = args.event_kinds !== undefined;
  const eventKindsJson = hasEventKinds && args.event_kinds ? sql.json(args.event_kinds) : null;

  // Backing is set as a unit: callers send `backing` (an object makes the type
  // derived, null reverts it to stored) or omit it to leave backing unchanged.
  const hasBacking = args.backing !== undefined;

  // Metrics set as a unit too: an object declares metrics, null clears them,
  // omit to leave unchanged (mirrors backing).
  const hasMetricsConfig = args.metrics_config !== undefined;
  const metricsConfigJson = args.metrics_config ? sql.json(args.metrics_config) : null;

  // Rules set as a unit, like backing and metrics: a string declares them, null
  // clears BOTH columns, omit to leave unchanged. Source and compiled artifact
  // are only ever written together — a pair that drifts apart would run a rule
  // nobody can read, or read one that never runs.
  const hasRules = args.rules_source !== undefined;
  const rulesCompiled = await compileRulesOrThrow(args.rules_source ?? null);

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
      rules_source = CASE
        WHEN ${hasRules} THEN ${args.rules_source ?? null}::text
        ELSE rules_source
      END,
      rules_compiled = CASE
        WHEN ${hasRules} THEN ${rulesCompiled}::text
        ELSE rules_compiled
      END,
      backing_sql = CASE
        WHEN ${hasBacking} THEN ${args.backing?.sql ?? null}::text
        ELSE backing_sql
      END,
      backing_source = CASE
        WHEN ${hasBacking} THEN ${args.backing?.connection ?? null}::text
        ELSE backing_source
      END,
      metrics_config = CASE
        WHEN ${hasMetricsConfig} THEN ${metricsConfigJson}
        ELSE metrics_config
      END,
      updated_by = ${ctx.userId},
      updated_at = current_timestamp
    WHERE id = ${current.id}
  `;

  const updated = await sql.unsafe(
    `SELECT ${ENTITY_TYPE_COLUMNS} FROM entity_types WHERE id = $1 LIMIT 1`,
    [current.id]
  );
  if (updated.length === 0) throw new ToolUserError(`Entity type '${args.slug}' not found after update`, 404);

  const result = mapRowToEntityType(updated[0] as Record<string, unknown>);
  // Same policy as get/list: never run a derived backing SQL just to echo a
  // count back from a schema update.
  result.entity_count = result.backing_sql
    ? 0
    : await countEntitiesOfType(
        {
          id: Number(result.id),
          slug: result.slug,
          backing_sql: result.backing_sql,
          backing_source: result.backing_source,
        },
        ctx
      );

  await recordAudit(
    sql,
    Number(current.id),
    'update',
    ctx.userId,
    beforePayload,
    updated[0] as Record<string, unknown>
  );

  const etChangedFields = [
    ...(args.name !== undefined ? ['name'] : []),
    ...(args.description !== undefined ? ['description'] : []),
    ...(args.icon !== undefined ? ['icon'] : []),
    ...(args.color !== undefined ? ['color'] : []),
    ...(hasMetadataSchema ? ['metadata_schema'] : []),
    ...(hasRules ? ['rules_source'] : []),
    ...(hasEventKinds ? ['event_kinds'] : []),
    ...(hasBacking ? ['backing'] : []),
    ...(hasMetricsConfig ? ['metrics_config'] : []),
  ];
  recordToolConfigChange(ctx, {
    resourceKind: 'entity-type',
    resourceId: slug,
    op: 'updated',
    summary: `Entity type '${result.name ?? args.slug}' updated`,
    state: updated[0] as Record<string, unknown>,
    ...(etChangedFields.length > 0 ? { changedFields: etChangedFields } : {}),
  });

  return { schema_type: 'entity_type', action: 'update', entity_type: result };
}

async function etHandleDelete(
  rawSlug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!rawSlug) throw new ToolUserError('slug is required for delete action', 400);
  const slug = normalizeEntityTypeSlug(rawSlug);
  if (!ctx.userId) throw new ToolUserError('Authentication required to delete entity types', 401);

  const sql = getDb();

  const existing = await sql`
    SELECT * FROM entity_types
    WHERE slug = ${slug}
      AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length === 0) throw new ToolUserError(`Entity type '${slug}' not found`, 404);

  const current = existing[0];
  // Only stored rows block delete — derived views have no `entities` rows.
  const entityCount = await countStoredEntitiesOfType(Number(current.id), ctx.organizationId);
  if (entityCount > 0) {
    throw new ToolUserError(
      `Cannot delete entity type '${slug}': ${entityCount} entities of this type exist. Remove or reassign them first.`,
      409
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

  recordToolConfigChange(ctx, {
    resourceKind: 'entity-type',
    resourceId: slug,
    op: 'deleted',
    summary: `Entity type '${slug}' deleted`,
    state: null,
  });

  return {
    schema_type: 'entity_type',
    action: 'delete',
    success: true,
    message: `Entity type '${slug}' deleted successfully`,
  };
}

async function etHandleAudit(
  rawSlug: string | undefined,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!rawSlug) throw new ToolUserError('slug is required for audit action', 400);
  const slug = normalizeEntityTypeSlug(rawSlug);

  const sql = getDb();

  const existing = await sql.unsafe(
    `SELECT id FROM entity_types
     WHERE slug = $1
       AND deleted_at IS NULL
       AND organization_id = $2
     LIMIT 1`,
    [slug, ctx.organizationId]
  );
  if (existing.length === 0) throw new ToolUserError(`Entity type '${slug}' not found`, 404);

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
  if (!slug) throw new ToolUserError(`slug is required for ${action} action`, 400);

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
    if (rows.length === 0) throw new ToolUserError(`Relationship type "${slug}" not found`, 404);
    return { typeId: Number(rows[0].id), sql };
  }

  // Write mode (update/delete/add_rule/…) only ever touches the caller's OWN
  // type, so scope the lookup to ctx.organizationId. A public type from another
  // org shares the slug but is read-only to this tenant (referenceable as an
  // inverse, never mutable), and a PRIVATE foreign row must stay invisible — an
  // unscoped lookup that fell back to a foreign row and threw 'Access denied'
  // leaked the slug's existence in another org. Absent an own row → 'not found'.
  const existing = await sql`
    SELECT id, slug, purpose FROM entity_relationship_types
    WHERE slug = ${slug} AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length === 0) throw new ToolUserError(`Relationship type "${slug}" not found`, 404);

  // Every write action (update, delete, add_rule, …) funnels through here, so
  // one guard covers the schema lifecycle. Archiving an authorization type would
  // revoke an org's access wholesale, and renaming or re-ruling one would move
  // the boundary the ACL gates read — neither belongs on a caller surface.
  assertNotAuthorizationType(existing[0], action);

  return { typeId: Number(existing[0].id), sql };
}

/**
 * Resolve an inverse relationship type by slug, scoped to the caller's own org
 * or a PUBLIC type from another org (same visibility filter as read mode). A
 * PRIVATE type owned by another org is invisible here — without this scoping
 * the lookup matched any org's row by slug, letting one tenant link to (and,
 * via the reciprocal back-link, mutate) another tenant's relationship type.
 * Returns the row id plus whether the caller owns it; the reciprocal back-link
 * is only written when the caller owns the inverse, never onto a foreign public
 * type.
 */
async function resolveInverseType(
  sql: DbClient,
  inverseSlug: string,
  ctx: ToolContext
): Promise<{ id: number; ownedByCaller: boolean }> {
  const rows = await sql`
    SELECT rt.id, rt.slug, rt.purpose, (rt.organization_id = ${ctx.organizationId}) AS owned
    FROM entity_relationship_types rt
    LEFT JOIN organization o ON o.id = rt.organization_id
    WHERE rt.slug = ${inverseSlug}
      AND rt.deleted_at IS NULL
      AND (rt.organization_id = ${ctx.organizationId} OR o.visibility = 'public')
    ORDER BY (rt.organization_id = ${ctx.organizationId}) DESC, rt.id ASC
    LIMIT 1
  `;
  if (rows.length === 0) {
    throw new ToolUserError(`Inverse relationship type "${inverseSlug}" not found`, 404);
  }
  // Refuse to pair a caller's type with an authorization type. The inverse is a
  // declared equivalence between two vocabularies, so allowing it would let a
  // caller attach their own freely-writable type to the one the ACL gates read.
  assertNotAuthorizationType(
    { slug: String(rows[0].slug ?? inverseSlug), purpose: rows[0].purpose as string | null },
    'inverse_type_slug'
  );
  return { id: Number(rows[0].id), ownedByCaller: Boolean(rows[0].owned) };
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
	const scopePredicate =
		args.list_scope === 'organization'
			? 'rt.organization_id = $1'
			: "(rt.organization_id = $1 OR o.visibility = 'public')";

  const rows = await sql.unsafe<RelationshipTypeRow>(
    `SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.purpose, rt.created_at, rt.updated_at, rt.deleted_at,
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
		WHERE ${scopePredicate}
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
		list_scope: args.list_scope ?? 'accessible',
		organization_id: ctx.organizationId,
  };
}

async function rtHandleGet(
  args: ManageEntitySchemaArgs,
  ctx: ToolContext
): Promise<ManageEntitySchemaResult> {
  if (!args.slug) throw new ToolUserError('slug is required for get action', 400);

  const sql = getDb();
  const rows = await sql`
    SELECT
      rt.id, rt.slug, rt.name, rt.description, rt.organization_id, rt.created_by,
      rt.metadata_schema, rt.metadata, rt.is_symmetric, rt.inverse_type_id,
      inv.slug as inverse_type_slug,
      rt.status, rt.purpose, rt.created_at, rt.updated_at, rt.deleted_at,
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
  if (!args.slug) throw new ToolUserError('slug is required for create action', 400);
  if (!args.name) throw new ToolUserError('name is required for create action', 400);

  if (args.slug.startsWith('$')) {
    throw new ToolUserError("Relationship type slugs starting with '$' are reserved for system types", 422);
  }

  const sql = getDb();

  // Org-scoped duplicate check — the unique index is (organization_id, slug),
  // so a same-slug PUBLIC type from another org must NOT block this org from
  // creating its own (matches entity-type create).
  const existing = await sql`
    SELECT id FROM entity_relationship_types
    WHERE slug = ${args.slug} AND deleted_at IS NULL
      AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    // Coded 409 — same duplicate-signal contract as entity-type create.
    throw new ToolUserError(
      `[relationship_type_exists] Relationship type with slug "${args.slug}" already exists`,
      409
    );
  }

  let inverseTypeId: number | null = null;
  let inverseOwnedByCaller = false;
  if (args.inverse_type_slug) {
    const inverse = await resolveInverseType(sql, args.inverse_type_slug, ctx);
    inverseTypeId = inverse.id;
    inverseOwnedByCaller = inverse.ownedByCaller;
  }

  let inserted: unknown[];
  try {
    inserted = await sql`
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
      null,
      ${args.is_symmetric ?? false},
      ${inverseTypeId},
      ${args.status ?? 'active'},
      current_timestamp,
      current_timestamp
    )
    RETURNING id
  `;
  } catch (err) {
    // Same check-then-insert race as createType: the precheck is not a lock,
    // so a concurrent replica can win and the loser hits the partial unique
    // index. Translate that specific 23505 to the SAME coded 409 the precheck
    // emits so callers see one stable duplicate signal.
    if (isUniqueViolation(err, 'idx_entity_rel_types_org_slug')) {
      throw new ToolUserError(
        `[relationship_type_exists] Relationship type with slug "${args.slug}" already exists`,
        409
      );
    }
    throw err;
  }
  const typeId = Number((inserted[0] as { id: unknown }).id);

  // Only write the reciprocal back-link when the caller owns the inverse type.
  // A public inverse from another org must never be mutated by this tenant.
  if (inverseTypeId !== null && inverseOwnedByCaller) {
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
      rt.status, rt.purpose, rt.created_at, rt.updated_at
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    WHERE rt.id = ${typeId}
  `;

  recordToolConfigChange(ctx, {
    resourceKind: 'relationship-type',
    resourceId: args.slug,
    op: 'created',
    summary: `Relationship type '${args.name}' created`,
    state: created[0] as unknown as Record<string, unknown>,
  });

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

  // A config can declare member_of before its first ACL sync classifies the row,
  // and may update harmless fields while it is still unclassified. It may not
  // archive the type: the materializer upserts against active slugs, so the next
  // sync would create a second type while existing grants remain attached to the
  // old one and stop being reconciled.
  if (
    isAclManagedRelationshipSlug(args.slug ?? '') &&
    args.status === 'archived'
  ) {
    throw new ToolUserError(
      `Relationship type '${args.slug}' is ACL-managed and cannot be archived`,
      403
    );
  }

  // `is_symmetric` is create-only (contract: `[relationship_type: create]`).
  // It's load-bearing for relationship canonicalization/dedup at write time
  // (manage_entity.ts canonicalizes a→b / b→a as one edge when symmetric), so
  // flipping it on a populated type would not migrate existing rows and would
  // change dedup semantics for new ones. Reject on update instead of silently
  // dropping (the UPDATE SET clause below has no is_symmetric arm, so before
  // this guard an update carrying it returned success with the row unchanged).
  if (args.is_symmetric !== undefined) {
    throw new ToolUserError(
      "is_symmetric is create-only and cannot be changed on update — it affects relationship canonicalization/dedup for existing rows. To change it, create a new relationship type and migrate.",
      422,
    );
  }

  let inverseTypeId: number | null | undefined;
  if (args.inverse_type_slug !== undefined) {
    if (args.inverse_type_slug === null || args.inverse_type_slug === '') {
      inverseTypeId = null;
    } else {
      const inverse = await resolveInverseType(sql, args.inverse_type_slug, ctx);
      if (inverse.id === typeId) throw new ToolUserError('inverse_type_id cannot point to self', 422);
      inverseTypeId = inverse.id;
    }
  }

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
      rt.status, rt.purpose, rt.created_at, rt.updated_at
    FROM entity_relationship_types rt
    LEFT JOIN entity_relationship_types inv ON rt.inverse_type_id = inv.id
    WHERE rt.id = ${typeId}
  `;

  const rtChangedFields = [
    ...(args.name !== undefined ? ['name'] : []),
    ...(args.description !== undefined ? ['description'] : []),
    ...(args.metadata_schema !== undefined ? ['metadata_schema'] : []),
    ...(args.inverse_type_slug !== undefined ? ['inverse_type_id'] : []),
    ...(args.status !== undefined ? ['status'] : []),
  ];
  recordToolConfigChange(ctx, {
    resourceKind: 'relationship-type',
    resourceId: args.slug ?? typeId,
    op: 'updated',
    summary: `Relationship type '${args.slug ?? typeId}' updated`,
    state: updated[0] as unknown as Record<string, unknown>,
    ...(rtChangedFields.length > 0 ? { changedFields: rtChangedFields } : {}),
  });

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

  // Refuse while relationship instances exist — mirrors entity-type delete so
  // `lobu apply` prune (and the UI) can never orphan live relationship data
  // under a deleted definition.
  const relationshipCount = await getRelationshipCountForType(typeId, ctx.organizationId);
  if (relationshipCount > 0) {
    throw new ToolUserError(
      `Cannot delete relationship type '${args.slug}': ${relationshipCount} relationships of this type exist. Remove or reassign them first.`,
      409
    );
  }

  // Set status='archived' alongside deleted_at: the org/slug uniqueness index
  // is partial on `WHERE status = 'active'` (NOT `deleted_at IS NULL`, unlike
  // entity_types), so leaving status='active' keeps the tombstoned row in the
  // index and a later re-create of the same slug (e.g. `lobu apply` prune then
  // re-add) hits a unique violation. 'archived' is the only other status the
  // check constraint allows; it vacates the index. The create dedup filters on
  // deleted_at IS NULL, so the archived tombstone never blocks the re-create.
  await sql`
    UPDATE entity_relationship_types
    SET deleted_at = current_timestamp, status = 'archived', updated_at = current_timestamp
    WHERE id = ${typeId}
  `;

  await sql`
    UPDATE entity_relationship_type_rules
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE relationship_type_id = ${typeId} AND deleted_at IS NULL
  `;

  recordToolConfigChange(ctx, {
    resourceKind: 'relationship-type',
    resourceId: args.slug ?? typeId,
    op: 'deleted',
    summary: `Relationship type '${args.slug ?? typeId}' deleted`,
    state: null,
  });

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
    throw new ToolUserError('source_entity_type_slug is required for add_rule action', 400);
  if (!args.target_entity_type_slug)
    throw new ToolUserError('target_entity_type_slug is required for add_rule action', 400);

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
    // Coded 409 — `lobu apply` treats a duplicate add_rule as success (idempotent).
    throw new ToolUserError(
      `[already_exists] Rule already exists for ${args.source_entity_type_slug} → ${args.target_entity_type_slug}`,
      409
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

  recordToolConfigChange(ctx, {
    resourceKind: 'relationship-type',
    resourceId: args.slug ?? typeId,
    op: 'updated',
    summary: `Relationship type '${args.slug ?? typeId}' rule added: ${args.source_entity_type_slug} → ${args.target_entity_type_slug}`,
    // Full relationship-type state isn't in scope here; snapshot the rule delta.
    state: {
      slug: args.slug ?? null,
      rule_added: created[0] as unknown as Record<string, unknown>,
    },
    changedFields: ['rules'],
  });

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
  if (!args.rule_id) throw new ToolUserError('rule_id is required for remove_rule action', 400);

  const sql = getDb();

  const ruleRows = await sql`
    SELECT r.id, rt.organization_id, rt.slug AS relationship_type_slug, rt.purpose
    FROM entity_relationship_type_rules r
    JOIN entity_relationship_types rt ON r.relationship_type_id = rt.id
    WHERE r.id = ${args.rule_id} AND r.deleted_at IS NULL
    LIMIT 1
  `;
  if (ruleRows.length === 0) throw new ToolUserError(`Rule ${args.rule_id} not found`, 404);

  const ruleOrgId = String(ruleRows[0].organization_id ?? '');
  if (ruleOrgId && ruleOrgId !== ctx.organizationId) {
    throw new ToolUserError('Access denied: rule belongs to another organization', 403);
  }

  // This handler resolves by rule_id, so unlike add_rule it never passes through
  // `requireRelationshipType` and needs its own check: the type-pair rules of an
  // authorization type constrain which entity kinds it may connect, and dropping
  // them widens the access vocabulary.
  assertNotAuthorizationType(
    {
      slug: String(ruleRows[0].relationship_type_slug ?? ''),
      purpose: ruleRows[0].purpose as string | null,
    },
    'remove_rule'
  );

  await sql`
    UPDATE entity_relationship_type_rules
    SET deleted_at = current_timestamp, updated_at = current_timestamp
    WHERE id = ${args.rule_id}
  `;

  const removedRuleTypeSlug = String(ruleRows[0].relationship_type_slug ?? '');
  recordToolConfigChange(ctx, {
    resourceKind: 'relationship-type',
    resourceId: removedRuleTypeSlug || args.rule_id,
    op: 'updated',
    summary: `Relationship type '${removedRuleTypeSlug || args.rule_id}' rule ${args.rule_id} removed`,
    // Full relationship-type state isn't in scope here; snapshot the rule delta.
    state: {
      slug: removedRuleTypeSlug || null,
      rule_removed: args.rule_id,
    },
    changedFields: ['rules'],
  });

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
