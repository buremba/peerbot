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
import { createDbClientFromEnv, getDb, simpleQuery } from '../db/client';
import type { Env } from '../index';
import { entityLinkMatchSql } from '../utils/content-search';
import {
  type DataSourceContext,
  type DataSourceInput,
  executeDataSources,
} from '../utils/execute-data-sources';
import { ToolUserError } from '../utils/errors';
import { resolveMemberSchemaFieldsFromSchema } from '../utils/member-entity-type';
import { stripMemberEmailsFromRows } from '../utils/member-redaction';
import { RESERVED_PATHS } from '../utils/reserved';
import { getWorkspaceProvider } from '../workspace';
import type { ToolContext } from './registry';

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

export interface ResolvedWorkspace {
  slug: string;
  type: 'user' | 'organization';
  id: string;
  name: string | null;
}

export interface ResolvedPathEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
}

interface ViewTemplateTab {
  tab_name: string;
  tab_order: number;
  json_template: Record<string, any>;
  version: number;
  version_id: number;
  template_data: Record<string, unknown[]> | null;
}

export interface ResolvedEntityDetails extends ResolvedPathEntity {
  parent_id: number | null;
  metadata: Record<string, any>;
  json_template: Record<string, any> | null;
  json_template_version: number | null;
  template_data: Record<string, unknown[]> | null;
  tabs: ViewTemplateTab[];
  created_at: string;
  // Stats
  total_content: number;
  active_connections: number;
  watchers_count: number;
}

export interface ChildEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  market: string | null;
  content_count: number;
}

interface ResolvedEntityRow {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  parent_id: number | null;
  metadata: Record<string, any> | null;
  created_at: Date;
}

export interface SiblingEntity {
  id: number;
  entity_type: string;
  slug: string;
  name: string;
  content_count: number;
}

export interface ResolvePathResult {
  workspace: ResolvedWorkspace;
  segments: Array<{ entity_type: string; slug: string }>;
  path: ResolvedPathEntity[];
  entity: ResolvedEntityDetails | null;
  children: ChildEntity[];
  siblings: SiblingEntity[];
  bootstrap: ResolvePathBootstrap | null;
}

interface BootstrapEntityTypeSummary {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  entity_count: number;
}

interface BootstrapScopeSummary {
  total_content: number;
  active_connections: number;
  watchers_count: number;
}

interface BootstrapContentItem {
  id: number;
  entity_ids: number[];
  platform: string;
  entity_name: string | null;
  title: string | null;
  text_content: string;
  source_url: string | null;
  author_name: string | null;
  created_at: string;
  occurred_at: string | null;
}

interface BootstrapFeedItem {
  id: number;
  connection_id: number;
  connector_key: string;
  display_name: string | null;
  status: string;
  entity_ids: number[];
  connector_name: string | null;
  connection_name: string | null;
  event_count: number;
  created_at: string;
  updated_at: string;
}

interface BootstrapWatcherItem {
  watcher_id: string;
  name: string;
  status: string;
  schedule: string;
  entity_id: number | null;
  entity_type: string | null;
  entity_name: string | null;
  entity_slug: string | null;
  parent_slug: string | null;
  parent_entity_type: string | null;
  organization_slug: string;
  windows_count: number;
  created_at: string;
  updated_at: string;
}

interface BootstrapConnectorDefinition {
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  favicon_domain: string | null;
}

export interface ResolvePathBootstrap {
  entity_types: BootstrapEntityTypeSummary[];
  summary: BootstrapScopeSummary;
  recent_content: BootstrapContentItem[];
  recent_feeds: BootstrapFeedItem[];
  recent_watchers: BootstrapWatcherItem[];
  connector_definitions: BootstrapConnectorDefinition[];
}

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

export function resolvePath(
  args: ResolvePathArgs,
  env: Env,
  ctx: ToolContext
): Promise<ResolvePathResult> {
  return Sentry.startSpan(
    { name: 'resolve_path', op: 'function', attributes: { path: args.path } },
    () => _resolvePath(args, env, ctx)
  );
}

async function _resolvePath(
  args: ResolvePathArgs,
  env: Env,
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

  const pgSql = createDbClientFromEnv(env);
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
      ? await fetchBootstrap(sql, pgSql, ctx, workspace, null)
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
      const row = await simpleQuery(sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name, e.parent_id
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> '$member')
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
      `);

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
    const row = await simpleQuery(sql`
        SELECT
          e.id,
          et.slug AS entity_type,
          e.slug,
          e.name,
          e.parent_id,
          e.metadata,
          e.created_at,
          COALESCE(vtv_entity.json_template, vtv_et.json_template) as json_template,
          COALESCE(vtv_entity.version, vtv_et.version) as json_template_version
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        LEFT JOIN view_template_versions vtv_entity
          ON vtv_entity.id = e.current_view_template_version_id
        LEFT JOIN view_template_versions vtv_et
          ON vtv_et.id = et.current_view_template_version_id
        LEFT JOIN organization eo ON eo.id = e.organization_id
        WHERE (
            e.organization_id = ${workspace.id}
            OR (eo.visibility = 'public' AND et.slug <> '$member')
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
      `);

    if (row.length === 0) {
      throw new ToolUserError(
        `Entity not found for ${segment.entity_type}/${segment.slug}`,
        404
      );
    }

    const entityRow = row[0] as unknown as ResolvedEntityRow & {
      json_template: Record<string, any> | null;
      json_template_version: number | null;
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
        simpleQuery(
          sql.unsafe<{ cnt: number }>(
            `SELECT COUNT(*) as cnt FROM current_event_records ev
             WHERE ${entityLinkMatchSql(`${Number(entityRow.id)}::bigint`, 'ev')}
               AND ev.organization_id = $1`,
            [workspace.id]
          )
        ),
        simpleQuery(sql`
          SELECT COUNT(DISTINCT cn.connector_key) as cnt
          FROM feeds f
          JOIN connections cn ON cn.id = f.connection_id
          WHERE ${Number(entityRow.id)}::int = ANY(f.entity_ids)
            AND f.organization_id = ${workspace.id}
            AND f.deleted_at IS NULL
            AND cn.deleted_at IS NULL
        `),
        simpleQuery(
          sql`SELECT COUNT(*) as cnt FROM watchers i
              WHERE ${Number(entityRow.id)}::int = ANY(i.entity_ids)
                AND i.organization_id = ${workspace.id}
                AND i.status = 'active'`
        ),
        fetchTabs(sql, 'entity', String(entityRow.id), workspace.id),
        fetchTabs(sql, 'entity_type', entityRow.entity_type, workspace.id),
        processTemplateDataSources(entityRow.json_template, entityDataCtx, sql),
      ])
    );
    const mergedTabs = mergeTabs(entityTabs, entityTypeTabs);
    let processedEntityTabs = await processTabsDataSources(mergedTabs, entityDataCtx, sql);
    let redactedTemplateData = entityTemplateData;
    if (entityRow.entity_type === '$member' && !ctx.memberRole) {
      throw new ToolUserError(
        'Member details are only visible to members of this workspace. Join the workspace to see members.',
        403
      );
    }
    const rawEntityMetadata = entityRow.metadata ?? {};
    let safeEntityMetadata = rawEntityMetadata;
    const canSeeEmail = ctx.memberRole === 'owner' || ctx.memberRole === 'admin';
    if (!canSeeEmail) {
      const schemaRow = await simpleQuery(sql`
        SELECT metadata_schema FROM entity_types
        WHERE slug = '$member' AND organization_id = ${workspace.id} AND deleted_at IS NULL
        LIMIT 1
      `);
      const memberSchema = (schemaRow[0]?.metadata_schema as Record<string, unknown> | null) ?? null;
      const { emailField } = resolveMemberSchemaFieldsFromSchema(memberSchema);
      if (entityRow.entity_type === '$member' && emailField in safeEntityMetadata) {
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
    resolvedEntity = {
      id: entityRow.id,
      entity_type: entityRow.entity_type,
      slug: entityRow.slug,
      name: entityRow.name,
      parent_id: entityRow.parent_id,
      metadata: safeEntityMetadata,
      json_template: entityCleanTpl,
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

  if (resolvedEntity) {
    // Fetch children + siblings without per-row COUNT subqueries.
    // content_count is omitted to avoid expensive GIN index scans over the events table.
    const [childRows, siblingRows] = await Promise.all([
      simpleQuery(sql`
        SELECT e.id, et.slug AS entity_type, e.slug, e.name,
          e.metadata::jsonb->>'market' as market
        FROM entities e
        JOIN entity_types et ON et.id = e.entity_type_id
        WHERE e.organization_id = ${workspace.id}
          AND e.parent_id = ${resolvedEntity.id}
        ORDER BY e.name ASC
      `),
      simpleQuery(sql`
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
      `),
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
    ? await fetchBootstrap(sql, pgSql, ctx, workspace, resolvedEntity)
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
  _pgSql: ReturnType<typeof createDbClientFromEnv>,
  _ctx: ToolContext,
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
      },
      recent_content: [],
      recent_feeds: [],
      recent_watchers: [],
      connector_definitions: [],
    };
  }

  const [entityTypes, summary, recentContent, recentFeeds, recentWatchers] = await Promise.all([
    listEntityTypes(sql, workspace.id),
    fetchScopeSummary(sql, workspace.id, entity),
    fetchRecentContent(sql, workspace.id, entity?.id ?? null),
    fetchRecentFeeds(sql, workspace.id, entity?.id ?? null),
    fetchRecentWatchers(sql, workspace.slug, workspace.id, entity?.id ?? null),
  ]);
  const connectorDefinitions = await listConnectorDefinitions(sql, workspace.id);

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
  const rows = await simpleQuery(sql`
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
  `);

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
  entity: ResolvedEntityDetails | null
): Promise<BootstrapScopeSummary> {
  if (entity) {
    return {
      total_content: entity.total_content,
      active_connections: entity.active_connections,
      watchers_count: entity.watchers_count,
    };
  }

  const [row] = await simpleQuery(sql`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM current_event_records ev
        WHERE ev.organization_id = ${organizationId}
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
  `);

  return {
    total_content: Number((row as { total_content?: number } | undefined)?.total_content) || 0,
    active_connections:
      Number((row as { active_connections?: number } | undefined)?.active_connections) || 0,
    watchers_count: Number((row as { watchers_count?: number } | undefined)?.watchers_count) || 0,
  };
}

async function fetchRecentContent(
  sql: DbClient,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapContentItem[]> {
  // Inline the entity-link match as raw SQL — postgres.js can't combine
  // sql.unsafe() inside a tagged template that also has $N values when
  // running against PGlite (prepare:false simple-query mode).
  const entityFilter =
    entityId !== null
      ? `AND ${entityLinkMatchSql(`${Number(entityId)}::bigint`, 'ev')}`
      : '';
  const rows = await simpleQuery(
    sql.unsafe<Record<string, unknown>>(
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
      ${entityFilter}
    ORDER BY COALESCE(ev.occurred_at, ev.created_at) DESC
    LIMIT $2
  `,
      [organizationId, BOOTSTRAP_RECENT_LIMIT]
    )
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
    created_at: new Date(String(row.created_at)).toISOString(),
    occurred_at: row.occurred_at ? new Date(String(row.occurred_at)).toISOString() : null,
  }));
}

async function fetchRecentFeeds(
  sql: DbClient,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapFeedItem[]> {
  const rows = await simpleQuery(sql`
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
  `);

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
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
  }));
}

async function fetchRecentWatchers(
  sql: DbClient,
  organizationSlug: string,
  organizationId: string,
  entityId: number | null
): Promise<BootstrapWatcherItem[]> {
  const rows = await simpleQuery(sql`
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
      FROM watcher_windows ww
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
  `);

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
    created_at: new Date(String(row.created_at)).toISOString(),
    updated_at: new Date(String(row.updated_at)).toISOString(),
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

async function listConnectorDefinitions(
  sql: DbClient,
  organizationId: string
): Promise<BootstrapConnectorDefinition[]> {
  const rows = await simpleQuery(sql`
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
  `);

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
  const rows = await simpleQuery(sql`
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
  `);

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
