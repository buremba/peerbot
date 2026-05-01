/**
 * Tool: manage_feeds
 *
 * Manage data sync feeds for connections.
 *
 * Actions:
 * - list_feeds: List feeds with optional filters
 * - get_feed: Get a specific feed by ID
 * - create_feed: Create a new feed for a connection
 * - update_feed: Update feed settings
 * - delete_feed: Delete a feed
 * - trigger_feed: Trigger an immediate sync for a feed
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb, pgBigintArray } from '../../db/client';
import type { Env } from '../../index';
import { getAuthProfileById } from '../../utils/auth-profiles';
import { nextRunAt, validateSchedule } from '../../utils/cron';
import { recordChangeEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../../utils/oauth-connection-state';
import { createSyncRun } from '../../utils/queue-helpers';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../utils/run-statuses';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import { getDefaultSchedule } from './helpers/connection-helpers';
import { resolveFeedDisplayName } from './helpers/feed-helpers';
import { PaginationFields } from './schemas/common-fields';

// ============================================
// Schema
// ============================================

const ListFeedsAction = Type.Object({
  action: Type.Literal('list_feeds'),
  connection_id: Type.Optional(Type.Number({ description: 'Filter by connection ID' })),
  entity_id: Type.Optional(Type.Number({ description: 'Filter by linked entity ID' })),
  status: Type.Optional(Type.String({ description: 'Filter by status: active, paused, error' })),
  ...PaginationFields,
});

const GetFeedAction = Type.Object({
  action: Type.Literal('get_feed'),
  feed_id: Type.Number({ description: 'Feed ID' }),
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
});

const UpdateFeedAction = Type.Object({
  action: Type.Literal('update_feed'),
  feed_id: Type.Number({ description: 'Feed ID' }),
  status: Type.Optional(Type.String({ description: 'active, paused, error' })),
  display_name: Type.Optional(Type.String()),
  entity_ids: Type.Optional(Type.Array(Type.Number())),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
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

export const ManageFeedsSchema = Type.Union([
  ListFeedsAction,
  GetFeedAction,
  CreateFeedAction,
  UpdateFeedAction,
  DeleteFeedAction,
  TriggerFeedAction,
]);

// ============================================
// Result Types
// ============================================

type ManageFeedsResult =
  | { error: string }
  | { action: 'list_feeds'; feeds: any[]; total: number; limit: number; offset: number }
  | { action: 'get_feed'; feed: any; recent_runs: any[] }
  | { action: 'create_feed'; feed: any }
  | { action: 'update_feed'; feed: any }
  | { action: 'delete_feed'; deleted: true; feed_id: number }
  | { action: 'trigger_feed'; triggered: true; run_id: number; feed_id: number }
  | { action: 'trigger_feed'; message: string };

type FeedsArgs = Static<typeof ManageFeedsSchema>;

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageFeeds(
  args: FeedsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  return routeAction<ManageFeedsResult>('manage_feeds', args.action, ctx, {
    list_feeds: () => handleListFeeds(args as Extract<FeedsArgs, { action: 'list_feeds' }>, ctx),
    get_feed: () => handleGetFeed(args as Extract<FeedsArgs, { action: 'get_feed' }>, ctx),
    create_feed: () =>
      handleCreateFeed(args as Extract<FeedsArgs, { action: 'create_feed' }>, env, ctx),
    update_feed: () => handleUpdateFeed(args as Extract<FeedsArgs, { action: 'update_feed' }>, ctx),
    delete_feed: () => handleDeleteFeed(args as Extract<FeedsArgs, { action: 'delete_feed' }>, ctx),
    trigger_feed: () =>
      handleTriggerFeed(args as Extract<FeedsArgs, { action: 'trigger_feed' }>, env, ctx),
  });
}

// ============================================
// Action Handlers
// ============================================

async function handleListFeeds(
  args: Extract<FeedsArgs, { action: 'list_feeds' }>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  let query = sql`
    SELECT f.*, c.connector_key, c.display_name AS connection_name,
           c.status AS connection_status,
           cd.name AS connector_name,
           ap.profile_kind AS auth_profile_kind,
           ap.status AS auth_profile_status,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.id = ANY(f.entity_ids)
           ) AS entity_names,
           (SELECT COUNT(*) FROM runs r WHERE r.feed_id = f.id AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[]))::int AS active_runs,
           (SELECT COUNT(*) FROM current_event_records e WHERE e.connection_id = f.connection_id AND e.feed_key = f.feed_key)::int AS event_count
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
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (args.connection_id) {
    query = sql`${query} AND f.connection_id = ${args.connection_id}`;
  }
  if (args.entity_id) {
    query = sql`${query} AND ${args.entity_id} = ANY(f.entity_ids)`;
  }
  if (args.status) {
    query = sql`${query} AND f.status = ${args.status}`;
  }

  query = sql`${query} ORDER BY f.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const rows = await query;
  return { action: 'list_feeds', feeds: rows, total: rows.length, limit, offset };
}

async function handleGetFeed(
  args: Extract<FeedsArgs, { action: 'get_feed' }>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = await sql`
    SELECT f.*,
           c.connector_key,
           c.display_name AS connection_name,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.id = ANY(f.entity_ids)
           ) AS entity_names
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (rows.length === 0) {
    return { error: 'Feed not found' };
  }

  const runs = await sql`
    SELECT id, status, items_collected, error_message, created_at, completed_at, checkpoint, connector_version
    FROM runs
    WHERE feed_id = ${args.feed_id} AND run_type = 'sync'
    ORDER BY created_at DESC
    LIMIT 10
  `;

  return { action: 'get_feed', feed: rows[0], recent_runs: runs };
}

async function handleCreateFeed(
  args: Extract<FeedsArgs, { action: 'create_feed' }>,
  env: Env,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const connRows = await sql`
    SELECT c.id, c.connector_key, c.status, c.auth_profile_id, cd.feeds_schema
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
  if (conn.status !== 'active') {
    return { error: `Connection is ${conn.status}, must be active to create feeds` };
  }

  const feedsSchema = conn.feeds_schema as Record<string, any> | null;
  if (feedsSchema && !feedsSchema[args.feed_key]) {
    return {
      error: `Invalid feed_key '${args.feed_key}'. Available: ${Object.keys(feedsSchema).join(', ')}`,
    };
  }

  const schedule = args.schedule ?? getDefaultSchedule(env);
  const scheduleError = validateSchedule(schedule);
  if (scheduleError) {
    return { error: scheduleError };
  }
  const nextRunAtVal = nextRunAt(schedule);
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
      entity_ids, config, schedule, next_run_at
    ) VALUES (
      ${organizationId}, ${args.connection_id}, ${args.feed_key}, ${displayName}, 'active',
      ${entityIdsValue}::bigint[],
      ${args.config ? sql.json(args.config) : null},
      ${schedule}, ${nextRunAtVal}
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
  args: Extract<FeedsArgs, { action: 'update_feed' }>,
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

  const updated = await sql`
    UPDATE feeds
    SET display_name = COALESCE(${args.display_name ?? null}::text, display_name),
        status = COALESCE(${args.status ?? null}::text, status),
        entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
        config = CASE WHEN ${args.config ? sql.json(args.config) : null}::jsonb IS NOT NULL THEN COALESCE(config, '{}'::jsonb) || ${args.config ? sql.json(args.config) : null}::jsonb ELSE config END,
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
  args: Extract<FeedsArgs, { action: 'delete_feed' }>,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  await sql`
    UPDATE runs SET status = 'cancelled', completed_at = NOW()
    WHERE feed_id = ${args.feed_id} AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  const deleted = await sql`
    UPDATE feeds
    SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
    WHERE id = ${args.feed_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id, feed_key, connection_id, entity_ids
  `;

  if (deleted.length === 0) {
    return { error: 'Feed not found or already deleted' };
  }

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
  args: Extract<FeedsArgs, { action: 'trigger_feed' }>,
  env: Env,
  ctx: ToolContext
): Promise<ManageFeedsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const feedRows = await sql`
    SELECT f.id, f.status, f.connection_id, c.connector_key
    FROM feeds f
    JOIN connections c ON c.id = f.connection_id
    WHERE f.id = ${args.feed_id} AND f.organization_id = ${organizationId} AND c.deleted_at IS NULL AND f.deleted_at IS NULL
  `;

  if (feedRows.length === 0) {
    return { error: 'Feed not found' };
  }

  const feed = feedRows[0] as any;
  if (feed.status !== 'active') {
    return { error: `Feed is ${feed.status}, must be active to trigger sync` };
  }

  const runId = await createSyncRun(args.feed_id, env);
  if (runId === null) {
    return { action: 'trigger_feed', message: 'Sync already pending or running for this feed' };
  }

  return { action: 'trigger_feed', triggered: true, run_id: runId, feed_id: args.feed_id };
}
