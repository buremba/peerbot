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
 * - create_feed: Create a new feed for a connection
 * - update_feed: Update feed settings
 * - delete_feed: Delete a feed
 * - trigger_feed: Trigger an immediate sync for a feed
 */

import { getErrorMessage, parseJsonObject } from '@lobu/core';
import { type Static, Type } from '@sinclair/typebox';
import { getDb, pgBigintArray } from '../../db/client';
import { authzScopeFromToolContext } from '../../authz/scope';
import { filterChannelsForRequester } from '../../authz/channel-visibility';
import { readVirtualFeed } from '../../lib/connector-pushdown';
import { readChannelTranscript } from '../../gateway/connections/channel-transcript';
import type { Env } from '../../index';
import { getAuthProfileById } from '../../utils/auth-profiles';
import { nextRunAt, validateSchedule } from '../../utils/cron';
import { getWorkspaceRole } from '../../utils/organization-access';
import { recordChangeEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../../utils/oauth-connection-state';
import { createSyncRun } from '../../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../utils/run-statuses';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';
import { getDefaultSchedule } from './helpers/connection-helpers';
import { assertEntityIdsInOrg } from './helpers/db-helpers';
import { resolveFeedDisplayName } from './helpers/feed-helpers';
import { PaginationFields } from './schemas/common-fields';

// ============================================
// Schema
// ============================================

const ListFeedsAction = Type.Object({
  action: Type.Literal('list_feeds'),
  connection_id: Type.Optional(Type.Number({ description: 'Filter by connection ID' })),
  feed_ids: Type.Optional(
    Type.Array(Type.Integer({ minimum: 1 }), { description: 'Filter to specific feed IDs' })
  ),
  entity_id: Type.Optional(Type.Number({ description: 'Filter by linked entity ID' })),
  status: Type.Optional(Type.String({ description: 'Filter by status: active, paused, error' })),
  ...PaginationFields,
});

// One read action for any feed kind. A collected/virtual feed returns its
// metadata + recent sync runs; a streaming (chat-channel) feed has no sync runs
// — its content is the live transcript in `channel_messages` — so it returns
// that instead, read through the same primitive read_conversation uses. The
// caller never has to know the kind up front; the response carries it.
const ReadFeedAction = Type.Object({
  action: Type.Literal('read_feed'),
  feed_id: Type.Number({ description: 'Feed ID' }),
  limit: Type.Optional(
    Type.Number({ description: 'Max transcript messages for a streaming feed (default 50)' })
  ),
});

const CreateFeedAction = Type.Object({
  action: Type.Literal('create_feed'),
  connection_id: Type.Number({ description: 'Connection ID this feed belongs to' }),
  feed_key: Type.String({ description: 'Feed key from connector definition (e.g. threads)' }),
  display_name: Type.Optional(Type.String({ description: 'Human-readable name for this feed' })),
  entity_ids: Type.Optional(
    Type.Array(Type.Number(), { description: 'Entity IDs to tag events with' })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), { description: 'Feed-specific configuration' })
  ),
  schedule: Type.Optional(
    Type.String({ description: 'Cron expression for sync schedule (default: every 6 hours)' })
  ),
  virtual: Type.Optional(
    Type.Boolean({
      description:
        'When true, create a VIRTUAL feed (kind=virtual): read LIVE via the connector query()/search() pushdown at request time, never synced — sync-lifecycle columns stay NULL. Requires config.query (a connector-specific read predicate, e.g. a Gmail search string) and the connector to implement the pushdown.',
    })
  ),
});

const UpdateFeedAction = Type.Object({
  action: Type.Literal('update_feed'),
  feed_id: Type.Number({ description: 'Feed ID' }),
  status: Type.Optional(Type.String({ description: 'active, paused, error' })),
  display_name: Type.Optional(Type.String()),
  entity_ids: Type.Optional(Type.Array(Type.Number())),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
  replace_config: Type.Optional(
    Type.Boolean({
      description:
        'When true and `config` is provided, replace the stored feed config with exactly that object (declarative apply); when false/omitted, merge into the existing config (default).',
    })
  ),
  schedule: Type.Optional(Type.String({ description: 'Cron expression for sync schedule' })),
  repair_agent_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description:
        'Per-feed repair agent override. Null clears the override and falls back to the connector default.',
    })
  ),
});

const DeleteFeedAction = Type.Object({
  action: Type.Literal('delete_feed'),
  feed_id: Type.Number({ description: 'Feed ID' }),
});

const TriggerFeedAction = Type.Object({
  action: Type.Literal('trigger_feed'),
  feed_id: Type.Number({ description: 'Feed ID to trigger sync for' }),
});

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_feeds` — discriminated union (on `action`, plus an error
 * variant). TypeBox-first: `Static<>` derives the TS type from the same schema
 * exposed as the tool's `outputSchema`. Feed rows are wide, join-driven
 * snapshots (no stable contract), so they're honestly `Record<string, unknown>`.
 */
export const ManageFeedsResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal('list_feeds'),
    feeds: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal('read_feed'),
    kind: Type.String(),
    feed: Type.Record(Type.String(), Type.Unknown()),
    recent_runs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal('read_feed'),
    kind: Type.Literal('streaming'),
    feed: Type.Record(Type.String(), Type.Unknown()),
    messages: Type.Array(
      Type.Object({
        timestamp: Type.String(),
        user: Type.String(),
        text: Type.String(),
        isBot: Type.Boolean(),
      })
    ),
  }),
  Type.Object({
    action: Type.Literal('read_feed'),
    kind: Type.Literal('virtual'),
    feed: Type.Record(Type.String(), Type.Unknown()),
    rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    columns: Type.Array(
      Type.Object({ name: Type.String(), type: Type.String() })
    ),
    total: Type.Optional(Type.Integer()),
  }),
  Type.Object({
    action: Type.Literal('create_feed'),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal('update_feed'),
    feed: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal('delete_feed'),
    deleted: Type.Literal(true),
    feed_id: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal('trigger_feed'),
    triggered: Type.Literal(true),
    run_id: Type.Integer(),
    feed_id: Type.Integer(),
  }),
  Type.Object({
    action: Type.Literal('trigger_feed'),
    message: Type.String(),
  }),
]);
type ManageFeedsResult = Static<typeof ManageFeedsResultSchema>;

// ============================================
// Main Function (Action Router)
// ============================================

const manageFeedsTool = defineActionTool('manage_feeds', {
  list_feeds: action(ListFeedsAction, handleListFeeds),
  read_feed: action(ReadFeedAction, handleReadFeed),
  create_feed: action(CreateFeedAction, handleCreateFeed),
  update_feed: action(UpdateFeedAction, handleUpdateFeed),
  delete_feed: action(DeleteFeedAction, handleDeleteFeed),
  trigger_feed: action(TriggerFeedAction, handleTriggerFeed),
});

export const ManageFeedsSchema = manageFeedsTool.schema;
export const manageFeeds = manageFeedsTool.run;

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
  let pageQuery = sql`
    SELECT f.*
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (args.connection_id) {
    pageQuery = sql`${pageQuery} AND f.connection_id = ${args.connection_id}`;
  }
  if (args.entity_id) {
    pageQuery = sql`${pageQuery} AND ${args.entity_id} = ANY(f.entity_ids)`;
  }
  if (args.status) {
    pageQuery = sql`${pageQuery} AND f.status = ${args.status}`;
  }
  if (args.feed_ids?.length) {
    pageQuery = sql`${pageQuery} AND f.id = ANY(${pgBigintArray(args.feed_ids)}::bigint[])`;
  }

  pageQuery = sql`${pageQuery} ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

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
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes') AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes')
             THEN 'offline'
           END AS device_status,
           cd.name AS connector_name,
           ap.profile_kind AS auth_profile_kind,
           ap.status AS auth_profile_status,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.id = ANY(p.entity_ids)
           ) AS entity_names,
           (SELECT COUNT(*) FROM runs r WHERE r.feed_id = p.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[]))::int AS active_runs,
           -- Agent this feed's channel is bound to (streaming feeds only), so the
           -- Behaviors Listen picker can hide channels already owned by another
           -- agent instead of silently reassigning them on bind.
           (SELECT b.agent_id FROM agent_channel_bindings b
             WHERE b.organization_id = p.organization_id
               AND b.connection_id = p.connection_id
               AND b.channel_id = p.feed_key
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

  const rows = await query;
  return { action: 'list_feeds', feeds: rows, total: rows.length, limit, offset };
}

async function handleReadFeed(
  args: Static<typeof ReadFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;
  // Connection-visibility gate (mirrors manage_connections crud handleList/Get):
  // read_feed is in PUBLIC_READ_ACTIONS, so a feed's config/transcript is content
  // an anonymous caller could otherwise pull by guessing a feed_id. Anonymous
  // sees org-visible connections only; a non-admin member sees org + their own
  // private connections; owners/admins see all.
  let visibilityFilter = sql``;
  if (!userId) {
    visibilityFilter = sql`AND c.visibility = 'org'`;
  } else {
    const role = await getWorkspaceRole(sql, organizationId, userId);
    if (role !== 'owner' && role !== 'admin') {
      visibilityFilter = sql`AND (c.visibility = 'org' OR c.created_by = ${userId})`;
    }
  }

  const rows = (await sql`
    SELECT f.*,
           c.slug,
           c.connector_key,
           c.external_tenant_id,
           c.display_name AS connection_name,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.id = ANY(f.entity_ids)
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
  const feed = rows[0];

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
    return { action: 'read_feed', kind: 'streaming', feed, messages };
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
    });
    return { action: 'read_feed', kind: 'virtual', feed, ...live };
  }

  const runs = await sql`
    SELECT id, status, items_collected, error_message, created_at, completed_at, checkpoint, connector_version
    FROM runs
    WHERE feed_id = ${args.feed_id} AND run_type = 'sync'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return { action: 'read_feed', kind: String(feed.kind), feed, recent_runs: runs };
}

async function handleCreateFeed(
  args: Static<typeof CreateFeedAction>,
  ctx: ToolContext,
  env: Env
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const connRows = await sql`
    SELECT c.id, c.connector_key, c.status, c.auth_profile_id, c.config, cd.feeds_schema
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT feeds_schema
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
  // schedule. It MUST carry config.query (the pushdown predicate readVirtualFeed
  // reads) — without it the live read would always throw at request time.
  const isVirtual = args.virtual === true;
  // Only validate the sync schedule for non-virtual feeds — a virtual feed
  // persists schedule = NULL, so a (possibly defaulted) schedule string must not
  // gate its creation.
  const schedule = isVirtual ? null : (args.schedule ?? getDefaultSchedule(env));
  if (!isVirtual) {
    const scheduleError = validateSchedule(schedule as string);
    if (scheduleError) {
      return { error: scheduleError };
    }
  }
  if (isVirtual) {
    const configQuery = args.config?.query;
    if (typeof configQuery !== 'string' || !configQuery.trim()) {
      return {
        error:
          'A virtual feed requires config.query (a connector-specific read predicate, e.g. a Gmail search string).',
      };
    }
  }
  // Don't schedule a first run for a feed whose connection is still pending auth,
  // or for a virtual feed (never synced — schedule is NULL).
  const nextRunAtVal =
    schedule && feedInitialStatus === 'active' ? nextRunAt(schedule) : null;
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
    config: args.config ?? null,
    entityIds: args.entity_ids ?? null,
    feedsSchema,
  });

  const inserted = await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, display_name, status,
      entity_ids, config, schedule, next_run_at, kind, virtual
    ) VALUES (
      ${organizationId}, ${args.connection_id}, ${args.feed_key}, ${displayName}, ${feedInitialStatus},
      ${entityIdsValue}::bigint[],
      ${args.config ? sql.json(args.config) : null},
      ${schedule}, ${nextRunAtVal},
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

  return { action: 'create_feed', feed: inserted[0] };
}

async function handleUpdateFeed(
  args: Static<typeof UpdateFeedAction>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const existing = await sql`
    SELECT f.id, c.auth_profile_id
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId}
  `;
  if (existing.length === 0) {
    return { error: 'Feed not found' };
  }

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

  if (args.schedule) {
    const scheduleError = validateSchedule(args.schedule);
    if (scheduleError) {
      return { error: scheduleError };
    }
  }

  // `repair_agent_id` is tri-state: undefined = leave alone, null = clear, string = set.
  // Use Object.hasOwn so an explicit null overwrites instead of being skipped.
  const hasRepairAgentArg = Object.hasOwn(args, 'repair_agent_id');
  const repairAgentValue = hasRepairAgentArg ? (args.repair_agent_id ?? null) : null;

  // Declarative `lobu apply` passes `replace_config: true` so removed manifest
  // keys disappear remotely; default (merge) is preserved for the web UI.
  const replaceFeedConfig = args.replace_config === true && args.config !== undefined;

  const updated = await sql`
    UPDATE feeds
    SET display_name = COALESCE(${args.display_name ?? null}::text, display_name),
        status = COALESCE(${args.status ?? null}::text, status),
        entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
        config = ${
          replaceFeedConfig
            ? sql`${sql.json(args.config ?? {})}::jsonb`
            : sql`CASE WHEN ${args.config ? sql.json(args.config) : null}::jsonb IS NOT NULL THEN COALESCE(config, '{}'::jsonb) || ${args.config ? sql.json(args.config) : null}::jsonb ELSE config END`
        },
        schedule = COALESCE(${args.schedule ?? null}::text, schedule),
        next_run_at = CASE WHEN ${args.schedule ?? null}::text IS NOT NULL THEN ${args.schedule ? nextRunAt(args.schedule) : null}::timestamptz ELSE next_run_at END,
        repair_agent_id = CASE WHEN ${hasRepairAgentArg} THEN ${repairAgentValue}::text ELSE repair_agent_id END,
        updated_at = NOW()
    WHERE id = ${args.feed_id} AND organization_id = ${organizationId}
    RETURNING *
  `;

  const authProfileId =
    Number((existing[0] as { auth_profile_id: unknown }).auth_profile_id) || null;
  if (authProfileId) {
    const authProfile = await getAuthProfileById(organizationId, authProfileId);
    if (authProfile?.profile_kind === 'oauth_account') {
      await syncOAuthConnectionsForAuthProfile(organizationId, authProfile.id);
    }
  }

  return { action: 'update_feed', feed: updated[0] };
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
    title: `Feed deleted: ${feed.feed_key}`,
    content: `Feed "${feed.feed_key}" (id: ${args.feed_id}) was deleted.`,
    metadata: {
      action: 'feed_deleted',
      feed_id: args.feed_id,
      feed_key: feed.feed_key,
      connection_id: feed.connection_id,
    },
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

  const runId = await createSyncRun(args.feed_id, env);
  if (runId === null) {
    return { action: 'trigger_feed', message: 'Sync already pending or running for this feed' };
  }

  return { action: 'trigger_feed', triggered: true, run_id: runId, feed_id: args.feed_id };
}
