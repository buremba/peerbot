/**
 * Tool: resolve_path
 *
 * Resolves a URL path like /acme/company/spotify into
 * workspace + entity details by walking the entity hierarchy.
 *
 * URL pattern: /:owner/entity-type/entity-slug/...
 */

import * as Sentry from '@sentry/node';
import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { feedLinkedToBusinessEntitySql } from '../authz/channel-about';
import { entityLinkMatchSql } from '../utils/content-search';
import {
  type DataSourceContext,
  type DataSourceInput,
  executeDataSources,
} from '../utils/execute-data-sources';
import { ToolUserError } from '../utils/errors';
import { resolveMemberSchemaFieldsFromSchema } from '../utils/member-entity-type';
import { stripMemberEmailsFromRows } from '../utils/member-redaction';
import { derivedRowName, derivedRowSlug } from '../utils/entity-management';
import { buildDefaultEntityTemplate } from '../utils/default-entity-template';
import { measureColumns as inferMeasureColumns } from '../utils/infer-measures';
import { RESERVED_PATHS } from '../utils/reserved';
import { getWorkspaceProvider } from '../workspace';
import { querySqlImpl } from './admin/query_sql';
import { isAdminOrOwnerRole } from './access-control';
import { MEMBER_ENTITY_TYPE_SLUG } from './constants';
import type { ToolContext } from './registry';
import { withValidatedArgs } from './validate-args';

export const ResolvePathSchema = Type.Object({
  path: Type.String({
    description: 'URL path like /acme/company/spotify (query string optional)',
    minLength: 1,
  }),
  include_bootstrap: Type.Optional(
    Type.Boolean({
      description:
        'When true, includes shared bootstrap data for sidebar and overview pages in the response',
      default: false,
    })
  ),
});

type ResolvePathArgs = Static<typeof ResolvePathSchema>;

export const ResolvedWorkspaceSchema = Type.Object({
  slug: Type.String(),
  type: Type.Union([Type.Literal('user'), Type.Literal('organization')]),
  id: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
});
export type ResolvedWorkspace = Static<typeof ResolvedWorkspaceSchema>;

export const ResolvedPathEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
});
export type ResolvedPathEntity = Static<typeof ResolvedPathEntitySchema>;

const ViewTemplateTabSchema = Type.Object({
  tab_name: Type.String(),
  tab_order: Type.Integer(),
  json_template: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  version_id: Type.Integer(),
  template_data: Type.Union([
    Type.Record(Type.String(), Type.Array(Type.Unknown())),
    Type.Null(),
  ]),
});
type ViewTemplateTab = Static<typeof ViewTemplateTabSchema>;

// ResolvedEntityDetails = ResolvedPathEntity + detail fields. TypeBox has no
// `extends`; compose via intersect so the derived type stays a single source.
export const ResolvedEntityDetailsSchema = Type.Intersect([
  ResolvedPathEntitySchema,
  Type.Object({
    parent_id: Type.Union([Type.Integer(), Type.Null()]),
    metadata: Type.Record(Type.String(), Type.Unknown()),
    /** Per-field human-ownership markers (key present = a human set that field).
     *  Lets the UI badge owned fields + show the correction note. */
    field_controls: Type.Record(
      Type.String(),
      Type.Object({
        note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        set_by: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        set_at: Type.Optional(Type.String()),
      })
    ),
    json_template: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    json_template_version: Type.Union([Type.Integer(), Type.Null()]),
    template_data: Type.Union([
      Type.Record(Type.String(), Type.Array(Type.Unknown())),
      Type.Null(),
    ]),
    tabs: Type.Array(ViewTemplateTabSchema),
    created_at: Type.String(),
    // Stats
    total_content: Type.Integer(),
    active_connections: Type.Integer(),
    watchers_count: Type.Integer(),
    // Derived ("view") entity: synthesized from the type's `backing_sql` filtered
    // to this slug, not a stored `entities` row. `metadata` holds the full view
    // row; `measure_columns` are its aggregate columns. Stored entities omit both.
    is_derived: Type.Optional(Type.Boolean()),
    measure_columns: Type.Optional(Type.Array(Type.String())),
  }),
]);
export type ResolvedEntityDetails = Static<typeof ResolvedEntityDetailsSchema>;

export const ChildEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  market: Type.Union([Type.String(), Type.Null()]),
  content_count: Type.Integer(),
});
export type ChildEntity = Static<typeof ChildEntitySchema>;

interface ResolvedEntityRow {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  parent_id: number | null;
  metadata: Record<string, any> | null;
  field_controls?: Record<string, unknown> | null;
  created_at: Date;
}

export const SiblingEntitySchema = Type.Object({
  id: Type.Integer(),
  entity_type: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  content_count: Type.Integer(),
});
export type SiblingEntity = Static<typeof SiblingEntitySchema>;

const BootstrapEntityTypeSummarySchema = Type.Object({
  id: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  icon: Type.Union([Type.String(), Type.Null()]),
  color: Type.Union([Type.String(), Type.Null()]),
  entity_count: Type.Integer(),
});

const BootstrapScopeSummarySchema = Type.Object({
  total_content: Type.Integer(),
  active_connections: Type.Integer(),
  watchers_count: Type.Integer(),
  // Org-level regardless of the focused entity (sidebar nav badges).
  agents_count: Type.Integer(),
  // Devices are owned by the requesting user, not the org — count is per-user.
  devices_count: Type.Integer(),
});

const BootstrapContentItemSchema = Type.Object({
  id: Type.Integer(),
  entity_ids: Type.Array(Type.Integer()),
  platform: Type.String(),
  entity_name: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  text_content: Type.String(),
  source_url: Type.Union([Type.String(), Type.Null()]),
  author_name: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  occurred_at: Type.Union([Type.String(), Type.Null()]),
});

const BootstrapFeedItemSchema = Type.Object({
  id: Type.Integer(),
  connection_id: Type.Integer(),
  connector_key: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  entity_ids: Type.Array(Type.Integer()),
  connector_name: Type.Union([Type.String(), Type.Null()]),
  connection_name: Type.Union([Type.String(), Type.Null()]),
  event_count: Type.Integer(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

const BootstrapWatcherItemSchema = Type.Object({
  watcher_id: Type.String(),
  name: Type.String(),
  status: Type.String(),
  schedule: Type.String(),
  entity_id: Type.Union([Type.Integer(), Type.Null()]),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity_name: Type.Union([Type.String(), Type.Null()]),
  entity_slug: Type.Union([Type.String(), Type.Null()]),
  parent_slug: Type.Union([Type.String(), Type.Null()]),
  parent_entity_type: Type.Union([Type.String(), Type.Null()]),
  organization_slug: Type.String(),
  windows_count: Type.Integer(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

const BootstrapConnectorDefinitionSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  icon: Type.Union([Type.String(), Type.Null()]),
  favicon_domain: Type.Union([Type.String(), Type.Null()]),
});

export const ResolvePathBootstrapSchema = Type.Object({
  entity_types: Type.Array(BootstrapEntityTypeSummarySchema),
  summary: BootstrapScopeSummarySchema,
  recent_content: Type.Array(BootstrapContentItemSchema),
  recent_feeds: Type.Array(BootstrapFeedItemSchema),
  recent_watchers: Type.Array(BootstrapWatcherItemSchema),
  connector_definitions: Type.Array(BootstrapConnectorDefinitionSchema),
});
export type ResolvePathBootstrap = Static<typeof ResolvePathBootstrapSchema>;
// Handlers reference these by name; alias each from its schema.
type BootstrapEntityTypeSummary = Static<typeof BootstrapEntityTypeSummarySchema>;
type BootstrapScopeSummary = Static<typeof BootstrapScopeSummarySchema>;
type BootstrapContentItem = Static<typeof BootstrapContentItemSchema>;
type BootstrapFeedItem = Static<typeof BootstrapFeedItemSchema>;
type BootstrapWatcherItem = Static<typeof BootstrapWatcherItemSchema>;
type BootstrapConnectorDefinition = Static<typeof BootstrapConnectorDefinitionSchema>;

/**
 * Coerce a timestamp value from a SQL row to an ISO string, tolerating NULL.
 * `new Date(String(null)).toISOString()` throws (`new Date('null')` is Invalid
 * Date → RangeError), and the feed/watcher queries ORDER BY
 * `COALESCE(updated_at, created_at)` precisely because `updated_at` can be NULL.
 * `fallback` supplies that same coalesced value so a non-null `updated_at`
 * column stays a non-null string in the result. If both are absent, returns the
 * epoch — a valid ISO string keeps the (non-nullable) schema field satisfied
 * rather than throwing or emitting an invalid `structuredContent`.
 */
function toIso(value: unknown, fallback?: unknown): string {
  for (const candidate of [value, fallback]) {
    if (candidate == null) continue;
    const date = new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * Output schema for `resolve_path`. TypeBox-first: every nested type is
 * `Static<>`-derived from its schema, so this object composes them into one
 * source of truth for both the TS type (`ResolvePathResult`) and the MCP
 * `outputSchema`. No hand-written interface mirrors it.
 */
export const ResolvePathResultSchema = Type.Object({
  workspace: ResolvedWorkspaceSchema,
  segments: Type.Array(
    Type.Object({ entity_type: Type.String(), slug: Type.String() })
  ),
  path: Type.Array(ResolvedPathEntitySchema),
  entity: Type.Union([ResolvedEntityDetailsSchema, Type.Null()]),
  children: Type.Array(ChildEntitySchema),
  siblings: Type.Array(SiblingEntitySchema),
  bootstrap: Type.Union([ResolvePathBootstrapSchema, Type.Null()]),
});
export type ResolvePathResult = Static<typeof ResolvePathResultSchema>;

const BOOTSTRAP_RECENT_LIMIT = 8;

/**
 * Extract `data_sources` from a json_template, execute them, and return
 * the cleaned template + results.
 */
async function processTemplateDataSources(
  jsonTemplate: Record<string, any> | null,
  context: DataSourceContext,
  sql: DbClient
): Promise<{
  cleanTemplate: Record<string, any> | null;
  templateData: Record<string, unknown[]> | null;
}> {
  if (!jsonTemplate || !jsonTemplate.data_sources) {
    return { cleanTemplate: jsonTemplate, templateData: null };
  }

  const dataSources = jsonTemplate.data_sources as DataSourceInput;
  const { data_sources: _, ...cleanTemplate } = jsonTemplate;
  const templateData = await executeDataSources(dataSources, context, sql);
  return { cleanTemplate, templateData };
}

/**
 * Process data sources for an array of tabs.
 */
async function processTabsDataSources(
  tabs: ViewTemplateTab[],
  context: DataSourceContext,
  sql: DbClient
): Promise<ViewTemplateTab[]> {
  return Promise.all(
    tabs.map(async (tab) => {
      const { cleanTemplate, templateData } = await processTemplateDataSources(
        tab.json_template,
        context,
        sql
      );
      return {
        ...tab,
        json_template: cleanTemplate ?? tab.json_template,
        template_data: templateData,
      };
    })
  );
}

function parsePathAndQuery(rawPath: string): { path: string; query: Record<string, string> } {
  if (!rawPath) return { path: '/', query: {} };
  const [pathPart = '', queryString] = rawPath.split('?', 2);
  const cleaned = pathPart.split('#')[0];
  const path = `/${cleaned.replace(/^\/+|\/+$/g, '')}`;

  const query: Record<string, string> = {};
  if (queryString) {
    for (const param of queryString.split('&')) {
      const [key, ...rest] = param.split('=');
      if (key) query[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
    }
  }
  return { path, query };
}

export const resolvePath = withValidatedArgs(
  'resolve_path',
  ResolvePathSchema,
  (args: ResolvePathArgs, _env: Env, ctx: ToolContext): Promise<ResolvePathResult> =>
    Sentry.startSpan(
      { name: 'resolve_path', op: 'function', attributes: { path: args.path } },
      () => _resolvePath(args, ctx)
    )
);

async function _resolvePath(
  args: ResolvePathArgs,
  ctx: ToolContext
): Promise<ResolvePathResult> {
  const { path: normalized, query: urlQuery } = parsePathAndQuery(args.path);
  const segments = normalized
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);

  if (segments.length === 0) {
    throw new ToolUserError('Path must include an owner', 400);
  }

  const ownerRaw = segments[0];
  const isUserSpace = ownerRaw.startsWith('@');
  const ownerSlug = isUserSpace ? ownerRaw.slice(1) : ownerRaw;

  if (RESERVED_PATHS.includes(ownerSlug)) {
    throw new ToolUserError(`Owner '${ownerSlug}' is reserved`, 400);
  }

  const sql = getDb();

  const resolved = await Sentry.startSpan({ name: 'resolveOwner', op: 'db' }, () =>
    getWorkspaceProvider().resolveOwner(ownerSlug, isUserSpace ? 'user' : 'organization')
  );

  if (!resolved) {
    throw new ToolUserError(
      `${isUserSpace ? 'User' : 'Organization'} '${ownerSlug}' not found`,
      404
    );
  }

  const workspace: ResolvedWorkspace = {
    slug: resolved.slug,
    type: resolved.type,
    id: resolved.id,
    name: resolved.name,
  };

  const remaining = segments.slice(1);
  let entitySegments: string[];

  if (remaining.length === 0) {
    const bootstrap = args.include_bootstrap
      ? await fetchBootstrap(sql, ctx, workspace, null)
      : null;
    return emptyResult(workspace, bootstrap);
  }

  entitySegments = remaining;

  if (entitySegments.length % 2 !== 0) {
    // Frontend routes like /:owner/agents/:slug/settings have a UI subroute
    // appended after the entity tail. Treat the malformed-pair case as a
    // not-found so the client can fall back without surfacing a 500.
    throw new ToolUserError(
      `Entity path '${normalized}' is not resolvable: expected [type]/[slug] pairs after the owner`,
      404
    );
  }

  const parsedSegments: Array<{ entity_type: string; slug: string }> = [];
  for (let i = 0; i < entitySegments.length; i += 2) {
    parsedSegments.push({
      entity_type: entitySegments[i],
      slug: entitySegments[i + 1],
    });
  }

  if (workspace.type !== 'organization') {
    throw new ToolUserError('Entity paths require an organization namespace', 400);
  }

  let parentId: number | null = null;
  const resolvedPath: ResolvedPathEntity[] = [];
  let resolvedEntity: ResolvedEntityDetails | null = null;

  for (let i = 0; i < parsedSegments.length; i += 1) {
    const segment = parsedSegments[i]!;
    const isLeaf = i === parsedSegments.length - 1;

    if (!isLeaf) {
      // Lightweight query for intermediate path entities – no COUNT subqueries, no template joins.
      // Cross-org tolerance: a tenant path can traverse into a public-catalog entity.
      // $member is per-tenant — never fall back to a public catalog's $member row, since
      // member-redaction uses the caller's workspace role, not the resolved entity's org.
      const row = await sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name, e.parent_id
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> ${MEMBER_ENTITY_TYPE_SLUG})
          )
          AND e.deleted_at IS NULL
          AND et.slug = ${segment.entity_type}
          AND e.slug = ${segment.slug}
          AND (
            (${parentId}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${parentId}
          )
        ORDER BY (e.organization_id = ${workspace.id}) DESC, e.id ASC
        LIMIT 1
      `;

      if (row.length === 0) {
        throw new ToolUserError(
          `Entity not found for ${segment.entity_type}/${segment.slug}`,
          404
        );
      }

      const entityRow = row[0] as unknown as ResolvedEntityRow;
      resolvedPath.push({
        id: entityRow.id,
        entity_type: entityRow.entity_type,
        slug: entityRow.slug,
        name: entityRow.name,
      });
      parentId = entityRow.id;
      continue;
    }

    // Leaf entity: fetch core data (without expensive COUNT subqueries).
    // Cross-org tolerance: same widening as the intermediate query, excluding $member.
    const row = await sql`
        SELECT
          e.id,
          et.slug AS entity_type,
          e.slug,
          e.name,
          e.parent_id,
          e.metadata,
          e.field_controls,
          e.created_at,
          COALESCE(vtv_entity.json_template, vtv_et.json_template) as json_template,
          COALESCE(vtv_entity.version, vtv_et.version) as json_template_version,
          et.metadata_schema as entity_type_metadata_schema
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN view_template_versions vtv_entity
          ON vtv_entity.id = e.current_view_template_version_id
        LEFT JOIN view_template_versions vtv_et
          ON vtv_et.id = et.current_view_template_version_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> ${MEMBER_ENTITY_TYPE_SLUG})
          )
          AND e.deleted_at IS NULL
          AND et.slug = ${segment.entity_type}
          AND e.slug = ${segment.slug}
          AND (
            (${parentId}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${parentId}
          )
        ORDER BY (e.organization_id = ${workspace.id}) DESC, e.id ASC
        LIMIT 1
      `;

    if (row.length === 0) {
      // The slug isn't a stored entity. It may be a row of a DERIVED ("view")
      // entity type, whose rows are produced by `backing_sql`, not stored in
      // `entities`. Synthesize the same response shape so the routed detail page
      // renders it like any other entity (read-only, id-keyed tabs hidden).
      const derived = await resolveDerivedLeaf(sql, ctx, workspace, segment);
      if (derived) {
        resolvedPath.push({
          id: derived.id,
          entity_type: derived.entity_type,
          slug: derived.slug,
          name: derived.name,
        });
        resolvedEntity = derived;
        continue;
      }
      throw new ToolUserError(
        `Entity not found for ${segment.entity_type}/${segment.slug}`,
        404
      );
    }

    const entityRow = row[0] as unknown as ResolvedEntityRow & {
      json_template: Record<string, any> | null;
      json_template_version: number | null;
      entity_type_metadata_schema: Record<string, any> | null;
    };
    resolvedPath.push({
      id: entityRow.id,
      entity_type: entityRow.entity_type,
      slug: entityRow.slug,
      name: entityRow.name,
    });

    parentId = entityRow.id;

    const createdAt = new Date(entityRow.created_at).toISOString();
    const entityDataCtx: DataSourceContext = {
      organizationId: workspace.id,
      entityIds: [entityRow.id],
      query: urlQuery,
    };

    // Run stats, tabs, and template data sources all in parallel
    const [
      [eventsCount],
      [connectionsCount],
      [watchersCount],
      entityTabs,
      entityTypeTabs,
      { cleanTemplate: entityCleanTpl, templateData: entityTemplateData },
    ] = await Sentry.startSpan({ name: 'entity:counts+tabs', op: 'db' }, () =>
      Promise.all([
        sql.unsafe<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM current_event_records ev
             WHERE ${entityLinkMatchSql(`${Number(entityRow.id)}::bigint`, 'ev')}
               AND ev.organization_id = $1`,
          [workspace.id]
        ),
        sql.unsafe<{ cnt: number }>(
          `SELECT COUNT(DISTINCT cn.connector_key) as cnt
           FROM feeds f
           JOIN connections cn ON cn.id = f.connection_id
           WHERE f.organization_id = $1
             AND f.deleted_at IS NULL
             AND cn.deleted_at IS NULL
             AND ${feedLinkedToBusinessEntitySql('$2::int', 'f', 'cn', '$1')}`,
          [workspace.id, Number(entityRow.id)],
        ),
        sql`SELECT COUNT(*) as cnt FROM watchers i
              WHERE ${Number(entityRow.id)}::int = ANY(i.entity_ids)
                AND i.organization_id = ${workspace.id}
                AND i.status = 'active'`,
        fetchTabs(sql, 'entity', String(entityRow.id), workspace.id),
        fetchTabs(sql, 'entity_type', entityRow.entity_type, workspace.id),
        processTemplateDataSources(entityRow.json_template, entityDataCtx, sql),
      ])
    );
    const mergedTabs = mergeTabs(entityTabs, entityTypeTabs);
    let processedEntityTabs = await processTabsDataSources(mergedTabs, entityDataCtx, sql);
    let redactedTemplateData = entityTemplateData;
    if (entityRow.entity_type === MEMBER_ENTITY_TYPE_SLUG && !ctx.memberRole) {
      throw new ToolUserError(
        'Member details are only visible to members of this workspace. Join the workspace to see members.',
        403
      );
    }
    const rawEntityMetadata = entityRow.metadata ?? {};
    let safeEntityMetadata = rawEntityMetadata;
    const canSeeEmail = isAdminOrOwnerRole(ctx.memberRole);
    if (!canSeeEmail) {
      const schemaRow = await sql`
        SELECT metadata_schema FROM entity_types
        WHERE slug = ${MEMBER_ENTITY_TYPE_SLUG} AND organization_id = ${workspace.id} AND deleted_at IS NULL
        LIMIT 1
      `;
      const memberSchema = (schemaRow[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
      const { emailField } = resolveMemberSchemaFieldsFromSchema(memberSchema);
      if (entityRow.entity_type === MEMBER_ENTITY_TYPE_SLUG && emailField in safeEntityMetadata) {
        const { [emailField]: _drop, ...rest } = safeEntityMetadata;
        safeEntityMetadata = rest;
      }
      // Also strip member emails that surface via template data sources or tabs
      // (e.g. a dashboard tab that lists members). Without this, a data-source
      // query like `SELECT * FROM entities WHERE entity_type='$member'` would
      // leak emails even when the single-entity redaction above is not tripped.
      redactedTemplateData = stripMemberEmailsFromRows(entityTemplateData, emailField);
      processedEntityTabs = processedEntityTabs.map((tab) => ({
        ...tab,
        template_data: stripMemberEmailsFromRows(tab.template_data, emailField),
      }));
    }
    // Rendering resolution tail: when neither the entity nor its type declares
    // a view template, synthesize a default field card from the type's
    // metadata_schema so a typed/promoted entity never renders bare. A type
    // with no schema properties yields null → the client keeps the dashboard
    // overview. Custom tabs (a richer authored view) suppress the auto-default.
    const resolvedTemplate =
      entityCleanTpl ??
      (processedEntityTabs.length === 0
        ? buildDefaultEntityTemplate(entityRow.entity_type_metadata_schema)
        : null);
    resolvedEntity = {
      id: entityRow.id,
      entity_type: entityRow.entity_type,
      slug: entityRow.slug,
      name: entityRow.name,
      parent_id: entityRow.parent_id,
      metadata: safeEntityMetadata,
      field_controls: (entityRow.field_controls as ResolvedEntityDetails['field_controls']) ?? {},
      json_template: resolvedTemplate,
      json_template_version: toVersionNumber(entityRow.json_template_version),
      template_data: redactedTemplateData,
      tabs: processedEntityTabs,
      created_at: createdAt,
      total_content: Number(eventsCount?.cnt) || 0,
      active_connections: Number(connectionsCount?.cnt) || 0,
      watchers_count: Number(watchersCount?.cnt) || 0,
    };
  }

  let children: ChildEntity[] = [];
  let siblings: SiblingEntity[] = [];

  if (resolvedEntity && !resolvedEntity.is_derived) {
    // Fetch children + siblings without per-row COUNT subqueries.
    // content_count is omitted to avoid expensive GIN index scans over the events table.
    const [childRows, siblingRows] = await Promise.all([
      sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name,
          e.metadata::jsonb->>'market' as market
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${workspace.id}
          AND e.parent_id = ${resolvedEntity.id}
        ORDER BY e.name ASC
      `,
      sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${workspace.id}
          AND et.slug = ${resolvedEntity.entity_type}
          AND (
            (${resolvedEntity.parent_id}::bigint IS NULL AND e.parent_id IS NULL)
            OR e.parent_id = ${resolvedEntity.parent_id}
          )
        ORDER BY e.name ASC
      `,
    ]);

    children = childRows.map((row) => ({
      id: Number(row.id),
      entity_type: String(row.entity_type),
      slug: String(row.slug),
      name: String(row.name),
      market: row.market ? String(row.market) : null,
      content_count: 0,
    }));
    siblings = siblingRows.map((row) => ({
      id: Number(row.id),
      entity_type: String(row.entity_type),
      slug: String(row.slug),
      name: String(row.name),
      content_count: 0,
    }));
  }

  const bootstrap = args.include_bootstrap
    ? await fetchBootstrap(sql, ctx, workspace, resolvedEntity)
    : null;

  return {
    workspace,
    segments: parsedSegments,
    path: resolvedPath,
    entity: resolvedEntity,
    children,
    siblings,
    bootstrap,
  };
}

// ============================================
// Helpers
// ============================================

type DbClient = ReturnType<typeof getDb>;

function toVersionNumber(v: unknown): number | null {
  return v ? Number(v) : null;
}

/**
 * Resolve a single row of a derived ("view") entity type by slug. Returns null
 * when the type isn't derived or the slug isn't among its rows — the caller then
 * falls back to the normal 404.
 *
 * Derived rows aren't stored in `entities`; the type's `backing_sql` produces
 * them with stable `id`/`slug` columns. We run that SQL through the same
 * executor the list view uses (`querySqlImpl` — internal org-scoping or
 * connection pushdown, both already validated for this view), then match the
 * requested slug in memory. We page through the view (not just the first page)
 * so a row past the first page still resolves; matching in memory — rather than
 * interpolating the slug into the view SQL — keeps the SQL injection-free for
 * both the internal and connection-backed paths.
 */
async function resolveDerivedLeaf(
  sql: DbClient,
  ctx: ToolContext,
  workspace: ResolvedWorkspace,
  segment: { entity_type: string; slug: string }
): Promise<ResolvedEntityDetails | null> {
  const etRows = await sql`
    SELECT backing_sql, backing_source
    FROM entity_types
    WHERE slug = ${segment.entity_type}
      AND organization_id = ${workspace.id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  const backingSql = etRows[0]?.backing_sql as string | null | undefined;
  if (!backingSql) return null;

  const backingSource = (etRows[0]?.backing_source as string | null | undefined) ?? undefined;
  // measure_columns isn't stored — it's inferred from the backing SQL (same as
  // `get_type`), so the detail view can right-align/badge aggregate columns.
  const measures = inferMeasureColumns(backingSql);

  // Page through the view until the slug is found or the rows run out. A bounded
  // page count caps the work on a pathologically large view (which would also be
  // slow to list); in practice derived types have tens of rows, so page 1 hits.
  const PAGE = 500;
  const MAX_PAGES = 40;
  let match: Record<string, unknown> | undefined;
  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum += 1) {
    const result = await querySqlImpl(
      { sql: backingSql, connection: backingSource, limit: PAGE, offset: pageNum * PAGE },
      undefined,
      ctx
    );
    if (result.error) return null;
    match = result.rows.find((r) => derivedRowSlug(r) === segment.slug);
    if (match) break;
    if (!result.has_more || result.rows.length < PAGE) break;
  }
  if (!match) return null;

  const name = derivedRowName(match, segment.slug);

  return {
    // Derived rows have no stored numeric id; routing/identity use the slug, and
    // the id-keyed tabs (knowledge/connectors/watchers) are hidden client-side.
    id: 0,
    entity_type: segment.entity_type,
    slug: segment.slug,
    name,
    parent_id: null,
    metadata: match,
    // Derived ("view") rows aren't stored entities — no per-field ownership.
    field_controls: {},
    json_template: null,
    json_template_version: null,
    template_data: null,
    tabs: [],
    created_at: new Date().toISOString(),
    total_content: 0,
    active_connections: 0,
    watchers_count: 0,
    is_derived: true,
    measure_columns: measures,
  };
}

function emptyResult(
  workspace: ResolvedWorkspace,
  bootstrap: ResolvePathBootstrap | null
): ResolvePathResult {
  return {
    workspace,
    segments: [],
    path: [],
    entity: null,
    children: [],
    siblings: [],
    bootstrap,
  };
}

async function fetchBootstrap(
  sql: DbClient,
  ctx: ToolContext,
  workspace: ResolvedWorkspace,
  entity: ResolvedEntityDetails | null
): Promise<ResolvePathBootstrap> {
  if (workspace.type !== 'organization') {
    return {
      entity_types: [],
      summary: {
        total_content: 0,
        active_connections: 0,
        watchers_count: 0,
        agents_count: 0,
        devices_count: 0,
      },
      recent_content: [],
      recent_feeds: [],
      recent_watchers: [],
      connector_definitions: [],
    };
  }

  const [entityTypes, summary, recentContent, recentFeeds, recentWatchers] = await Promise.all([
    listEntityTypes(sql, workspace.id),
    fetchScopeSummary(sql, workspace.id, entity, ctx.userId),
    fetchRecentContent(sql, workspace.id, entity?.id ?? null),
    fetchRecentFeeds(sql, workspace.id, entity?.id ?? null),
    fetchRecentWatchers(sql, workspace.slug, workspace.id, entity?.id ?? null),
  ]);
  const connectorDefinitions = await listWorkspaceConnectorDefinitions(
    sql,
    workspace.id,
  );

  return {
    entity_types: entityTypes,
    summary,
    recent_content: recentContent,
    recent_feeds: recentFeeds,
    recent_watchers: recentWatchers,
    connector_definitions: connectorDefinitions,
  };
}

async function listEntityTypes(
  sql: DbClient,
  organizationId: string
): Promise<BootstrapEntityTypeSummary[]> {
  const rows = await sql`
    SELECT
      et.id,
      et.slug,
      et.name,
      et.description,
      et.icon,
      et.color,
      COUNT(e.id)::int AS entity_count
    FROM entity_types et
    LEFT JOIN entities e
      ON e.entity_type_id = et.id
    WHERE et.deleted_at IS NULL
      AND et.organization_id = ${organizationId}
    GROUP BY et.id, et.slug, et.name, et.description, et.icon, et.color
    ORDER BY et.name ASC
  `;

  return rows.map((row) => ({
    id: Number(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    icon: row.icon ? String(row.icon) : null,
    color: row.color ? String(row.color) : null,
    entity_count: Number(row.entity_count) || 0,
  }));
}

async function fetchScopeSummary(
  sql: DbClient,
  organizationId: string,
  entity: ResolvedEntityDetails | null,
  userId: string | null
): Promise<BootstrapScopeSummary> {
  // Agents are org-scoped; devices are owned by the requesting user. Both are
  // sidebar-nav badges that don't narrow with the focused entity, so fetch
  // them regardless of `entity`.
  const [navRow] = await sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM agents a
        WHERE a.organization_id = ${organizationId}
      ) AS agents_count,
      (
        SELECT COUNT(*)::int
        FROM device_workers dw
        WHERE dw.user_id = ${userId}
      ) AS devices_count
  `;
  const agentsCount = Number((navRow as { agents_count?: number } | undefined)?.agents_count) || 0;
  const devicesCount =
    Number((navRow as { devices_count?: number } | undefined)?.devices_count) || 0;

  if (entity) {
    return {
      total_content: entity.total_content,
      active_connections: entity.active_connections,
      watchers_count: entity.watchers_count,
      agents_count: agentsCount,
      devices_count: devicesCount,
    };
  }

  const [row] = await sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM current_event_records ev
        WHERE ev.organization_id = ${organizationId}
          -- Exclude null-shaped internal events (P1 corrections) from the org content count.
          AND ev.semantic_type <> 'correction'
      ) AS total_content,
      (
        SELECT COUNT(*)::int
        FROM connector_definitions cd
        WHERE cd.organization_id = ${organizationId}
          AND cd.status = 'active'
      ) AS active_connections,
      (
        SELECT COUNT(*)::int
        FROM watchers w
        WHERE w.organization_id = ${organizationId}
          AND w.status = 'active'
      ) AS watchers_count
  `;

  return {
    total_content: Number((row as { total_content?: number } | undefined)?.total_content) || 0,
    active_connections:
      Number((row as { active_connections?: number } | undefined)?.active_connections) || 0,
    watchers_count: Number((row as { watchers_count?: number } | undefined)?.watchers_count) || 0,
    agents_count: agentsCount,
    devices_count: devicesCount,
  };
}

async function fetchRecentContent(
  sql: DbClient,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapContentItem[]> {
  // Inline the entity-link match as raw SQL — this whole query is built as a
  // single sql.unsafe() statement rather than mixing sql.unsafe() fragments
  // inside a tagged template that also carries $N values.
  const entityFilter =
    entityId !== null
      ? `AND ${entityLinkMatchSql(`${Number(entityId)}::bigint`, 'ev')}`
      : '';
  const rows = await sql.unsafe<Record<string, unknown>>(
    `
    SELECT
      ev.id,
      ev.entity_ids,
      COALESCE(ev.connector_key, cn.connector_key) AS platform,
      (
        SELECT ent.name
        FROM entities ent
        WHERE ent.id = ANY(ev.entity_ids)
        ORDER BY ent.name ASC
        LIMIT 1
      ) AS entity_name,
      ev.title,
      ev.payload_type,
      ev.payload_text,
      ev.payload_data,
      ev.payload_template,
      ev.source_url,
      ev.author_name,
      ev.created_at,
      ev.occurred_at
    FROM current_event_records ev
    LEFT JOIN connections cn ON cn.id = ev.connection_id
    WHERE ev.organization_id = $1
      -- Exclude null-shaped internal events (P1 corrections) from the recent-content list.
      AND ev.semantic_type <> 'correction'
      ${entityFilter}
    ORDER BY COALESCE(ev.occurred_at, ev.created_at) DESC
    LIMIT $2
  `,
    [organizationId, BOOTSTRAP_RECENT_LIMIT]
  );

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    entity_ids: Array.isArray(row.entity_ids)
      ? (row.entity_ids as number[]).map((value) => Number(value))
      : [],
    platform: row.platform ? String(row.platform) : 'unknown',
    entity_name: row.entity_name ? String(row.entity_name) : null,
    title: row.title ? String(row.title) : null,
    payload_type: (row.payload_type as string) || 'text',
    text_content: String(row.payload_text ?? ''),
    payload_data: row.payload_data as Record<string, unknown> | undefined,
    payload_template: row.payload_template as Record<string, unknown> | null | undefined,
    source_url: row.source_url ? String(row.source_url) : null,
    author_name: row.author_name ? String(row.author_name) : null,
    created_at: toIso(row.created_at),
    occurred_at: row.occurred_at ? toIso(row.occurred_at) : null,
  }));
}

async function fetchRecentFeeds(
  sql: DbClient,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapFeedItem[]> {
  const rows = await sql`
    WITH scoped_feeds AS (
      SELECT
        f.id,
        f.connection_id,
        f.display_name,
        f.feed_key,
        f.status,
        f.entity_ids,
        f.created_at,
        f.updated_at,
        c.connector_key,
        c.display_name AS connection_name,
        cd.name AS connector_name
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      LEFT JOIN LATERAL (
        SELECT name
        FROM connector_definitions
        WHERE key = c.connector_key
          AND status = 'active'
          AND organization_id = ${organizationId}
        ORDER BY updated_at DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE f.organization_id = ${organizationId}
        AND f.deleted_at IS NULL
        AND c.deleted_at IS NULL
        AND (${entityId}::int IS NULL OR ${entityId}::int = ANY(f.entity_ids))
      ORDER BY COALESCE(f.updated_at, f.created_at) DESC
      LIMIT ${BOOTSTRAP_RECENT_LIMIT}
    ),
    event_counts AS (
      SELECT ev.feed_id, COUNT(*)::int AS event_count
      FROM current_event_records ev
      WHERE ev.feed_id IN (SELECT id FROM scoped_feeds)
      GROUP BY ev.feed_id
    )
    SELECT
      sf.id,
      sf.connection_id,
      sf.connector_key,
      sf.display_name,
      sf.status,
      sf.entity_ids,
      sf.connector_name,
      sf.connection_name,
      COALESCE(ec.event_count, 0)::int AS event_count,
      sf.created_at,
      sf.updated_at
    FROM scoped_feeds sf
    LEFT JOIN event_counts ec ON ec.feed_id = sf.id
    ORDER BY COALESCE(sf.updated_at, sf.created_at) DESC
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    connection_id: Number(row.connection_id),
    connector_key: String(row.connector_key),
    display_name: row.display_name ? String(row.display_name) : null,
    status: String(row.status),
    entity_ids: Array.isArray(row.entity_ids)
      ? (row.entity_ids as number[]).map((value) => Number(value))
      : [],
    connector_name: row.connector_name ? String(row.connector_name) : null,
    connection_name: row.connection_name ? String(row.connection_name) : null,
    event_count: Number(row.event_count) || 0,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at, row.created_at),
  }));
}

async function fetchRecentWatchers(
  sql: DbClient,
  organizationSlug: string,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapWatcherItem[]> {
  const rows = await sql`
    WITH scoped_watchers AS (
      SELECT
        w.id,
        w.name,
        w.status,
        w.schedule,
        w.entity_ids,
        w.created_at,
        w.updated_at
      FROM watchers w
      WHERE w.organization_id = ${organizationId}
        AND w.status = 'active'
        AND (${entityId}::int IS NULL OR ${entityId}::int = ANY(w.entity_ids))
      ORDER BY COALESCE(w.updated_at, w.created_at) DESC
      LIMIT ${BOOTSTRAP_RECENT_LIMIT}
    ),
    watcher_window_counts AS (
      SELECT ww.watcher_id, COUNT(*)::int AS windows_count
      FROM canvas_windows ww
      WHERE ww.watcher_id IN (SELECT id FROM scoped_watchers)
      GROUP BY ww.watcher_id
    )
    SELECT
      sw.id AS watcher_id,
      sw.name,
      sw.status,
      sw.schedule,
      sw.created_at,
      sw.updated_at,
      e.id AS entity_id,
      e.entity_type,
      e.name AS entity_name,
      e.slug AS entity_slug,
      parent.slug AS parent_slug,
      pet.slug AS parent_entity_type,
      COALESCE(wwc.windows_count, 0)::int AS windows_count
    FROM scoped_watchers sw
    LEFT JOIN LATERAL (
      SELECT entity.id, et_ent.slug AS entity_type, entity.name, entity.slug, entity.parent_id
      FROM entities entity
      JOIN entity_types et_ent ON et_ent.id = entity.entity_type_id
      WHERE entity.id = ANY(sw.entity_ids)
      ORDER BY entity.name ASC
      LIMIT 1
    ) e ON TRUE
    LEFT JOIN entities parent ON parent.id = e.parent_id
    LEFT JOIN entity_types pet ON pet.id = parent.entity_type_id
    LEFT JOIN watcher_window_counts wwc ON wwc.watcher_id = sw.id
    ORDER BY COALESCE(sw.updated_at, sw.created_at) DESC
  `;

  return (rows as Array<Record<string, unknown>>).map((row) => ({
    watcher_id: String(row.watcher_id),
    name: String(row.name),
    status: String(row.status),
    schedule: String(row.schedule),
    entity_id: row.entity_id ? Number(row.entity_id) : null,
    entity_type: row.entity_type ? String(row.entity_type) : null,
    entity_name: row.entity_name ? String(row.entity_name) : null,
    entity_slug: row.entity_slug ? String(row.entity_slug) : null,
    parent_slug: row.parent_slug ? String(row.parent_slug) : null,
    parent_entity_type: row.parent_entity_type ? String(row.parent_entity_type) : null,
    organization_slug: organizationSlug,
    windows_count: Number(row.windows_count) || 0,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at, row.created_at),
  }));
}

function extractOAuthDomain(authSchema: Record<string, unknown> | null | undefined): string | null {
  if (!authSchema) return null;

  const methods = (authSchema as { methods?: Array<Record<string, unknown>> }).methods;
  if (!Array.isArray(methods)) return null;

  for (const method of methods) {
    if (method.type !== 'oauth') continue;

    const authUrl = method.authorization_url ?? method.authorizationUrl;
    if (typeof authUrl === 'string') {
      try {
        return new URL(authUrl).hostname;
      } catch {
        // Ignore invalid URLs and keep checking fallback options.
      }
    }

    if (typeof method.provider === 'string' && method.provider.length > 0) {
      return `${method.provider}.com`;
    }
  }

  return null;
}

async function listWorkspaceConnectorDefinitions(
  sql: DbClient,
  organizationId: string
): Promise<BootstrapConnectorDefinition[]> {
  const rows = await sql`
    SELECT
      d.key,
      d.name,
      d.description,
      d.auth_schema,
      NULL::text AS icon,
      NULL::text AS favicon_domain
    FROM connector_definitions d
    WHERE d.status = 'active'
      AND d.organization_id = ${organizationId}
    ORDER BY d.name ASC
  `;

  return rows.map((row) => ({
    key: String(row.key),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    icon: row.icon ? String(row.icon) : null,
    favicon_domain: row.favicon_domain
      ? String(row.favicon_domain)
      : extractOAuthDomain((row.auth_schema as Record<string, unknown> | null) ?? null),
  }));
}

async function fetchTabs(
  sql: DbClient,
  resourceType: string,
  resourceId: string,
  organizationId: string
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
    WHERE vtat.resource_type = ${resourceType}
      AND vtat.resource_id = ${resourceId}
      AND vtat.organization_id = ${organizationId}
    ORDER BY vtat.tab_order ASC, vtat.tab_name ASC
  `;

  return rows.map((row) => ({
    tab_name: String(row.tab_name),
    tab_order: Number(row.tab_order),
    json_template: row.json_template as Record<string, any>,
    version: Number(row.version),
    version_id: Number(row.version_id),
    template_data: null,
  }));
}

/**
 * Merge entity-level tabs with entity-type-level tabs.
 * Entity tabs override same-named entity-type tabs.
 */
function mergeTabs(
  entityTabs: ViewTemplateTab[],
  entityTypeTabs: ViewTemplateTab[]
): ViewTemplateTab[] {
  const tabMap = new Map<string, ViewTemplateTab>();

  // Add entity-type tabs first
  for (const tab of entityTypeTabs) {
    tabMap.set(tab.tab_name, tab);
  }

  // Entity tabs override same-named tabs
  for (const tab of entityTabs) {
    tabMap.set(tab.tab_name, tab);
  }

  return Array.from(tabMap.values()).sort(
    (a, b) => a.tab_order - b.tab_order || a.tab_name.localeCompare(b.tab_name)
  );
}
