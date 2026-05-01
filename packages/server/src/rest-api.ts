/**
 * REST API Wrapper for ChatGPT Custom Actions
 *
 * Provides simple REST endpoints that wrap the MCP tools
 * for use with ChatGPT, Zapier, and other REST-based integrations
 */

import * as Sentry from '@sentry/node';
import type { Context } from 'hono';
import { getDb } from './db/client';
import * as invalidationEmitter from './events/emitter';
import type { Env } from './index';
import {
  EMPTY_SUMMARY,
  getOperationsSummary,
  getOperationsSummaryBatch,
} from './operations/catalog';
import {
  getScopedConnectorDefinition,
  listScopedConnectorDefinitions,
} from './tools/admin/connector-definition-helpers';
import { manageClassifiers } from './tools/admin/manage_classifiers';
import { listWatchers } from './tools/admin/manage_watchers';
import { executeTool, extractAuthContext, toToolContext } from './tools/execute';
import { getContent } from './tools/get_content';
import { getWatcher } from './tools/get_watchers';
import { getTool, type ToolContext } from './tools/registry';
import { ToolNotRegisteredError, ToolUserError, errorMessage } from './utils/errors';
import { toJsonSafe } from './utils/json';
import logger from './utils/logger';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from './utils/run-statuses';
import { getRuntimeInfo } from './utils/runtime-info';

function clamp(value: number, options?: { min?: number; max?: number }): number {
  let result = value;
  if (options?.min !== undefined) result = Math.max(options.min, result);
  if (options?.max !== undefined) result = Math.min(options.max, result);
  return result;
}

function safeParseInt(
  value: string | undefined,
  options?: { min?: number; max?: number }
): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : clamp(parsed, options);
}

function safeParseFloat(
  value: string | undefined,
  options?: { min?: number; max?: number }
): number | undefined {
  if (!value) return undefined;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : clamp(parsed, options);
}

async function resolvePublicOrganizationId(orgSlug: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT id
    FROM "organization"
    WHERE slug = ${orgSlug}
      AND visibility = 'public'
    LIMIT 1
  `;
  return (rows[0]?.id as string | undefined) ?? null;
}

function publicToolContext(requestUrl: string, organizationId: string): ToolContext {
  return {
    organizationId,
    userId: null,
    memberRole: null,
    isAuthenticated: false,
    clientId: null,
    tokenType: 'anonymous',
    scopedToOrg: true,
    allowCrossOrg: false,
    requestUrl,
    baseUrl: new URL(requestUrl).origin,
  };
}

async function withPublicOrg<T>(
  c: Context<{ Bindings: Env }>,
  handler: (organizationId: string) => Promise<T>
): Promise<Response> {
  try {
    const orgSlug = c.req.param('orgSlug');
    if (!orgSlug) {
      return c.json({ error: 'Organization slug is required' }, 400);
    }
    const organizationId = await resolvePublicOrganizationId(orgSlug);
    if (!organizationId) {
      return c.json({ error: 'Not found' }, 404);
    }
    const result = await handler(organizationId);
    return c.json(toJsonSafe(result));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
}

/**
 * GET /api/watchers
 * Get or list watchers (wrapper for list_watchers and get_watcher tools)
 */
export async function restGetWatchers(c: Context<{ Bindings: Env }>) {
  try {
    const watcherId = c.req.query('watcher_id');
    const entityId = safeParseInt(c.req.query('entity_id'), { min: 1 });

    if (!watcherId) {
      const result = await listWatchers(
        {
          watcher_id: watcherId,
          entity_id: entityId,
          status: c.req.query('status') || undefined,
          include_details: c.req.query('include_details') === 'true',
        } as any,
        c.env,
        toToolContext(extractAuthContext(c))
      );
      return c.json(toJsonSafe(result));
    }

    const params = {
      watcher_id: watcherId,
      entity_id: entityId,
      content_since: c.req.query('content_since'),
      content_until: c.req.query('content_until'),
      granularity: c.req.query('granularity') as any,
      template_version: safeParseInt(c.req.query('template_version'), { min: 1 }),
      page: safeParseInt(c.req.query('page'), { min: 1 }),
      page_size: safeParseInt(c.req.query('page_size'), { min: 1, max: 500 }),
      include_classification: c.req.query('include_classification') || undefined,
      include_versions: c.req.query('include_versions') === 'true',
      include_pending_ranges: c.req.query('include_pending_ranges') === 'true',
      // Always include template details when fetching a specific watcher (prompt/schema/json_template)
      include_template_details: true,
    };

    const ctx = toToolContext(extractAuthContext(c));
    const result = await getWatcher(params as any, c.env, ctx);
    return c.json(toJsonSafe(result));
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
}

export async function publicRestGetWatchers(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const watcherId = c.req.query('watcher_id');
    const entityId = safeParseInt(c.req.query('entity_id'), { min: 1 });
    const ctx = publicToolContext(c.req.url, organizationId);
    const detailRequested =
      !!watcherId ||
      [
        'content_since',
        'content_until',
        'granularity',
        'template_version',
        'page',
        'page_size',
        'include_classification',
        'include_versions',
        'include_pending_ranges',
      ].some((key) => c.req.query(key) !== undefined);

    if (!detailRequested) {
      return listWatchers(
        {
          entity_id: entityId,
          status: c.req.query('status') || undefined,
          include_details: c.req.query('include_details') === 'true',
        } as any,
        c.env,
        ctx
      );
    }

    return getWatcher(
      {
        watcher_id: watcherId,
        entity_id: entityId,
        content_since: c.req.query('content_since'),
        content_until: c.req.query('content_until'),
        granularity: c.req.query('granularity') as any,
        template_version: safeParseInt(c.req.query('template_version'), { min: 1 }),
        page: safeParseInt(c.req.query('page'), { min: 1 }),
        page_size: safeParseInt(c.req.query('page_size'), { min: 1, max: 500 }),
        include_classification: c.req.query('include_classification') || undefined,
        include_versions: c.req.query('include_versions') === 'true',
        include_pending_ranges: c.req.query('include_pending_ranges') === 'true',
        include_template_details: watcherId ? true : undefined,
      } as any,
      c.env,
      ctx
    );
  });
}

/**
 * GET /api/health
 * Health check endpoint
 */
export async function restHealth(c: Context<{ Bindings: Env }>) {
  return c.json({
    status: 'healthy',
    service: 'user-research-mcp',
    timestamp: new Date().toISOString(),
    ...getRuntimeInfo(c.env),
  });
}

/**
 * POST /api/:orgSlug/:toolName
 * Generic proxy endpoint that forwards to any MCP tool
 *
 * This allows all MCP tools to be called via REST API without
 * needing individual wrapper functions for each tool
 */
export async function restToolProxy(
  c: Context<{ Bindings: Env }>,
  explicitToolName?: string,
  explicitArgs?: Record<string, unknown>
) {
  try {
    const toolName = explicitToolName ?? c.req.param('toolName');
    if (!toolName) {
      return c.json({ error: 'Tool name is required' }, 400);
    }
    const args: Record<string, unknown> = explicitArgs ?? (await c.req.json());
    const authCtx = extractAuthContext(c);
    const result = await executeTool(toolName, args, c.env, authCtx);
    return c.json(toJsonSafe(result));
  } catch (error) {
    if (error instanceof ToolUserError) {
      return c.json({ error: error.message }, error.httpStatus as 400 | 404);
    }
    if (error instanceof ToolNotRegisteredError) {
      // Registry/frontend drift — surface to Sentry so the next "Tool not
      // found" outage doesn't sit silent behind a 400 the page swallows.
      // `tool_name` goes in `extra` (not `tags`) because the URL segment is
      // attacker-controlled and would otherwise blow up tag cardinality.
      Sentry.captureException(error, {
        tags: { source: 'rest_proxy' },
        extra: { tool_name: error.toolName },
      });
    }
    return c.json({ error: errorMessage(error) }, 400);
  }
}

/**
 * GET /api/knowledge/search
 * Wrapper for read_knowledge MCP tool (search mode)
 *
 * Query Parameters:
 * - query (required): Search text (min 3 characters)
 * - entity_id (optional): Filter by entity ID (integer)
 * - connection_id (optional): Filter by connection ID (integer)
 * - platform (optional): Filter by platform (reddit, trustpilot, etc.)
 * - platforms (optional): Comma-separated platform list
 * - since (optional): Filter by date (ISO date or relative like "7d", "30d")
 * - until (optional): Filter by date (ISO date)
 * - min_similarity (optional): Minimum similarity threshold (0.0-1.0, default: 0.6)
 * - include_classifications (optional): Include classification results (default: false)
 * - include_classification (optional): Include classification aggregates (summary)
 * - limit (optional): Max results (default: 50, max: 500)
 * - offset (optional): Pagination offset (default: 0)
 * - before_occurred_at / before_id (optional): Fetch the next older chronological slice
 * - after_occurred_at / after_id (optional): Fetch the next newer chronological slice
 */
export async function restSearchKnowledge(c: Context<{ Bindings: Env }>) {
  try {
    const query = c.req.query('query');
    if (!query || query.trim().length < 3) {
      return c.json({ error: 'Query must be at least 3 characters' }, 400);
    }

    const connectionId = safeParseInt(c.req.query('connection_id'), { min: 1 });
    const platforms = c.req.query('platforms');
    const params = {
      query,
      entity_id: safeParseInt(c.req.query('entity_id'), { min: 1 }),
      connection_ids: connectionId ? [connectionId] : undefined,
      platform: c.req.query('platform'),
      platforms: platforms
        ? platforms
            .split(',')
            .map((platform) => platform.trim())
            .filter(Boolean)
        : undefined,
      since: c.req.query('since'),
      until: c.req.query('until'),
      min_similarity: safeParseFloat(c.req.query('min_similarity'), { min: 0, max: 1 }),
      include_classifications: c.req.query('include_classifications') === 'true',
      include_classification: c.req.query('include_classification') || undefined,
      limit: safeParseInt(c.req.query('limit'), { min: 1, max: 500 }),
      offset: safeParseInt(c.req.query('offset'), { min: 0 }),
      before_occurred_at: c.req.query('before_occurred_at') || undefined,
      before_id: safeParseInt(c.req.query('before_id'), { min: 1 }),
      after_occurred_at: c.req.query('after_occurred_at') || undefined,
      after_id: safeParseInt(c.req.query('after_id'), { min: 1 }),
      interaction_status: c.req.query('interaction_status') || undefined,
    };

    const ctx = toToolContext(extractAuthContext(c));
    const result = await getContent(params as any, c.env, ctx);
    return c.json(toJsonSafe(result));
  } catch (error) {
    logger.error({ error }, '[REST API] Knowledge search error');
    return c.json({ error: errorMessage(error) }, 400);
  }
}

export async function publicRestSearchKnowledge(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const query = c.req.query('query');

    const connectionId = safeParseInt(c.req.query('connection_id'), { min: 1 });
    const platforms = c.req.query('platforms');
    const contentIds = c.req.query('content_ids');
    const params = {
      query: query?.trim() || undefined,
      entity_id: safeParseInt(c.req.query('entity_id'), { min: 1 }),
      connection_ids: connectionId ? [connectionId] : undefined,
      platform: c.req.query('platform'),
      platforms: platforms
        ? platforms
            .split(',')
            .map((platform) => platform.trim())
            .filter(Boolean)
        : undefined,
      since: c.req.query('since'),
      until: c.req.query('until'),
      engagement_min: safeParseInt(c.req.query('engagement_min'), { min: 0, max: 100 }),
      engagement_max: safeParseInt(c.req.query('engagement_max'), { min: 0, max: 100 }),
      classification_filters: (() => {
        const raw = c.req.query('classification_filters');
        if (!raw) return undefined;
        try {
          return JSON.parse(raw);
        } catch {
          return undefined;
        }
      })(),
      classification_source: c.req.query('classification_source') || undefined,
      window_id: safeParseInt(c.req.query('window_id'), { min: 1 }),
      content_ids: contentIds
        ? contentIds
            .split(',')
            .map((id) => safeParseInt(id.trim(), { min: 1 }))
            .filter((id): id is number => id !== undefined)
        : undefined,
      min_similarity: safeParseFloat(c.req.query('min_similarity'), { min: 0, max: 1 }),
      include_classifications: c.req.query('include_classifications') === 'true',
      include_classification: c.req.query('include_classification') || undefined,
      limit: safeParseInt(c.req.query('limit'), { min: 1, max: 500 }),
      offset: safeParseInt(c.req.query('offset'), { min: 0 }),
      sort_by: c.req.query('sort_by') || undefined,
      sort_order: c.req.query('sort_order') || undefined,
      before_occurred_at: c.req.query('before_occurred_at') || undefined,
      before_id: safeParseInt(c.req.query('before_id'), { min: 1 }),
      after_occurred_at: c.req.query('after_occurred_at') || undefined,
      after_id: safeParseInt(c.req.query('after_id'), { min: 1 }),
      interaction_status: c.req.query('interaction_status') || undefined,
    };

    return getContent(params as any, c.env, publicToolContext(c.req.url, organizationId));
  });
}

export async function publicRestListClassifiers(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const entityId = safeParseInt(c.req.query('entity_id'), { min: 1 });
    return manageClassifiers(
      { action: 'list', entity_id: entityId },
      c.env,
      publicToolContext(c.req.url, organizationId)
    );
  });
}

export async function publicRestListConnectors(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const entityId = safeParseInt(c.req.query('entity_id'), { min: 1 });

    let entityConnectorKeys: Set<string> | null = null;
    if (entityId !== undefined) {
      const sql = getDb();
      const keyRows = await sql`
        SELECT DISTINCT c.connector_key
        FROM feeds f
        JOIN connections c ON c.id = f.connection_id
        WHERE f.organization_id = ${organizationId}
          AND ${entityId}::int = ANY(f.entity_ids)
          AND c.deleted_at IS NULL
          AND f.deleted_at IS NULL
          AND c.visibility = 'org'
      `;
      entityConnectorKeys = new Set(
        keyRows.map((r) => String((r as { connector_key: string }).connector_key))
      );
    }

    const allRows = await listScopedConnectorDefinitions({
      organizationId,
    });
    const rows = entityConnectorKeys
      ? allRows.filter((r) => entityConnectorKeys.has(r.key))
      : allRows;

    const connectorKeys = rows.map((r) => r.key);
    const summaries = await getOperationsSummaryBatch(organizationId, connectorKeys);

    return {
      connector_definitions: rows.map(
        ({ source_path: _sourcePath, actions_schema: _actionsSchema, ...rest }) => {
          const operationsSummary = summaries.get(rest.key) ?? { ...EMPTY_SUMMARY };
          return {
            ...rest,
            operations_summary: operationsSummary,
            has_operations: operationsSummary.total > 0,
          };
        }
      ),
    };
  });
}

export async function publicRestGetConnector(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const sql = getDb();
    const connectorKey = c.req.param('connectorKey');
    if (!connectorKey) {
      throw new Error('Connector key is required');
    }

    const connector = await getScopedConnectorDefinition({
      organizationId,
      connectorKey,
    });

    if (!connector) {
      throw new Error('Connector not found');
    }

    const feeds = await sql`
      SELECT
        f.id,
        f.connection_id,
        f.display_name,
        f.feed_key,
        f.status,
        f.config,
        f.entity_ids,
        (
          SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
          FROM entities ent
          WHERE ent.id = ANY(f.entity_ids)
        ) AS entity_names,
        c.connector_key,
        c.display_name AS connection_name,
        c.status AS connection_status,
        (
          SELECT COUNT(*) FROM runs r
          WHERE r.feed_id = f.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
        )::int AS active_runs,
        (
          SELECT COUNT(*) FROM current_event_records e
          WHERE e.connection_id = f.connection_id AND e.feed_key = f.feed_key
        )::int AS event_count,
        f.last_sync_at,
        f.last_sync_status,
        f.next_run_at,
        f.created_at,
        f.updated_at
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE f.organization_id = ${organizationId}
        AND c.connector_key = ${connectorKey}
        AND c.deleted_at IS NULL
        AND f.deleted_at IS NULL
        AND c.visibility = 'org'
      ORDER BY COALESCE(f.updated_at, f.created_at) DESC
    `;

    const operationsSummary = await getOperationsSummary(organizationId, connector.key);

    return {
      connector: {
        ...connector,
        source_path: undefined,
        actions_schema: undefined,
        operations_summary: operationsSummary,
        has_operations: operationsSummary.total > 0,
      },
      feeds,
    };
  });
}

/**
 * GET /api/:orgSlug/public/organization
 * Sanitized org metadata for non-members of a public workspace.
 * No member roster, no internal settings.
 */
export async function publicRestGetOrganization(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const sql = getDb();
    const rows = await sql<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      logo: string | null;
      visibility: string;
      created_at: string;
    }>`
      SELECT id, slug, name, description, logo, visibility, "createdAt" AS created_at
      FROM "organization"
      WHERE id = ${organizationId}
      LIMIT 1
    `;
    const org = rows[0];
    if (!org) throw new Error('Organization not found');

    const [{ count: agent_count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM agents
      WHERE organization_id = ${organizationId}
        AND parent_connection_id IS NULL
    `;
    const [{ count: entity_type_count }] = await sql<{ count: number }>`
      SELECT COUNT(*)::int AS count FROM entity_types
      WHERE organization_id = ${organizationId}
        AND deleted_at IS NULL
    `;
    return {
      organization: {
        ...org,
        agent_count,
        entity_type_count,
      },
    };
  });
}

/**
 * GET /api/:orgSlug/public/agents
 * Sanitized agent list for non-members of a public workspace.
 * Only name/description/id are exposed — no credentials, MCP server URLs,
 * auth profiles, or configuration.
 */
export async function publicRestListAgents(c: Context<{ Bindings: Env }>) {
  return withPublicOrg(c, async (organizationId) => {
    const sql = getDb();
    const rows = await sql<{
      id: string;
      name: string;
      description: string | null;
      created_at: string;
    }>`
      SELECT id, name, description, created_at
      FROM agents
      WHERE organization_id = ${organizationId}
        AND parent_connection_id IS NULL
      ORDER BY created_at ASC
    `;
    return { agents: rows };
  });
}

/**
 * Cache keys safe to forward to anonymous / non-member viewers of a public org.
 * Must exclude notifications, member-admin, and connector-admin events.
 */
const PUBLIC_INVALIDATION_KEYS = new Set([
  'resolve-path',
  'entity-types',
  'view-template-history',
  'contents-filtered',
]);

/**
 * GET /api/:orgSlug/public/events
 * SSE stream of cache invalidation events for non-members of a public workspace.
 * Only public-readable keys are forwarded; notifications / member / connector
 * admin invalidations are filtered out.
 */
export async function publicRestEventsStream(c: Context<{ Bindings: Env }>) {
  const orgSlug = c.req.param('orgSlug');
  if (!orgSlug) return c.json({ error: 'Organization slug is required' }, 400);

  const organizationId = await resolvePublicOrganizationId(orgSlug);
  if (!organizationId) return c.json({ error: 'Not found' }, 404);

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));

      const unsubscribe = invalidationEmitter.subscribe(organizationId, (event) => {
        const publicKeys = event.keys.filter((k) => PUBLIC_INVALIDATION_KEYS.has(k));
        if (publicKeys.length === 0) return;
        try {
          const data = JSON.stringify({ ...event, keys: publicKeys });
          controller.enqueue(encoder.encode(`event: invalidate\ndata: ${data}\n\n`));
        } catch {
          // Connection closed
        }
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepAlive);
        }
      }, 30000);

      cleanup = () => {
        unsubscribe();
        clearInterval(keepAlive);
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return c.body(stream);
}

/**
 * PATCH /api/content/:id/classifications/:classifier_slug
 * Update a single content item's classification manually
 *
 * Path Parameters:
 * - id: Content ID (integer)
 * - classifier_slug: Classifier slug (e.g., "sentiment", "bug-severity")
 *
 * Body:
 * - value: string | null (null to unset)
 */
export async function restUpdateContentClassification(c: Context<{ Bindings: Env }>) {
  try {
    const contentId = parseInt(c.req.param('id') ?? '', 10);
    const classifierSlug = c.req.param('classifier_slug');
    const body = await c.req.json<{ value: string | null }>();

    if (Number.isNaN(contentId)) {
      return c.json({ error: 'Invalid content ID' }, 400);
    }

    if (!classifierSlug) {
      return c.json({ error: 'Classifier slug is required' }, 400);
    }

    // Call the MCP tool (manage_classifiers with classify action)
    const tool = getTool('manage_classifiers');
    if (!tool) {
      return c.json({ error: 'Tool not found' }, 500);
    }

    const role = c.var.memberRole;
    if (role !== 'owner' && role !== 'admin') {
      return c.json({ error: 'Forbidden', message: 'Owner or admin role required' }, 403);
    }

    const ctx = toToolContext(extractAuthContext(c));
    const result = await tool.handler(
      {
        action: 'classify',
        content_id: contentId,
        classifier_slug: classifierSlug,
        value: body.value,
      },
      c.env,
      ctx
    );

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    // Fetch the updated classification to return to frontend
    const sql = getDb();
    const classificationResult = await sql`
      SELECT
        fc.attribute_key,
        cc.values,
        cc.confidences,
        cc.source,
        cc.is_manual
      FROM event_classifications cc
      JOIN event_classifier_versions ccv ON cc.classifier_version_id = ccv.id
      JOIN event_classifiers fc ON ccv.classifier_id = fc.id
      WHERE cc.event_id = ${contentId}
        AND fc.slug = ${classifierSlug}
      ORDER BY
        CASE cc.source WHEN 'user' THEN 1 WHEN 'llm' THEN 2 ELSE 3 END,
        ccv.is_current DESC,
        cc.created_at DESC
      LIMIT 1
    `;

    if (classificationResult.length === 0) {
      return c.json({ error: 'Classification not found after update' }, 500);
    }

    const { attribute_key, values, confidences, source, is_manual } = classificationResult[0];
    const classificationData = { values, confidences, source, is_manual };

    return c.json(
      toJsonSafe({
        attribute_key,
        classification: classificationData,
      })
    );
  } catch (error) {
    logger.error({ error }, '[REST API] Update classification error');
    return c.json({ error: errorMessage(error) }, 400);
  }
}
