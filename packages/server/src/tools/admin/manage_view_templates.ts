/**
 * Tool: manage_view_templates
 *
 * Unified view template versioning for entity types and individual entities.
 * Actions: set, get, rollback, remove_tab
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import { emit } from '../../events/emitter';
import { ToolUserError } from '../../utils/errors';
import { validateDataSourceQuery } from '../../utils/execute-data-sources';
import { resolveUsernames } from '../../utils/resolve-usernames';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { defineFlatActionTool, flatAction } from './action-tool';

// ============================================
// View template versioning types + helpers
// ============================================

interface ViewTemplateVersionRow {
  id: number;
  version: number;
  tab_name: string | null;
  tab_order: number;
  json_template: Record<string, unknown>;
  change_notes: string | null;
  created_by: string;
  created_by_username: string | null;
  created_at: string;
}

interface ViewTemplateTabInfo {
  tab_name: string;
  tab_order: number;
  current_version: number;
  current_version_id: number;
  json_template: Record<string, unknown>;
}

function mapVersionRow(row: Record<string, unknown>): ViewTemplateVersionRow {
  return {
    id: Number(row.id),
    version: Number(row.version),
    tab_name: row.tab_name ? String(row.tab_name) : null,
    tab_order: Number(row.tab_order) || 0,
    json_template: row.json_template as Record<string, unknown>,
    change_notes: row.change_notes ? String(row.change_notes) : null,
    created_by: String(row.created_by),
    created_by_username: row.created_by_username ? String(row.created_by_username) : null,
    created_at: String(row.created_at),
  };
}

// ============================================
// Schema
// ============================================

export const ManageViewTemplatesSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('set'),
      Type.Literal('get'),
      Type.Literal('rollback'),
      Type.Literal('remove_tab'),
    ],
    { description: 'Action to perform' }
  ),

  resource_type: Type.Union([Type.Literal('entity_type'), Type.Literal('entity')], {
    description: 'Type of resource: entity_type or entity',
  }),
  resource_id: Type.Union([Type.String(), Type.Number()], {
    description: 'Resource identifier: entity type slug (string) or entity id (number)',
  }),

  json_template: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        '[set] The JSON template content. May include a data_sources key: { "data_sources": { "name": { "query": "SELECT ... FROM entities" } }, ...template }. Queries run against org-scoped virtual tables. Use {{entityId}} for current entity context.',
    })
  ),
  tab_name: Type.Optional(
    Type.String({
      description: 'Tab name. Omit for the default/overview tab.',
    })
  ),
  tab_order: Type.Optional(Type.Number({ description: '[set] Sort order for tabs (default 0)' })),
  change_notes: Type.Optional(Type.String({ description: '[set] Notes describing the change' })),
  version: Type.Optional(Type.Number({ description: '[rollback] Version number to rollback to' })),
});

type ManageViewTemplatesArgs = Static<typeof ManageViewTemplatesSchema>;

// ============================================
// Result Types
// ============================================

type ManageViewTemplatesResult =
  | { action: 'set'; version: ViewTemplateVersionRow; message: string }
  | {
      action: 'get';
      default_tab: { current: ViewTemplateVersionRow | null; history: ViewTemplateVersionRow[] };
      tabs: ViewTemplateTabInfo[];
    }
  | { action: 'rollback'; version: ViewTemplateVersionRow; message: string }
  | { action: 'remove_tab'; success: boolean; message: string };

// ============================================
// Main Function
// ============================================

export const manageViewTemplates = withValidatedArgs(
  'manage_view_templates',
  ManageViewTemplatesSchema,
  defineFlatActionTool<ManageViewTemplatesArgs, ManageViewTemplatesResult>(
    'manage_view_templates',
    {
      set: flatAction(handleSet),
      get: flatAction(handleGet),
      rollback: flatAction(handleRollback),
      remove_tab: flatAction(handleRemoveTab),
    }
  )
);

// ============================================
// Helpers
// ============================================

/** Column on the parent table that holds the default tab FK */
function parentTable(resourceType: string): string {
  if (resourceType === 'entity_type') return 'entity_types';
  if (resourceType === 'entity') return 'entities';
  throw new Error(`Unknown resource type: ${resourceType}`);
}

/** Resolve resource_id to a consistent string for view_template_versions.resource_id */
function rid(args: ManageViewTemplatesArgs): string {
  return String(args.resource_id);
}

/** Verify the resource exists and the caller has access. Returns the numeric row id. */
async function verifyAccess(
  sql: ReturnType<typeof getDb>,
  args: ManageViewTemplatesArgs,
  ctx: ToolContext,
  requireWrite: boolean
): Promise<number> {
  if (requireWrite && !ctx.userId) throw new Error('Authentication required');

  const rt = args.resource_type;

  // Boundary validation (`withValidatedArgs`) guarantees resource_type and
  // resource_id are present and well-typed, but a whitespace-only string
  // still satisfies the schema and would query for a blank slug.
  if (String(args.resource_id).trim() === '') {
    throw new ToolUserError(`resource_id is required (got ${JSON.stringify(args.resource_id)})`);
  }

  const id = rid(args);

  if (rt === 'entity_type') {
    const rows = await sql`
      SELECT id, organization_id, created_by FROM entity_types
      WHERE slug = ${id} AND deleted_at IS NULL
        AND (organization_id = ${ctx.organizationId} OR organization_id IS NULL)
      LIMIT 1
    `;
    if (rows.length === 0) throw new ToolUserError(`Entity type '${id}' not found`, 404);
    if (requireWrite && rows[0].organization_id !== ctx.organizationId) {
      throw new ToolUserError(`Access denied: entity type '${id}' belongs to another organization`, 403);
    }
    return Number(rows[0].id);
  }

  // entity
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    throw new ToolUserError(
      `resource_id must be a numeric entity id for resource_type 'entity' (got ${JSON.stringify(args.resource_id)})`
    );
  }
  const rows = await sql`
    SELECT id FROM entities
    WHERE id = ${numericId} AND organization_id = ${ctx.organizationId}
    LIMIT 1
  `;
  if (rows.length === 0) throw new Error(`Entity ${id} not found`);
  return Number(rows[0].id);
}

// ============================================
// Action Handlers
// ============================================

function validateDataSources(dataSources: unknown): void {
  if (dataSources === undefined || dataSources === null) return;
  if (typeof dataSources !== 'object' || Array.isArray(dataSources)) {
    throw new Error('data_sources must be an object');
  }
  for (const [name, entry] of Object.entries(dataSources as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`data_sources.${name}: must be an object with a query`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.query !== 'string' || !e.query.trim()) {
      throw new Error(`data_sources.${name}: query must be a non-empty string`);
    }
    // Save-time: also validates SQL syntax and schema-qualified refs
    validateDataSourceQuery(name, e.query.trim(), true);
  }
}

async function handleSet(
  args: ManageViewTemplatesArgs,
  ctx: ToolContext
): Promise<ManageViewTemplatesResult> {
  if (!args.json_template) throw new Error('json_template is required for set action');

  validateDataSources(args.json_template.data_sources);

  const sql = getDb();
  const rowId = await verifyAccess(sql, args, ctx, true);
  const resourceId = rid(args);
  const tabName = args.tab_name ?? null;
  const tabOrder = args.tab_order ?? 0;

  const versionRow = await sql.begin(async (tx: typeof sql) => {
    const inserted = await tx`
      INSERT INTO view_template_versions (
        resource_type, resource_id, organization_id, version, tab_name, tab_order,
        json_template, change_notes, created_by, created_at
      )
      SELECT
        ${args.resource_type}, ${resourceId}, ${ctx.organizationId},
        COALESCE(MAX(v.version), 0) + 1,
        ${tabName}, ${tabOrder},
        ${sql.json(args.json_template)},
        ${args.change_notes ?? null},
        ${ctx.userId}, current_timestamp
      FROM view_template_versions v
      WHERE v.resource_type = ${args.resource_type}
        AND v.resource_id = ${resourceId}
        AND v.organization_id = ${ctx.organizationId}
        AND v.tab_name ${tabName === null ? tx`IS NULL` : tx`= ${tabName}`}
      RETURNING id, version, tab_name, tab_order, json_template, change_notes, created_by, created_at
    `;
    const row = inserted[0];
    const vid = Number(row.id);

    if (tabName === null) {
      await tx.unsafe(
        `UPDATE ${parentTable(args.resource_type)}
         SET current_view_template_version_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [vid, rowId]
      );
    } else {
      await tx`
        INSERT INTO view_template_active_tabs (
          resource_type, resource_id, organization_id, tab_name, tab_order, current_version_id
        ) VALUES (
          ${args.resource_type}, ${resourceId}, ${ctx.organizationId},
          ${tabName}, ${tabOrder}, ${vid}
        )
        ON CONFLICT (resource_type, resource_id, organization_id, tab_name)
        DO UPDATE SET current_version_id = ${vid}, tab_order = ${tabOrder}
      `;
      // Phase 3a: also maintain is_current + tab_order directly on the version
      // rows (transition off the trigger — kept until phase 3b drops it; both
      // produce the same result). Clear-then-set keeps the partial unique index
      // safe. tab_order is the requested display order for a set.
      await tx`
        UPDATE view_template_versions SET is_current = false
        WHERE resource_type = ${args.resource_type} AND resource_id = ${resourceId}
          AND organization_id = ${ctx.organizationId} AND tab_name = ${tabName}
          AND is_current = true AND id <> ${vid}
      `;
      await tx`UPDATE view_template_versions SET is_current = true, tab_order = ${tabOrder} WHERE id = ${vid}`;
    }

    return row;
  });

  const v = Number(versionRow.version);

  emit(ctx.organizationId, {
    keys: ['resolve-path', 'entity-types', 'view-template-history'],
  });

  const [resolved] = await resolveUsernames([versionRow as Record<string, unknown>], 'created_by');

  return {
    action: 'set',
    version: mapVersionRow(resolved),
    message: tabName ? `Tab '${tabName}' set to v${v}` : `Default view template set to v${v}`,
  };
}

async function handleGet(
  args: ManageViewTemplatesArgs,
  ctx: ToolContext
): Promise<ManageViewTemplatesResult> {
  const sql = getDb();
  const rowId = await verifyAccess(sql, args, ctx, false);
  const resourceId = rid(args);

  // Current default version
  const parentRows = await sql.unsafe(
    `SELECT current_view_template_version_id FROM ${parentTable(args.resource_type)} WHERE id = $1 LIMIT 1`,
    [rowId]
  );
  const currentVersionId = parentRows[0]?.current_view_template_version_id;

  let currentDefault: ViewTemplateVersionRow | null = null;
  if (currentVersionId) {
    const row = await sql`
      SELECT id, version, tab_name, tab_order, json_template, change_notes, created_by, created_at
      FROM view_template_versions WHERE id = ${currentVersionId}
    `;
    if (row.length > 0) {
      const [resolved] = await resolveUsernames([row[0] as Record<string, unknown>], 'created_by');
      currentDefault = mapVersionRow(resolved);
    }
  }

  // Default tab history
  const history = await sql`
    SELECT id, version, tab_name, tab_order, json_template, change_notes, created_by, created_at
    FROM view_template_versions
    WHERE resource_type = ${args.resource_type}
      AND resource_id = ${resourceId}
      AND organization_id = ${ctx.organizationId}
      AND tab_name IS NULL
    ORDER BY version DESC
  `;
  const resolvedHistory = await resolveUsernames(
    history as unknown as Record<string, unknown>[],
    'created_by'
  );

  // Named tabs — render-store consolidation phase 2: read from is_current on
  // view_template_versions (trigger-synced with the legacy active_tabs pointer).
  const tabRows = await sql`
    SELECT
      vtv.tab_name, vtv.tab_order,
      vtv.version as current_version, vtv.id as current_version_id,
      vtv.json_template
    FROM view_template_versions vtv
    WHERE vtv.resource_type = ${args.resource_type}
      AND vtv.resource_id = ${resourceId}
      AND vtv.organization_id = ${ctx.organizationId}
      AND vtv.tab_name IS NOT NULL
      AND vtv.is_current = true
    ORDER BY vtv.tab_order ASC, vtv.tab_name ASC
  `;

  return {
    action: 'get',
    default_tab: {
      current: currentDefault,
      history: resolvedHistory.map((r) => mapVersionRow(r)),
    },
    tabs: tabRows.map((r: any) => ({
      tab_name: String(r.tab_name),
      tab_order: Number(r.tab_order),
      current_version: Number(r.current_version),
      current_version_id: Number(r.current_version_id),
      json_template: r.json_template as Record<string, unknown>,
    })),
  };
}

async function handleRollback(
  args: ManageViewTemplatesArgs,
  ctx: ToolContext
): Promise<ManageViewTemplatesResult> {
  if (args.version === undefined) throw new Error('version is required for rollback action');

  const sql = getDb();
  const rowId = await verifyAccess(sql, args, ctx, true);
  const resourceId = rid(args);
  const tabName = args.tab_name ?? null;

  const versionRow = await sql.begin(async (tx: typeof sql) => {
    const versionRows = await tx`
      SELECT id, version, tab_name, tab_order, json_template, change_notes, created_by, created_at
      FROM view_template_versions
      WHERE resource_type = ${args.resource_type}
        AND resource_id = ${resourceId}
        AND organization_id = ${ctx.organizationId}
        AND version = ${args.version}
        AND tab_name ${tabName === null ? tx`IS NULL` : tx`= ${tabName}`}
      LIMIT 1
    `;
    if (versionRows.length === 0) {
      throw new Error(`Version ${args.version} not found${tabName ? ` for tab '${tabName}'` : ''}`);
    }

    const row = versionRows[0];
    const versionId = Number(row.id);

    if (tabName === null) {
      await tx.unsafe(
        `UPDATE ${parentTable(args.resource_type)}
         SET current_view_template_version_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [versionId, rowId]
      );
    } else {
      const updated = await tx`
        UPDATE view_template_active_tabs
        SET current_version_id = ${versionId}
        WHERE resource_type = ${args.resource_type}
          AND resource_id = ${resourceId}
          AND organization_id = ${ctx.organizationId}
          AND tab_name = ${tabName}
        RETURNING id
      `;
      if (updated.length === 0) {
        throw new Error(`Tab '${tabName}' has no active entry to rollback`);
      }
      // Phase 3a: maintain is_current + tab_order directly, preserving the tab's
      // display order across the rollback (order is a tab-level property; rollback
      // changes only which version is current). The order read below resolves to
      // the unchanged pointer order in BOTH trigger states: trigger-ON it reads the
      // just-re-pointed current version (the trigger already stamped the pointer
      // order onto it); trigger-OFF (phase 3b) it reads the still-current outgoing
      // version, which carries the same tab-level order. Either way the rolled-back
      // version inherits the preserved order.
      const curOrderRows = await tx`
        SELECT tab_order FROM view_template_versions
        WHERE resource_type = ${args.resource_type} AND resource_id = ${resourceId}
          AND organization_id = ${ctx.organizationId} AND tab_name = ${tabName}
          AND is_current = true LIMIT 1
      `;
      const curOrder = curOrderRows.length > 0 ? Number(curOrderRows[0].tab_order) : 0;
      await tx`
        UPDATE view_template_versions SET is_current = false
        WHERE resource_type = ${args.resource_type} AND resource_id = ${resourceId}
          AND organization_id = ${ctx.organizationId} AND tab_name = ${tabName}
          AND is_current = true AND id <> ${versionId}
      `;
      await tx`UPDATE view_template_versions SET is_current = true, tab_order = ${curOrder} WHERE id = ${versionId}`;
    }

    return row;
  });

  emit(ctx.organizationId, {
    keys: ['resolve-path', 'entity-types', 'view-template-history'],
  });

  const [resolvedVersion] = await resolveUsernames(
    [versionRow as Record<string, unknown>],
    'created_by'
  );

  return {
    action: 'rollback',
    version: mapVersionRow(resolvedVersion),
    message: `Rolled back to v${args.version}${tabName ? ` for tab '${tabName}'` : ''}`,
  };
}

async function handleRemoveTab(
  args: ManageViewTemplatesArgs,
  ctx: ToolContext
): Promise<ManageViewTemplatesResult> {
  if (!args.tab_name) throw new Error('tab_name is required for remove_tab action');

  const sql = getDb();
  await verifyAccess(sql, args, ctx, true);
  const resourceId = rid(args);

  // Phase 3a: delete the active pointer and clear is_current atomically (reads
  // are now on is_current, so a partial remove would leave a phantom tab).
  await sql.begin(async (tx) => {
    const del = await tx`
      DELETE FROM view_template_active_tabs
      WHERE resource_type = ${args.resource_type}
        AND resource_id = ${resourceId}
        AND organization_id = ${ctx.organizationId}
        AND tab_name = ${args.tab_name}
      RETURNING id
    `;
    if (del.length === 0) {
      throw new Error(`Tab '${args.tab_name}' not found`);
    }
    await tx`
      UPDATE view_template_versions SET is_current = false
      WHERE resource_type = ${args.resource_type} AND resource_id = ${resourceId}
        AND organization_id = ${ctx.organizationId} AND tab_name = ${args.tab_name}
        AND is_current = true
    `;
  });

  emit(ctx.organizationId, {
    keys: ['resolve-path', 'entity-types', 'view-template-history'],
  });

  return {
    action: 'remove_tab',
    success: true,
    message: `Tab '${args.tab_name}' removed`,
  };
}
