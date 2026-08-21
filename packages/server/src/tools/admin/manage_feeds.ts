/**
 * Tool: manage_feeds
 *
 * Manage data sync feeds for connections.
 *
 * Actions:
 * - list_feeds: List feeds with optional filters
 * - read_feed: Read one feed by id, dispatching on kind — a collected feed
 *   returns its metadata + recent sync runs; a virtual feed returns LIVE rows
 *   via the connector query()/search() pushdown (never synced); a streaming
 *   (chat-channel) feed returns its live transcript from channel_messages.
 * - read_feeds: Read several feeds in parallel with per-feed failures.
 * - create_feed: Create a new feed for a connection
 * - update_feed: Update feed settings
 * - delete_feed: Delete a feed
 * - trigger_feed: Trigger an immediate sync for a feed
 */

import { type Static } from '@sinclair/typebox';
import { getErrorMessage, parseJsonObject } from '@lobu/core';
import {
  CreateFeedAction,
  DeleteFeedAction,
  ListFeedsAction,
  ManageFeedsResultSchema,
  ManageFeedsSchema,
  ReadFeedAction,
  ReadFeedsAction,
  TriggerFeedAction,
  UpdateFeedAction,
  type ManageFeedsResult,
} from '@lobu/core/contracts/tools/manage-feeds';
import { getDb, pgBigintArray } from '../../db/client';
import { DEVICE_ONLINE_WINDOW_SECONDS } from '../../utils/device-liveness';
import { authzScopeFromToolContext } from '../../authz/scope';
import {
  feedLinkedEntityIdsSql,
  feedLinkedToBusinessEntitySql,
  listChannelAboutEntities,
} from '../../authz/channel-about';
import { filterChannelsForRequester } from '../../authz/channel-visibility';
import { readVirtualFeed } from '../../lib/connector-pushdown';
import {
  ATLASSIAN_JIRA_ISSUES_FEED_KEY,
  isAtlassianMcpConfig,
  normalizeMcpProxyConfig,
} from '../../operations/atlassian-mcp-feed';
import { reconcileAtlassianMcpJiraSite } from '../../connect/atlassian-mcp-site';
import { readChannelTranscript } from '../../gateway/connections/channel-transcript';
import type { Env } from '../../index';
import { getAuthProfileById } from '../../utils/auth-profiles';
import { nextRunAt, validateSchedule, validateTimezone } from '../../utils/cron';
import { compileConnectionRowVisibility } from '../../authz/connection-visibility';
import { recordChangeEvent } from '../../utils/insert-event';
import { recordToolConfigChange } from './helpers/config-audit';
import logger from '../../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../../utils/oauth-connection-state';
import { createSyncRun, describeSyncRunSkip } from '../../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../utils/run-statuses';
import { deriveFeedHealthSemantics } from '../../connectors/feed-health-semantics';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';
import { assertEntityIdsInOrg, callerIsAdmin } from './helpers/db-helpers';
import {
  resolveFeedDisplayName,
  validateFeedConfig,
  type FeedDefinition,
} from './helpers/feed-helpers';
import {
  feedSecretKeyLookup,
  feedSecretKeysFromSchema,
  loadFeedSecretKeys,
  redactConnectionConfig,
  restoreRedactedConfig,
  type ConnectorSecretKeys,
} from '../../utils/connection-config-redaction';

/**
 * Sanitize a raw `feeds` row before it is serialized to a caller.
 *
 * `list_feeds` / `read_feed` / `read_feeds` select `f.*` and spread the row, so
 * two columns need handling:
 *
 *  - `checkpoint` — the connector's opaque sync cursor. `table-schema.ts` names
 *    it as a column query_sql must never emit; there is no reason these tools
 *    should be a way around that, and cursors have historically carried tokens
 *    and full result payloads. Dropped.
 *  - `config` — free-form jsonb, written verbatim. Redacted on two layers, the
 *    same as connection config: the connector's own
 *    `feeds_schema[feed_key].configSchema` `format: "password"` declarations
 *    (exact), then the shared keyname/URI walk (backstop). `configSchema` is
 *    an unconstrained `Record<string, unknown>`, so a CUSTOM connector may
 *    declare a feed-scoped credential under any name — no shipped connector
 *    does today (all 27 audited, zero hits), which makes the declared layer
 *    latent rather than live, but custom definitions are a supported feature
 *    and the contract must not exempt a declaration site.
 *
 * All three actions are in PUBLIC_READ_ACTIONS, i.e. the same exposure tier as
 * the connections list/get paths this branch fixes.
 */
function toPublicFeed<T extends Record<string, unknown>>(
  row: T,
  declaredSecretKeys?: ConnectorSecretKeys
): Omit<T, 'checkpoint'> {
  const { checkpoint: _checkpoint, ...feed } = row;
  if (!('config' in feed)) return feed;
  return {
    ...feed,
    config: redactConnectionConfig(feed.config, declaredSecretKeys),
  };
}

/**
 * Batch form: sanitize a page of feed rows, resolving each one's
 * connector-declared secret keys from its own `connector_key` + `feed_key`.
 * One definition query for the whole page — a per-row lookup would reintroduce
 * an N+1 on the list path.
 */
async function toPublicFeeds<T extends Record<string, unknown>>(
  organizationId: string,
  rows: T[]
): Promise<Array<Omit<T, 'checkpoint'>>> {
  if (rows.length === 0) return [];
  const secretKeys = await loadFeedSecretKeys(organizationId, rows);
  return rows.map((row) => toPublicFeed(row, secretKeys.get(feedSecretKeyLookup(row))));
}

// ============================================
// Main Function (Action Router)
// ============================================

const manageFeedsTool = defineActionTool('manage_feeds', {
  list_feeds: action(ListFeedsAction, handleListFeeds),
  read_feed: action(ReadFeedAction, handleReadFeed),
  read_feeds: action(ReadFeedsAction, handleReadFeeds),
  create_feed: action(CreateFeedAction, handleCreateFeed),
  update_feed: action(UpdateFeedAction, handleUpdateFeed),
  delete_feed: action(DeleteFeedAction, handleDeleteFeed),
  trigger_feed: action(TriggerFeedAction, handleTriggerFeed),
});

export { ManageFeedsResultSchema, ManageFeedsSchema };
export const manageFeeds = manageFeedsTool.run;

const DEFAULT_BATCH_READ_TIMEOUT_MS = 10_000;
const MAX_BATCH_READ_TIMEOUT_MS = 30_000;

// ============================================
// Action Handlers
// ============================================

async function handleListFeeds(
  args: Static<typeof ListFeedsAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // Build the filtered "page" of feeds first, then compute event_count in a
  // single GROUP BY restricted to the (connection_id, feed_key) tuples on
  // that page. The previous shape ran a correlated
  // `SELECT COUNT(*) FROM current_event_records` per row — O(N feeds) ×
  // an anti-join over the entire events table — ~880ms per feed on a busy
  // connection. Batching collapses it to one scan.
  // Filter predicates built ONCE and shared between the page query and the
  // overshoot fallback count, so the two can never diverge. `where` starts with
  // a TRUE seed so every real condition appends uniformly with AND.
  let where = sql`f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL`;
  if (args.connection_id) {
    where = sql`${where} AND f.connection_id = ${args.connection_id}`;
  }
  if (args.entity_id) {
    where = sql`${where} AND ${sql.unsafe(
      feedLinkedToBusinessEntitySql(String(args.entity_id), 'f', 'c', 'f.organization_id'),
    )}`;
  }
  if (args.status) {
    where = sql`${where} AND f.status = ${args.status}`;
  }
  // Runtime health applies only to feeds in the active lifecycle. A feed keeps
  // `status = 'active'` while its syncs fail — until `shouldHardPauseFeed`
  // auto-pauses it — so `status` alone cannot surface active-but-failing feeds.
  // Once the feed or its parent connection is paused, its last outcome is
  // lifecycle history rather than current health, so the guard scopes BOTH
  // branches and such a row comes back as neither failing nor healthy. This
  // mirrors the lifecycle and execution-failure portions of
  // `deriveFeedHealthSemantics`, so `healthy` never renders as paused,
  // last_attempt_failed, or overdue. Auth/device/misconfiguration attention is
  // intentionally separate from this sync-health filter.
  if (args.health) {
    where = sql`${where} AND f.status = 'active' AND c.status <> 'paused'`;
    const overdue = sql`
      COALESCE(f.kind, 'collected') NOT IN ('virtual', 'streaming')
      AND NOT COALESCE(f.virtual, false)
      AND COALESCE(f.schedule, '') <> ''
      AND f.next_run_at IS NOT NULL
      AND f.next_run_at < now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.feed_id = f.id
          AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      )
    `;
    if (args.health === 'failing') {
      where = sql`${where} AND (
        f.last_sync_status = 'failed'
        OR COALESCE(f.consecutive_failures, 0) > 0
        OR (${overdue})
      )`;
    } else {
      where = sql`${where}
        AND f.last_sync_status IS DISTINCT FROM 'failed'
        AND COALESCE(f.consecutive_failures, 0) = 0
        AND NOT (${overdue})
      `;
    }
  }
  if (args.feed_ids?.length) {
    where = sql`${where} AND f.id = ANY(${pgBigintArray(args.feed_ids)}::bigint[])`;
  }

  // COUNT(*) OVER() runs across the whole filtered set BEFORE LIMIT/OFFSET, so
  // `filtered_total` is the true match count on every non-empty page — not the
  // page length (the previous `rows.length` reported `total: 50` for a 71-feed
  // org and made every failing feed past page 1 invisible). It is 0 on an empty
  // page (offset past the last row); the overshoot fallback below recovers the
  // true count there.
  const pageQuery = sql`
    SELECT f.*, c.connector_key, COUNT(*) OVER()::int AS filtered_total
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE ${where}
    ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}
  `;

  const query = sql`
    WITH page AS MATERIALIZED (
      ${pageQuery}
    ),
    event_counts AS (
      SELECT e.connection_id, e.feed_key, COUNT(*)::int AS event_count
      FROM events e
      WHERE e.organization_id = ${organizationId}
        -- ANY(ARRAY(...)) on each column lets the planner stay on
        -- per-column index scans and intersect, rather than re-scanning
        -- the connection_id index per (connection, feed_key) pair the
        -- way IN (subquery) on a tuple would. The feed_key ANY narrows
        -- the scan to the keys actually on this page; the final LEFT
        -- JOIN drops any over-count from the cross-product.
        AND e.connection_id = ANY(ARRAY(SELECT DISTINCT connection_id FROM page))
        AND e.feed_key = ANY(ARRAY(SELECT DISTINCT feed_key FROM page WHERE feed_key IS NOT NULL))
        AND e.superseded_by IS NULL
      GROUP BY e.connection_id, e.feed_key
    )
    SELECT p.*, c.connector_key, c.display_name AS connection_name,
           c.status AS connection_status,
           c.external_tenant_id AS external_tenant_id,
           c.device_worker_id,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS})) AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - make_interval(secs => ${DEVICE_ONLINE_WINDOW_SECONDS}))
             THEN 'offline'
           END AS device_status,
           cd.name AS connector_name,
           ap.profile_kind AS auth_profile_kind,
           ap.status AS auth_profile_status,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.deleted_at IS NULL
               AND ent.id IN ${sql.unsafe(feedLinkedEntityIdsSql('p', 'c'))}
           ) AS entity_names,
           (SELECT COUNT(*) FROM runs r WHERE r.feed_id = p.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[]))::int AS active_runs,
           -- Agent targeted by this feed's channel Automation (streaming feeds only), so the
           -- Automations Listen picker can hide channels already owned by another
           -- agent instead of silently reassigning the Automation when linked.
           (SELECT subscription.agent_id
             FROM automation_message_subscriptions subscription
             WHERE subscription.organization_id = p.organization_id
               AND subscription.connection_id = p.connection_id
               AND subscription.channel_id = p.feed_key
             LIMIT 1) AS target_agent_id,
           COALESCE(ec.event_count, 0)::int AS event_count
    FROM page p
    JOIN connections c ON c.id = p.connection_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    LEFT JOIN LATERAL (
      SELECT name
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN event_counts ec ON ec.connection_id = p.connection_id AND ec.feed_key = p.feed_key
    ORDER BY p.created_at DESC
  `;

  const rows = (await query) as Array<Record<string, unknown>>;
  // COUNT(*) OVER() is constant across the page. On a non-empty page it is the
  // true whole-filter count. On an empty page (offset past the last row) there
  // is no row to read it from, so recover the true count with a bare COUNT over
  // the SAME shared `where` — one extra query only on the rare overshoot path,
  // keeping `total` truthful for page-jumps rather than reporting 0.
  let total: number;
  if (rows.length > 0) {
    total = Number(rows[0].filtered_total ?? rows.length);
  } else {
    const [countRow] = (await sql`
      SELECT COUNT(*)::int AS total
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      WHERE ${where}
    `) as Array<{ total: number }>;
    total = Number(countRow?.total ?? 0);
  }
  // Strip the window-count helper column from each feed row — it is metadata
  // about the result set, not a feed field — then sanitize the row itself
  // (checkpoint out, config redacted). Attach the derived health semantics
  // (execution mode / attention) computed from the joined row fields at read
  // time — never stored.
  const feeds = await toPublicFeeds(
    organizationId,
    rows.map(({ filtered_total: _filtered_total, ...feed }) => feed)
  );
  const feedsWithHealth = feeds.map((feed) => {
    const semantics = deriveFeedHealthSemantics({
      kind: feed.kind as string | null,
      virtual: feed.virtual as boolean | null,
      status: feed.status as string | null,
      schedule: feed.schedule as string | null,
      last_sync_status: feed.last_sync_status as string | null,
      last_sync_at: feed.last_sync_at as Date | string | null,
      consecutive_failures: feed.consecutive_failures as number | null,
      next_run_at: feed.next_run_at as Date | string | null,
      active_runs: feed.active_runs as number | null,
      connection_status: feed.connection_status as string | null,
      auth_profile_status: feed.auth_profile_status as string | null,
      device_worker_id: feed.device_worker_id as string | null,
      device_online: feed.device_online as boolean | null,
    });
    return {
      ...feed,
      execution_mode: semantics.executionMode,
      attention: semantics.attention,
    };
  });
  return {
    action: 'list_feeds',
    feeds: feedsWithHealth,
    total,
    has_more: offset + feeds.length < total,
    limit,
    offset,
  };
}

async function handleReadFeed(
  args: Static<typeof ReadFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;
  // Connection-visibility gate (mirrors manage_connections crud handleList/Get):
  // read_feed is in PUBLIC_READ_ACTIONS, so a feed's config/transcript is content
  // an anonymous caller could otherwise pull by guessing a feed_id. Owners/admins
  // see all; everyone else gets the shared connection-visibility predicate
  // (anonymous → org-only).
  const visibilityFilter = (await callerIsAdmin(sql, ctx))
    ? sql``
    : sql`${sql.unsafe(compileConnectionRowVisibility(authzScopeFromToolContext(ctx), 'c'))}`;

  const rows = (await sql`
    SELECT f.*,
           c.slug,
           c.connector_key,
           c.external_tenant_id,
           c.display_name AS connection_name,
           -- The channel's CONCRETE workspace, from its Automation trigger: the
           -- SAME real team the about-edge writer keyed on. For a Grid org-wide install the
           -- connection tenant is the enterprise E-id, so the about lookup must
           -- NOT fall back to it; the trigger holds the real T-id.
           (SELECT subscription.trigger_team_id
             FROM automation_message_subscriptions subscription
             WHERE subscription.organization_id = f.organization_id
               AND subscription.connection_id = f.connection_id
               AND subscription.channel_id = f.feed_key
               AND subscription.trigger_team_id IS NOT NULL
             LIMIT 1) AS automation_team_id,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.deleted_at IS NULL
               AND ent.id IN ${sql.unsafe(feedLinkedEntityIdsSql('f', 'c'))}
           ) AS entity_names
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id}
      AND f.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
      ${visibilityFilter}
  `) as Array<Record<string, any>>;
  if (rows.length === 0) return { error: 'Feed not found' };
  const [feed] = await toPublicFeeds(organizationId, [rows[0]]);

  // A streaming (chat-channel) feed has no sync runs — its content is the live
  // transcript in `channel_messages`. Map the connection slug + feed_key to the
  // runtime ids channel_messages is keyed by: the BYO namespace is stripped off
  // the slug (mirror of resolveBoundChannelRows), and the platform prefix
  // (`slack:`) is stripped off feed_key to the bare channel id capture stores.
  if (feed.kind === 'streaming') {
    const slug = String(feed.slug);
    const feedKey = String(feed.feed_key);
    const connectionId = slug.startsWith('agentconn-') ? slug.slice(10) : slug;
    const channelId = feedKey.includes(':')
      ? feedKey.slice(feedKey.indexOf(':') + 1)
      : feedKey;
    // The connection-visibility gate above only decides who can see the
    // CONNECTION. For an ACL-enforced Slack channel the transcript is further
    // gated to channel members — a user who can see the connection but isn't in
    // the channel must NOT read its messages. Non-enforced channels pass through
    // (same posture as search_memory). Fail-closed: a dropped row → no transcript.
    const visible = await filterChannelsForRequester(sql, {
      organizationId,
      userId: userId ?? null,
      rows: [
        {
          id: connectionId,
          platform: String(feed.connector_key ?? 'slack'),
          channel_id: channelId,
          team_id: (feed.external_tenant_id as string | null) ?? null,
        },
      ],
    });
    if (visible.length === 0) {
      return { action: 'read_feed', kind: 'streaming', feed, messages: [] };
    }
    const messages = await readChannelTranscript(
      organizationId,
      connectionId,
      channelId,
      args.limit ?? 50
    );
    const aboutEntities = await listChannelAboutEntities({
      organizationId,
      connectionId: feed.connection_id,
      connectorKey: String(feed.connector_key ?? 'slack'),
      // The Automation trigger's real workspace (`T…`) — NOT the connection tenant,
      // which is the enterprise `E…` on a Grid org-wide install. Falls back to the tenant
      // only for a non-team-scoped connector / not-yet-healed trigger, matching
      // the writer.
      teamId:
        (feed.automation_team_id as string | null) ??
        (feed.external_tenant_id as string | null) ??
        null,
      channelId: feedKey,
    });
    return {
      action: 'read_feed',
      kind: 'streaming',
      feed,
      messages,
      team_id: (feed.external_tenant_id as string | null) ?? null,
      about_entities: aboutEntities,
    };
  }

  // A virtual feed is never synced — its content is read LIVE at request time
  // via the connector's query()/search() pushdown (no events written). Same
  // AuthzScope connection-visibility gate as the query_sql pushdown: a member
  // only reaches org-visible or own connections; the feed's connection is the
  // ACL boundary.
  if (feed.kind === 'virtual') {
    const live = await readVirtualFeed({
      scope: authzScopeFromToolContext({ organizationId, userId: userId ?? null }),
      feedId: args.feed_id,
      limit: args.limit,
      terms: args.search_term ? [args.search_term] : undefined,
    });
    return { action: 'read_feed', kind: 'virtual', feed, ...live };
  }

  const runs = await sql`
    SELECT id, status, items_collected, error_message, created_at, completed_at, checkpoint, connector_version,
           dry_run, dry_run_preview
    FROM runs
    WHERE feed_id = ${args.feed_id} AND run_type = 'sync'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return { action: 'read_feed', kind: String(feed.kind), feed, recent_runs: runs };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function handleReadFeeds(
  args: Static<typeof ReadFeedsAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const rawTimeoutMs = Number(args.timeout_ms ?? DEFAULT_BATCH_READ_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeoutMs)
    ? Math.max(1000, Math.min(MAX_BATCH_READ_TIMEOUT_MS, Math.trunc(rawTimeoutMs)))
    : DEFAULT_BATCH_READ_TIMEOUT_MS;
  const feedIds = [...new Set(args.feed_ids.map((id) => Number(id)))].slice(0, 10);
  const results = await Promise.all(
    feedIds.map(async (feedId) => {
      try {
        const result = await withTimeout(
          handleReadFeed(
            { action: 'read_feed', feed_id: feedId, limit: args.limit, search_term: args.search_term },
            ctx
          ),
          timeoutMs,
          `read_feed ${feedId} timed out after ${timeoutMs}ms`
        );
        if ('error' in result) {
          return { feed_id: feedId, ok: false, error: result.error };
        }
        return { feed_id: feedId, ok: true, result };
      } catch (err) {
        return { feed_id: feedId, ok: false, error: getErrorMessage(err) };
      }
    })
  );

  return {
    action: 'read_feeds',
    results,
    failures: results.filter((r) => !r.ok).length,
    timeout_ms: timeoutMs,
  };
}

async function handleCreateFeed(
  args: Static<typeof CreateFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const connRows = await sql`
    SELECT c.id, c.connector_key, c.status, c.auth_profile_id, c.config,
           cd.feeds_schema, cd.mcp_config
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT feeds_schema, mcp_config
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id} AND c.organization_id = ${organizationId}
  `;

  if (connRows.length === 0) {
    return { error: 'Connection not found' };
  }

  const conn = connRows[0] as any;
  // Consent-only connections exist solely to hold an OAuth grant for delegation
  // (the cloud grant-holder behind a managed connector); they cannot have feeds,
  // so they never sync. This is the by-construction guarantee that a managed
  // connector's data only ever lives on the local instance — a consent-only
  // cloud connection can never get a feed, so the cloud worker never syncs it.
  const connConfig = parseJsonObject(conn.config);
  if (connConfig.consent_only === true) {
    return {
      error:
        'This connection is consent-only (holds an OAuth grant for delegation) and cannot have feeds.',
    };
  }
  // A `pending_auth` connection is OK — the feed is created `paused` (the
  // `feeds.status` CHECK only allows active|paused|error). The OAuth/connect
  // callback un-pauses the connection's feeds when it activates the connection.
  if (conn.status !== 'active' && conn.status !== 'pending_auth') {
    return { error: `Connection is ${conn.status}, must be active or pending_auth to create feeds` };
  }
  const feedInitialStatus = conn.status === 'active' ? 'active' : 'paused';

  const feedsSchema = conn.feeds_schema as Record<string, any> | null;
  if (feedsSchema && !feedsSchema[args.feed_key]) {
    return {
      error: `Invalid feed_key '${args.feed_key}'. Available: ${Object.keys(feedsSchema).join(', ')}`,
    };
  }

  // A virtual feed is read LIVE at request time and never synced, so it has no
  // schedule. config.query is an optional scope fence; agents can compose further
  // filters at read time (query_sql feed_query) or pass recall terms.
  // Default from the connector feed definition (`feeds_schema[key].virtual`) when
  // the caller omits `virtual`. Explicit `args.virtual` always wins (true or false).
  const schemaDefaultVirtual = feedsSchema?.[args.feed_key]?.virtual === true;
  const isVirtual =
    args.virtual === true || (args.virtual !== false && schemaDefaultVirtual);

  // Resolve the concrete Atlassian site through the authenticated MCP
  // connection at this write-time chokepoint. Persisting site identity makes
  // future live reads and Jira app webhook routing exact and replica-safe.
  let effectiveFeedConfig: Record<string, unknown> = { ...(args.config ?? {}) };
  const mcpConfig = isAtlassianMcpConfig(conn.mcp_config)
    ? normalizeMcpProxyConfig(conn.mcp_config)
    : null;
  if (
    conn.status === 'active' &&
    mcpConfig &&
    args.feed_key === ATLASSIAN_JIRA_ISSUES_FEED_KEY
  ) {
    try {
      const preferredCloudId =
        typeof effectiveFeedConfig.cloud_id === 'string'
          ? effectiveFeedConfig.cloud_id.trim() || undefined
          : undefined;
      const { configPatch } = await reconcileAtlassianMcpJiraSite({
        organizationId,
        connectionId: Number(conn.id),
        connectorKey: String(conn.connector_key),
        mcpConfig,
        preferredCloudId,
      });
      effectiveFeedConfig = { ...effectiveFeedConfig, ...configPatch };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }

  // Validate config against the connector's declared feed configSchema up
  // front so a mis-shaped config fails here instead of at sync or live-read
  // time. The schema describes both collected and virtual feed configuration,
  // but its `required` fields are the sync contract only, and a virtual feed is
  // never synced, so a missing one must not gate creation (rss `articles`
  // requires feed_urls; a virtual read of it needs only the query fence).
  const configError = validateFeedConfig(feedsSchema, args.feed_key, effectiveFeedConfig, {
    ignoreRequired: isVirtual,
  });
  if (configError) return { error: configError };

  // Omit / empty schedule = manual only (no automatic poll). Virtual feeds
  // always persist schedule = NULL. Do not invent a default cron.
  const rawSchedule = isVirtual ? null : (args.schedule ?? null);
  const schedule =
    rawSchedule == null || String(rawSchedule).trim() === ''
      ? null
      : String(rawSchedule).trim();
  if (schedule) {
    const scheduleError = validateSchedule(schedule);
    if (scheduleError) {
      return { error: scheduleError };
    }
  }
  // Virtual feeds never sync, so a timezone is meaningless there — drop it.
  const timezone = isVirtual ? null : (args.timezone ?? null);
  if (timezone) {
    const tzError = validateTimezone(timezone);
    if (tzError) {
      return { error: tzError };
    }
  }

  // Don't schedule a first run for a feed whose connection is still pending auth,
  // or for a virtual feed (never synced — schedule is NULL).
  const nextRunAtVal =
    schedule && feedInitialStatus === 'active'
      ? nextRunAt(schedule, new Date(), timezone)
      : null;
  // Reject cross-org entity_ids: a feed pointing at another org's entity links
  // synced events to a non-existent in-org entity (silent data-correctness bug).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
  const entityIdsValue =
    args.entity_ids && args.entity_ids.length > 0 ? pgBigintArray(args.entity_ids) : null;

  const displayName = await resolveFeedDisplayName({
    explicitName: args.display_name,
    feedKey: args.feed_key,
    config: effectiveFeedConfig,
    entityIds: args.entity_ids ?? null,
    feedsSchema,
  });

  const inserted = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status,
      entity_ids, config, schedule, timezone, next_run_at, kind, virtual
    ) VALUES (
      ${organizationId}, ${args.connection_id}, ${args.feed_key}, ${displayName}, ${feedInitialStatus},
      ${entityIdsValue}::bigint[],
      ${args.config || Object.keys(effectiveFeedConfig).length > 0 ? sql.json(effectiveFeedConfig) : null},
      ${schedule}, ${timezone}, ${nextRunAtVal},
      ${isVirtual ? 'virtual' : 'collected'}, ${isVirtual}
    )
    RETURNING *
  `;

  if (Number(conn.auth_profile_id)) {
    const authProfile = await getAuthProfileById(organizationId, Number(conn.auth_profile_id));
    if (authProfile?.profile_kind === 'oauth_account') {
      await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
    }
  }

  logger.info(
    { feed_id: inserted[0].id, connector_key: conn.connector_key, feed_key: args.feed_key },
    'Feed created'
  );

  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: inserted[0].id as number,
    op: 'created',
    summary: `Feed '${displayName}' created`,
    state: inserted[0] as Record<string, unknown>,
  });

  return {
    action: 'create_feed',
    feed: toPublicFeed(
      inserted[0] as Record<string, unknown>,
      // `feedsSchema` is the connector definition already loaded above for
      // config validation — no extra lookup needed.
      feedSecretKeysFromSchema(feedsSchema, args.feed_key)
    ),
  };
}

async function handleUpdateFeed(
  args: Static<typeof UpdateFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Reject cross-org entity_ids on update too (skip when clearing to []).
  if (args.entity_ids !== undefined && args.entity_ids.length > 0) {
    try {
      await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }
  const entityIdsValue =
    args.entity_ids !== undefined
      ? args.entity_ids.length > 0
        ? pgBigintArray(args.entity_ids)
        : '{}'
      : null;

  // `schedule` is tri-state: undefined = leave alone, null/"" = clear (manual),
  // string = set cron. Mirror timezone.
  const hasScheduleArg = Object.hasOwn(args, 'schedule');
  let nextSchedule: string | null | undefined;
  if (hasScheduleArg) {
    const raw = args.schedule;
    nextSchedule =
      raw == null || String(raw).trim() === '' ? null : String(raw).trim();
    if (nextSchedule) {
      const scheduleError = validateSchedule(nextSchedule);
      if (scheduleError) {
        return { error: scheduleError };
      }
    }
  }
  if (args.timezone) {
    const tzError = validateTimezone(args.timezone);
    if (tzError) {
      return { error: tzError };
    }
  }
  const hasTimezoneArg = args.timezone !== undefined;
  const touchesCadence = hasScheduleArg || hasTimezoneArg;

  // Declarative `lobu apply` passes `replace_config: true` so removed manifest
  // keys disappear remotely; default (merge) is preserved for the web UI.
  const replaceFeedConfig = args.replace_config === true && args.config !== undefined;
  const hasConfigArg = args.config !== undefined;

  // Row-locked read→validate→write: the stored config is read, the EFFECTIVE
  // config (merge or replace) computed and validated against the connector's
  // declared feed configSchema, and exactly that validated object persisted —
  // all under one FOR UPDATE lock, so a concurrent update cannot interleave an
  // unvalidated merge between the read and the write, and AJV coercions land
  // in what is stored. Without the schema check a patch could push the stored
  // config into a shape that only fails at sync time.
  const txResult = await sql.begin(async (tx) => {
    const existing = await tx`
      SELECT f.id, f.status, f.schedule, f.timezone, f.feed_key, f.kind, f.config, c.auth_profile_id, cd.feeds_schema
      FROM feeds f
      JOIN connections c ON c.id = f.connection_id
      LEFT JOIN LATERAL (
        SELECT feeds_schema
        FROM connector_definitions
        WHERE key = c.connector_key
          AND status = 'active'
          AND organization_id = ${organizationId}
        ORDER BY updated_at DESC
        LIMIT 1
      ) cd ON TRUE
      WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId}
      FOR UPDATE OF f
    `;
    if (existing.length === 0) {
      return { error: 'Feed not found' } as const;
    }
    const feedRow = existing[0] as Record<string, unknown>;

    // `read_feed`/`list_feeds` redact feeds.config, so a client that reads and
    // PATCHes back would otherwise persist `__LOBU_REDACTED__` over the stored
    // value. Restore from the row (read under the same FOR UPDATE lock, so the
    // restore sees exactly what the write is based on) before merge/replace.
    const restoredConfig = hasConfigArg
      ? (restoreRedactedConfig(args.config, parseJsonObject(feedRow.config)) as Record<
          string,
          unknown
        >)
      : undefined;
    const effectiveConfig = hasConfigArg
      ? replaceFeedConfig
        ? (restoredConfig as Record<string, unknown>)
        : { ...parseJsonObject(feedRow.config), ...restoredConfig }
      : null;
    if (effectiveConfig) {
      // Same split as create_feed: shape always, `required` only for feeds that
      // actually sync (virtual/streaming configs are not the sync contract).
      const configError = validateFeedConfig(
        feedRow.feeds_schema as Record<string, FeedDefinition> | null,
        String(feedRow.feed_key),
        effectiveConfig,
        { ignoreRequired: feedRow.kind !== 'collected' }
      );
      if (configError) return { error: configError } as const;
    }

    // Resume starts a fresh failure episode so the next hard-pause emits a new
    // feed.auto_paused delivery_id (keyed on first_failure_at) instead of
    // silently reusing the prior pause episode's Automation run.
    const resuming =
      args.status === 'active' && String(feedRow.status) !== 'active';

    // Recompute next_run_at when the cadence OR its zone changes; the effective
    // pair mixes the incoming args with the stored row for whichever side was
    // omitted, so a timezone-only update re-anchors the pending sync. Clearing
    // schedule (null) clears next_run_at — manual feeds do not auto-poll.
    // Also re-anchor on resume: hard-pause nulls next_run_at, so unpausing
    // without a schedule edit would otherwise leave the feed never scheduled.
    const effectiveSchedule = hasScheduleArg
      ? (nextSchedule ?? null)
      : (feedRow.schedule as string | null);
    const effectiveTimezone = hasTimezoneArg
      ? (args.timezone ?? null)
      : (feedRow.timezone as string | null);
    const recomputeNextRun = touchesCadence || resuming;
    const nextRunAtVal =
      recomputeNextRun && effectiveSchedule
        ? nextRunAt(effectiveSchedule, new Date(), effectiveTimezone)
        : null;

    const updated = await tx`
      UPDATE feeds
      SET display_name = COALESCE(${args.display_name ?? null}::text, display_name),
          status = COALESCE(${args.status ?? null}::text, status),
          entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
          config = CASE WHEN ${hasConfigArg} THEN ${tx.json(effectiveConfig ?? {})}::jsonb ELSE config END,
          schedule = CASE WHEN ${hasScheduleArg} THEN ${nextSchedule ?? null} ELSE schedule END,
          timezone = CASE WHEN ${hasTimezoneArg} THEN ${args.timezone ?? null} ELSE timezone END,
          next_run_at = CASE WHEN ${recomputeNextRun} THEN ${nextRunAtVal}::timestamptz ELSE next_run_at END,
          consecutive_failures = CASE WHEN ${resuming} THEN 0 ELSE consecutive_failures END,
          first_failure_at = CASE WHEN ${resuming} THEN NULL ELSE first_failure_at END,
          updated_at = NOW()
      WHERE id = ${args.feed_id} AND organization_id = ${organizationId}
      RETURNING *
    `;
    return {
      updated,
      authProfileId: Number(feedRow.auth_profile_id) || null,
      // Resolved here because the connector's feeds_schema is already joined
      // into this query — the response serializer below needs it to redact
      // feed-scoped `format: "password"` fields without a second lookup.
      declaredSecretKeys: feedSecretKeysFromSchema(
        feedRow.feeds_schema,
        String(feedRow.feed_key)
      ),
    };
  });
  if ('error' in txResult && txResult.error !== undefined) {
    return { error: txResult.error };
  }
  const { updated, authProfileId, declaredSecretKeys } = txResult;
  if (authProfileId) {
    const authProfile = await getAuthProfileById(organizationId, authProfileId);
    if (authProfile?.profile_kind === 'oauth_account') {
      await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
    }
  }

  const updatedFeed = updated[0] as Record<string, unknown>;
  const changedFields = [
    ...(args.display_name !== undefined ? ['display_name'] : []),
    ...(args.status !== undefined ? ['status'] : []),
    ...(args.entity_ids !== undefined ? ['entity_ids'] : []),
    ...(args.config !== undefined ? ['config'] : []),
    ...(args.schedule !== undefined ? ['schedule'] : []),
    ...(hasTimezoneArg ? ['timezone'] : []),
  ];
  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: args.feed_id,
    op: 'updated',
    summary: `Feed '${updatedFeed.display_name ?? updatedFeed.feed_key ?? args.feed_id}' updated`,
    state: updatedFeed,
    ...(changedFields.length > 0 ? { changedFields } : {}),
  });

  return {
    action: 'update_feed',
    feed: toPublicFeed(updatedFeed, declaredSecretKeys),
  };
}

async function handleDeleteFeed(
  args: Static<typeof DeleteFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Prove org ownership BEFORE any side effect: the run-cancel below is not
  // org-scoped (runs has no organization_id of its own — it's reached through
  // the feed), so cancelling runs first would let a guessed foreign feed_id
  // cancel another org's runs even though the delete then no-ops. Delete the
  // org-owned feed first and bail when nothing matched.
  const deleted = await sql`
    UPDATE feeds
    SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
    WHERE id = ${args.feed_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id, feed_key, connection_id, entity_ids
  `;

  if (deleted.length === 0) {
    return { error: 'Feed not found or already deleted' };
  }

  // Ownership confirmed — now safe to cancel this feed's active runs.
  await sql`
    UPDATE runs SET status = 'cancelled', completed_at = NOW()
    WHERE feed_id = ${args.feed_id} AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  // Record change event in knowledge for audit trail
  const feed = deleted[0];
  const feedEntityIds = Array.isArray(feed.entity_ids) ? feed.entity_ids : [];
  recordChangeEvent({
    entityIds: feedEntityIds.map(Number),
    organizationId,
    subject: 'feed',
    op: 'deleted',
    title: `Feed deleted: ${feed.feed_key}`,
    content: `Feed "${feed.feed_key}" (id: ${args.feed_id}) was deleted.`,
    metadata: {
      action: 'feed_deleted',
      feed_id: args.feed_id,
      feed_key: feed.feed_key,
      connection_id: feed.connection_id,
    },
  });

  recordToolConfigChange(ctx, {
    resourceKind: 'feed',
    resourceId: args.feed_id,
    op: 'deleted',
    summary: `Feed '${feed.feed_key}' deleted`,
    state: null,
  });

  return { action: 'delete_feed', deleted: true, feed_id: args.feed_id };
}

async function handleTriggerFeed(
  args: Static<typeof TriggerFeedAction>,
  ctx: ToolContext,
  env: Env
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const feedRows = await sql`
    SELECT f.id, f.status, f.kind, f.connection_id, c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (feedRows.length === 0) {
    return { error: 'Feed not found' };
  }

  const feed = feedRows[0] as any;
  // Only collected feeds run a connector sync. Streaming feeds (chat channels)
  // are fed by inbound webhooks/capture, not a sync run — triggering one would
  // spawn a run against a connector that has no fetch for this feed.
  if (feed.kind !== 'collected') {
    return { error: `Feed is ${feed.kind}, only collected feeds can be triggered` };
  }
  if (feed.status !== 'active') {
    return { error: `Feed is ${feed.status}, must be active to trigger sync` };
  }

  const dryRun = args.dry_run === true;
  const created = await createSyncRun(args.feed_id, env, undefined, { dryRun });
  if (!created.ok) {
    return { action: 'trigger_feed', message: describeSyncRunSkip(created.reason) };
  }
  const runId = created.runId;

  // `dry_run` is echoed only when true, and only because it was honoured. A
  // caller cannot otherwise distinguish "ran dry" from "flag silently dropped
  // and everything persisted", which is the one outcome that would matter.
  return {
    action: 'trigger_feed',
    triggered: true,
    run_id: runId,
    feed_id: args.feed_id,
    ...(dryRun ? { dry_run: true } : {}),
  };
}
