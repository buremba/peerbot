/**
 * CRUD action handlers: list, get, create, update, delete.
 */

import { getErrorMessage, parseJsonObject } from '@lobu/core';
import { getDb, parsePgNumberArray, pgBigintArray } from '../../../../db/client';
import {
  EMPTY_SUMMARY,
  getOperationsSummary,
  getOperationsSummaryBatch,
} from '../../../../operations/connector-operations';
import {
  createAuthProfile,
  getAuthProfileById,
  getAuthProfileBySlug,
  getBrowserSessionReadiness,
} from '../../../../utils/auth-profiles';
import {
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  connectionSlugTaken,
  insertConnectionWithSlug,
  isConnectionSlugUniqueViolation,
  resolveNewConnectionSlug,
} from '../../../../utils/connections';
import { applyEntityLinkOverrides } from '../../../../utils/entity-link-validation';
import { recordChangeEvent, recordLifecycleEvent } from '../../../../utils/insert-event';
import logger from '../../../../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../../../../utils/oauth-connection-state';
import { getWorkspaceRole } from '../../../../utils/organization-access';
import { resolveUsernames } from '../../../../utils/resolve-usernames';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../../../utils/run-statuses';
import {
  buildViewUrl,
  ensureEnvBackedOAuthAppProfile,
  enrichWithAuthProfiles,
  getInteractiveMethods,
  isPersonalCredentialKind,
  isPersonalCredVisibilityViolation,
  mapConnectionStatusToFeedStatus,
  PERSONAL_CRED_ORG_VISIBILITY_ERROR,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
} from '../../helpers/connection-helpers';
import { assertEntityIdsInOrg, callerIsAdmin as resolveCallerIsAdmin } from '../../helpers/db-helpers';
import { rejectUnboundAppInstallationCreate } from '../../helpers/app-installation-guard';
import { type FeedDefinition, splitConfigByFeedScope } from '../../helpers/feed-helpers';
import { getScopedConnectorDefinition } from '../../../../catalog/connector-definitions';
import type { ToolContext } from '../../../registry';
import type { ManageConnectionsResult, ConnectionsArgs } from '../schemas';
import { resolveDeviceBinding, isManagedPublicOrgConnect } from './device-binding';
import { assertConnectorAllowedInCloud } from '../../../../utils/connector-cloud-gate';
import { ensureConnectorInstalled } from '../../../../utils/ensure-connector-installed';
import { unregisterConnectorWebhook } from '../../../../connect/webhook-registration';
import { enrichConnectorGroupsWithCatalogDisplay } from '../../../../catalog/connector-group-display';
import { deriveConnectionFacets, deriveEffectiveCredentialMode } from './facets';

// ============================================
// handleListConnectorGroups
// ============================================

function mapConnectorGroupSummaries(raw: unknown): Array<{
  id: number;
  display_name: string | null;
  feed_count: number;
}> {
  if (!Array.isArray(raw)) return [];
  const summaries: Array<{
    id: number;
    display_name: string | null;
    feed_count: number;
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = Number(record.id);
    const displayName =
      typeof record.display_name === 'string' && record.display_name.trim()
        ? record.display_name.trim()
        : null;
    const feedCount = Number(record.feed_count) || 0;
    if (!Number.isFinite(id)) continue;
    summaries.push({ id, display_name: displayName, feed_count: feedCount });
  }
  return summaries;
}

export async function handleListConnectorGroups(
  args: Extract<ConnectionsArgs, { action: 'list_connector_groups' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  let query = sql`
    SELECT c.connector_key,
           MAX(cd.name) AS connector_name,
           MAX(cd.favicon_domain) AS favicon_domain,
           COUNT(*)::int AS connection_count,
           bool_or(c.credential_mode IS NOT NULL) AS has_chat_connection,
           bool_or(fc.feed_count > 0) AS has_active_feeds,
           -- DATA-facet input: only non-streaming feeds count, so a chat-only
           -- group whose channels became streaming feeds isn't mislabeled data.
           bool_or(fc.data_feed_count > 0) AS has_active_data_feeds,
           bool_or(cd.has_feeds_schema) AS connector_has_feeds,
           COALESCE(
             json_agg(
               json_build_object(
                 'id', c.id,
                 'display_name', NULLIF(TRIM(c.display_name), ''),
                 'feed_count', fc.feed_count
               )
               ORDER BY COALESCE(NULLIF(TRIM(c.display_name), ''), cd.name, c.connector_key), c.id
             ),
             '[]'::json
           ) AS connections
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name, favicon_domain,
             (feeds_schema IS NOT NULL
              AND feeds_schema::text <> '{}'
              AND feeds_schema::text <> 'null') AS has_feeds_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS feed_count,
             COUNT(*) FILTER (WHERE f.kind <> 'streaming')::int AS data_feed_count
      FROM feeds f
      WHERE f.connection_id = c.id
        AND f.deleted_at IS NULL
    ) fc ON TRUE
    WHERE c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;

  if (args.entity_id) {
    query = sql`${query} AND (
      ${args.entity_id} = ANY(c.entity_ids)
      OR EXISTS (
        SELECT 1
        FROM feeds f
        WHERE f.connection_id = c.id
          AND f.deleted_at IS NULL
          AND ${args.entity_id} = ANY(f.entity_ids)
      )
    )`;
  }

  if (!ctx.userId) {
    query = sql`${query} AND c.visibility = 'org'`;
  } else {
    const userRole = await getWorkspaceRole(sql, organizationId, ctx.userId);
    if (userRole !== 'owner' && userRole !== 'admin') {
      query = sql`${query} AND (c.visibility = 'org' OR c.created_by = ${ctx.userId})`;
    }
  }

  query = sql`${query} GROUP BY c.connector_key ORDER BY MAX(cd.name), c.connector_key`;

  const rows = await query;
  const connectorKeys = [...new Set(rows.map((r) => String(r.connector_key)))];
  const opsSummaries = await getOperationsSummaryBatch(organizationId, connectorKeys);

  const groups = rows.map((row) => {
    const connectorKey = String(row.connector_key);
    const feedCount = row.has_active_data_feeds === true ? 1 : 0;
    return {
      connector_key: connectorKey,
      connector_name:
        row.connector_name != null ? String(row.connector_name) : null,
      favicon_domain:
        row.favicon_domain != null ? String(row.favicon_domain) : null,
      connection_count: Number(row.connection_count) || 0,
      connections: mapConnectorGroupSummaries(row.connections),
      facets: deriveConnectionFacets({
        connectorKey,
        isChat: row.has_chat_connection === true,
        feedCount,
        connectorHasFeeds: row.connector_has_feeds === true,
        hasOperations: (opsSummaries.get(connectorKey)?.total ?? 0) > 0,
      }),
    };
  });

  return {
    action: 'list_connector_groups',
    groups: await enrichConnectorGroupsWithCatalogDisplay(groups),
  };
}

// ============================================
// handleList
// ============================================

export async function handleList(
  args: Extract<ConnectionsArgs, { action: 'list' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  let query = sql`
    SELECT c.*,
           cd.name AS connector_name,
           cd.has_feeds_schema,
           ap.slug AS auth_profile_slug,
           ap.display_name AS auth_profile_name,
           ap.status AS auth_profile_status,
           ap.profile_kind AS auth_profile_kind,
           app.slug AS app_auth_profile_slug,
           app.display_name AS app_auth_profile_name,
           app.status AS app_auth_profile_status,
           app.profile_kind AS app_auth_profile_kind,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.worker_id AS device_worker_handle,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes') AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes')
             THEN 'offline'
           END AS device_status,
           -- event_count intentionally omitted from list responses: the
           -- per-row correlated count via current_event_records does a
           -- supersedes anti-join over the events table and was the dominant
           -- cost in this query (1303ms mean → 2.3ms without it; see the
           -- post-incident perf brainstorm). For the per-connection detail
           -- page, handleGet below still computes it — that path is a single
           -- row and costs ~1.2ms.
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL)::int AS feed_count,
           -- The DATA facet must not light up just because a chat connection's
           -- channels are now streaming feeds: count only non-streaming feeds
           -- (collected/virtual) for facet.data. feed_count stays the TOTAL
           -- (drives the feeds rail, which lists channels too).
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL AND f.kind <> 'streaming')::int AS data_feed_count,
           (SELECT ct.token FROM connect_tokens ct
            WHERE ct.connection_id = c.id AND ct.status = 'pending' AND ct.expires_at > NOW()
            ORDER BY ct.created_at DESC LIMIT 1) AS connect_token,
           -- entity_names = UNION of the connection's own entity_ids and any of
           -- its feeds' entity_ids (a connection counts under an entity if
           -- either it is directly tagged OR one of its feeds is).
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM entities ent
             WHERE ent.id = ANY(c.entity_ids)
                OR ent.id IN (
                  SELECT unnest(f.entity_ids)
                  FROM feeds f
                  WHERE f.connection_id = c.id AND f.deleted_at IS NULL
                )
           ) AS entity_names
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name,
             (feeds_schema IS NOT NULL
              AND feeds_schema::text <> '{}'
              AND feeds_schema::text <> 'null') AS has_feeds_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN auth_profiles app ON app.id = c.app_auth_profile_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    WHERE c.organization_id = ${organizationId} AND c.deleted_at IS NULL
  `;

  if (args.connector_key) {
    query = sql`${query} AND c.connector_key = ${args.connector_key}`;
  }
  if (args.status) {
    query = sql`${query} AND c.status = ${args.status}`;
  }
  if (args.entity_id) {
    query = sql`${query} AND (
      ${args.entity_id} = ANY(c.entity_ids)
      OR EXISTS (
        SELECT 1
        FROM feeds f
        WHERE f.connection_id = c.id
          AND f.deleted_at IS NULL
          AND ${args.entity_id} = ANY(f.entity_ids)
      )
    )`;
  }
  if (args.created_by) {
    query = sql`${query} AND c.created_by = ${args.created_by}`;
  }
  if (args.connection_ids?.length) {
    query = sql`${query} AND c.id = ANY(${pgBigintArray(args.connection_ids)}::bigint[])`;
  }

  // Visibility: anonymous readers see org-visible connections only; non-admin
  // users see org connections plus their own private connections.
  if (!ctx.userId) {
    query = sql`${query} AND c.visibility = 'org'`;
  } else {
    const userRole = await getWorkspaceRole(sql, organizationId, ctx.userId);
    if (userRole !== 'owner' && userRole !== 'admin') {
      query = sql`${query} AND (c.visibility = 'org' OR c.created_by = ${ctx.userId})`;
    }
  }

  query = sql`${query} ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`;

  const rows = await query;
  const resolved = await resolveUsernames(
    rows as unknown as Record<string, unknown>[],
    'created_by'
  );

  const connectorKeys = [...new Set(resolved.map((r) => String(r.connector_key)))];
  const summaries = await getOperationsSummaryBatch(organizationId, connectorKeys);

  const connections = resolved.map((row) => {
    const operationsSummary = summaries.get(String(row.connector_key)) ?? { ...EMPTY_SUMMARY };
    const hasOperations = operationsSummary.total > 0;
    return {
      ...row,
      // Postgres returns bigint[] as a literal string ('{2}'); parse to number[]
      // so the API contract matches the typed entity_ids the UI picker expects.
      entity_ids: parsePgNumberArray(row.entity_ids),
      operations_summary: operationsSummary,
      has_operations: hasOperations,
      facets: deriveConnectionFacets({
        connectorKey: String(row.connector_key),
        isChat: row.credential_mode != null,
        feedCount: Number(row.data_feed_count) || 0,
        connectorHasFeeds: row.has_feeds_schema === true,
        hasOperations,
      }),
      effective_credential_mode: deriveEffectiveCredentialMode({
        credentialMode: row.credential_mode as string | null,
        appAuthProfileId: row.app_auth_profile_id,
        authProfileId: row.auth_profile_id,
      }),
    };
  });

  return {
    action: 'list',
    connections,
    total: connections.length,
    limit,
    offset,
    view_url: await buildViewUrl(ctx),
  };
}

// ============================================
// handleGet
// ============================================

export async function handleGet(
  args: Extract<ConnectionsArgs, { action: 'get' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  let query = sql`
    SELECT c.*,
           cd.name AS connector_name,
           cd.feeds_schema,
           cd.auth_schema,
           ap.slug AS auth_profile_slug,
           ap.display_name AS auth_profile_name,
           ap.status AS auth_profile_status,
           ap.profile_kind AS auth_profile_kind,
           app.slug AS app_auth_profile_slug,
           app.display_name AS app_auth_profile_name,
           app.status AS app_auth_profile_status,
           app.profile_kind AS app_auth_profile_kind,
           dw.label AS device_label,
           dw.platform AS device_platform,
           dw.worker_id AS device_worker_handle,
           dw.last_seen_at AS device_last_seen_at,
           (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes') AS device_online,
           CASE
             WHEN c.device_worker_id IS NOT NULL
              AND NOT (dw.id IS NOT NULL AND dw.last_seen_at > now() - interval '20 minutes')
             THEN 'offline'
           END AS device_status,
           (SELECT COUNT(*) FROM current_event_records e WHERE e.connection_id = c.id)::int AS event_count,
           -- feed_count = TOTAL live feeds (drives the feeds rail, channels
           -- included). data_feed_count excludes streaming channels so the DATA
           -- facet stays off for a pure-chat connection (mirrors list).
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL)::int AS feed_count,
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL AND f.kind <> 'streaming')::int AS data_feed_count
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT name, feeds_schema, auth_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    LEFT JOIN auth_profiles app ON app.id = c.app_auth_profile_id
    LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;

  if (!ctx.userId) {
    query = sql`${query} AND c.visibility = 'org'`;
  } else {
    const userRole = await getWorkspaceRole(sql, organizationId, ctx.userId);
    if (userRole !== 'owner' && userRole !== 'admin') {
      query = sql`${query} AND (c.visibility = 'org' OR c.created_by = ${ctx.userId})`;
    }
  }

  const rows = await query;
  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const [resolved] = await resolveUsernames([rows[0] as Record<string, unknown>], 'created_by');

  const connection = rows[0] as { status: string; connector_key: string };
  const viewUrl = await buildViewUrl(ctx, connection.connector_key);

  // For pending_auth connections, include the connect token so the UI can initiate OAuth
  let connectToken: string | undefined;
  if (connection.status === 'pending_auth') {
    const tokenRows = await sql`
      SELECT token
      FROM connect_tokens
      WHERE connection_id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (tokenRows.length > 0) {
      connectToken = (tokenRows[0] as { token: string }).token;
    }
  }

  const operationsSummary = await getOperationsSummary(
    organizationId,
    String((resolved as any).connector_key)
  );

  const getRow = resolved as Record<string, unknown>;
  const feedsSchema = getRow.feeds_schema;
  const connectorHasFeeds =
    feedsSchema != null &&
    JSON.stringify(feedsSchema) !== '{}' &&
    JSON.stringify(feedsSchema) !== 'null';
  const hasOperations = operationsSummary.total > 0;

  return {
    action: 'get',
    connection: {
      ...resolved,
      ...(connectToken ? { connect_token: connectToken } : {}),
      operations_summary: operationsSummary,
      has_operations: hasOperations,
      facets: deriveConnectionFacets({
        connectorKey: String(getRow.connector_key),
        isChat: getRow.credential_mode != null,
        feedCount: Number(getRow.data_feed_count) || 0,
        connectorHasFeeds,
        hasOperations,
      }),
      effective_credential_mode: deriveEffectiveCredentialMode({
        credentialMode: getRow.credential_mode as string | null,
        appAuthProfileId: getRow.app_auth_profile_id,
        authProfileId: getRow.auth_profile_id,
      }),
    },
    view_url: viewUrl,
  };
}

// ============================================
// handleCreate
// ============================================

export async function handleCreate(
  args: Extract<ConnectionsArgs, { action: 'create' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;

  // Cloud gate: a raw-DB connector (postgres) has no tenant-URL egress hardening
  // yet, so it can't be installed under LOBU_CLOUD_MODE. (The catalog also hides
  // it; this blocks a direct API call.) No-op when not in cloud mode.
  try {
    assertConnectorAllowedInCloud(args.connector_key);
  } catch (err) {
    return { error: getErrorMessage(err) };
  }

  // Resolve caller role once — we use it for created_by overrides, explicit
  // app_auth_profile picks, and member-friendly error messages downstream.
  const callerIsAdmin = await resolveCallerIsAdmin(sql, { organizationId, userId });

  // Resolve effective owner — admins can create connections on behalf of other users
  let effectiveCreatedBy = userId;
  if (args.created_by && args.created_by !== userId) {
    if (!callerIsAdmin) {
      return { error: 'Only admins can create connections for other users.' };
    }
    effectiveCreatedBy = args.created_by;
  }

  // `entity_link_overrides` writes to `connector_definitions` for the entire
  // org. Even though `create` is now member-write, that mutation must stay
  // admin-only — otherwise a member could change connector-level entity
  // mapping while ostensibly installing their own connection.
  if (!callerIsAdmin && args.entity_link_overrides !== undefined) {
    return {
      error:
        'Only admins can change connector entity-link overrides. Omit `entity_link_overrides`, or ask an admin to update them via `set_connector_entity_link_overrides`.',
    };
  }

  // Non-admins must accept the org-default app profile — they can't pick or
  // bring an alternate OAuth client. If they explicitly pass a slug, it has
  // to match the admin-pinned default for the connector.
  if (!callerIsAdmin && args.app_auth_profile_slug) {
    const picked = await getAuthProfileBySlug(organizationId, args.app_auth_profile_slug);
    if (!picked || picked.profile_kind !== 'oauth_app') {
      return { error: `App auth profile '${args.app_auth_profile_slug}' not found` };
    }
    const pinnedAsDefault =
      picked.is_default_for_connector && picked.connector_key === args.connector_key;
    if (!pinnedAsDefault) {
      return {
        error: `Only admins can override the OAuth app profile. Ask an admin to pin '${args.app_auth_profile_slug}' as the default for this connector, or omit app_auth_profile_slug to use the org default.`,
      };
    }
  }

  // Ensure connector is installed from bundled catalog if needed
  await ensureConnectorInstalled({ organizationId, connectorKey: args.connector_key });

  // Verify connector exists
  const connector = await getScopedConnectorDefinition({
    organizationId,
    connectorKey: args.connector_key,
  });

  if (!connector) {
    return { error: `Connector '${args.connector_key}' not found or not active` };
  }

  // Reject a direct create of an UNBOUND app_installation connection (no
  // installation_ref AND no other auth intent) — those are created only by the
  // App install callback. Selection-aware: a create that supplies an auth profile
  // / app profile / env creds / managedBy resolves to a different method and is
  // allowed through.
  const appInstallGuard = await rejectUnboundAppInstallationCreate({
    organizationId,
    authSchema: connector.auth_schema,
    config: args.config,
    connectorKey: args.connector_key,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
  });
  if (appInstallGuard) return appInstallGuard;

  const deviceBinding = await resolveDeviceBinding({
    organizationId,
    userId,
    connector,
    deviceWorkerId: args.device_worker_id,
  });
  if ('error' in deviceBinding) return deviceBinding;
  if (deviceBinding.deviceWorkerId) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${deviceBinding.deviceWorkerId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
      };
    }
  }

  if (args.entity_link_overrides !== undefined) {
    const err = await applyEntityLinkOverrides(
      organizationId,
      args.connector_key,
      args.entity_link_overrides
    );
    if (err) return { error: err };
  }

  // No-auth connectors are limited to one connection per user — except when the
  // connection is pinned to a device worker, where the cardinality is "one per
  // (org, connector, device)" (enforced just above + by the unique index), so a
  // user's second device can back the same connector with its own connection.
  const authMethods =
    (connector.auth_schema as { methods?: Array<{ type: string }> })?.methods ?? [];
  const isNoAuth = authMethods.length > 0 && authMethods.every((m) => m.type === 'none');
  if (isNoAuth && !deviceBinding.deviceWorkerId) {
    const existing = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND created_by = ${effectiveCreatedBy}
        AND device_worker_id IS NULL
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      return {
        error: `This user already has a ${connector.name} connection (id: ${existing[0].id}). No-auth connectors are limited to one connection per user (unless pinned to different devices).`,
      };
    }
  }

  // Detect interactive-auth connectors (e.g. WhatsApp QR). These bypass the
  // standard auth profile selection and instead drive an `authenticate()` run
  // that emits artifacts (qr/code/etc.) for the UI to render.
  const interactiveMethod = getInteractiveMethods(connector.auth_schema)[0] ?? null;

  // A `managedBy` connection's OAuth grant lives in a cloud (public) org — the
  // local instance fetches the token at runtime (execution-context.ts) and never
  // holds a LOCAL auth profile. The trusted `config.managedBy.org` signal (set by
  // `defineConnection({ managedBy })` via `lobu apply`) puts the connection on a
  // dedicated path: local auth-profile selection is skipped ENTIRELY (no binding,
  // requirement, status gating, or oauth sync), and it is created `active` with
  // null local auth profiles. An empty `org` is not a valid managed connection,
  // so it falls through to the normal auth path rather than being created
  // active+unauthenticated.
  const incomingConfig = parseJsonObject(args.config);
  const managedByOrg =
    !!incomingConfig.managedBy &&
    typeof incomingConfig.managedBy === 'object' &&
    !Array.isArray(incomingConfig.managedBy)
      ? (incomingConfig.managedBy as Record<string, unknown>).org
      : undefined;
  const managedByRequested =
    typeof managedByOrg === 'string' && managedByOrg.trim().length > 0;
  // managedBy delegates to a cloud OAuth grant, so it only applies to OAuth
  // connectors. On a non-OAuth connector (env/browser/none) treating it as
  // managed would bypass a real local auth requirement, so reject it instead of
  // creating an unauthenticated connection.
  if (managedByRequested && !authMethods.some((m) => m.type === 'oauth')) {
    return {
      error:
        'managedBy is only valid for OAuth connectors (the managed grant is an OAuth token fetched from the cloud); this connector has no OAuth auth method.',
    };
  }
  const isManagedByConnection = managedByRequested;

  // Leave `authSelection` null for managed (and interactive) connections so the
  // entire auth-profile validation + binding chain below is uniformly bypassed —
  // a managed connection is created with null `auth_profile_id` /
  // `app_auth_profile_id` regardless of any local profile that happens to exist.
  const authSelection =
    interactiveMethod || isManagedByConnection
      ? null
      : await resolveConnectionAuthSelection({
          organizationId,
          connectorKey: args.connector_key,
          authSchema: connector.auth_schema,
          authProfileSlug: args.auth_profile_slug,
          appAuthProfileSlug: args.app_auth_profile_slug,
          deviceWorkerId: deviceBinding.deviceWorkerId,
        });

  if (authSelection) {
    const requiresAuth =
      !!authSelection.oauthMethod || !!authSelection.envMethod || !!authSelection.browserMethod;
    if (requiresAuth && !authSelection.authProfile) {
      return {
        error: authSelection.browserMethod
          ? 'Select or create a browser auth profile before creating the connection.'
          : authSelection.oauthMethod && authSelection.envMethod
            ? 'Select an auth profile for this connector before creating the connection.'
            : authSelection.oauthMethod
              ? 'Select or create an OAuth account profile before creating the connection.'
              : 'Select or create an auth profile before creating the connection.',
      };
    }
  }

  const browserProfileUsable =
    authSelection?.authProfile?.profile_kind === 'browser_session'
      ? (await getBrowserSessionReadiness(authSelection.authProfile.auth_data, args.connector_key))
          .usable
      : false;

  // A `pending_auth` auth profile is OK on create *only* for kinds that can
  // actually become active out of band — `oauth_account` (OAuth callback) and
  // `browser_session` (already handled above). The connection is created
  // `pending_auth` and the callback flips both to `active`. This lets a
  // connection reference a freshly created oauth_account profile in the same
  // `lobu apply`. An `env`/`oauth_app` profile that's not active is an error.
  if (
    authSelection?.authProfile &&
    authSelection.authProfile.profile_kind !== 'browser_session' &&
    authSelection.authProfile.status !== 'active' &&
    !(
      authSelection.authProfile.status === 'pending_auth' &&
      authSelection.authProfile.profile_kind === 'oauth_account'
    )
  ) {
    return {
      error: `Selected auth profile '${authSelection.authProfile.slug}' is ${authSelection.authProfile.status}${
        authSelection.authProfile.profile_kind === 'oauth_account'
          ? ' — must be active or pending_auth'
          : ' — must be active'
      }.`,
    };
  }

  // Non-admin members can only bind a connection to a runtime auth profile
  // they own. `env` profiles are admin-managed org-shared credentials —
  // members must never bind to them. `oauth_account` and `browser_session`
  // profiles are member-creatable but still per-user, so a member can't
  // hijack another member's grant by passing their slug.
  if (authSelection?.authProfile && !callerIsAdmin) {
    const profile = authSelection.authProfile;
    if (profile.profile_kind === 'env') {
      return {
        error:
          'Only admins can use env-credential auth profiles. Ask an admin to install this connection.',
      };
    }
    if (
      (profile.profile_kind === 'oauth_account' || profile.profile_kind === 'browser_session') &&
      profile.created_by !== ctx.userId
    ) {
      return {
        error: `Auth profile '${profile.slug}' belongs to another user. Create your own profile (action: 'create_auth_profile') and use its slug instead.`,
      };
    }
  }

  if (authSelection?.selectedKind === 'oauth_account') {
    // The ACCOUNT token (oauth_account profile) is required and already
    // resolved (it's the precondition of this branch). The APP credentials
    // (client id/secret) may instead come from deployment env vars — the same
    // fallback global login uses — so auto-provision an env-backed `oauth_app`
    // profile when none was hand-created. No-op when the env vars are absent,
    // falling through to the original "create an OAuth app profile" guidance.
    if (!authSelection.appAuthProfile && authSelection.oauthMethod) {
      authSelection.appAuthProfile = await ensureEnvBackedOAuthAppProfile({
        organizationId,
        connectorKey: args.connector_key,
        connectorName: connector.name,
        method: authSelection.oauthMethod,
        createdBy: effectiveCreatedBy,
      });
    }
    if (!authSelection.appAuthProfile) {
      return {
        error: callerIsAdmin
          ? 'Select or create an OAuth app profile before creating the connection.'
          : `No OAuth app credentials configured for this connector. Ask an admin to set up the ${authSelection.oauthMethod?.provider ?? args.connector_key} app in /oauth-apps first.`,
      };
    }
    if (authSelection.appAuthProfile.status !== 'active') {
      return {
        error: `Selected app auth profile '${authSelection.appAuthProfile.slug}' is not active.`,
      };
    }
    // Even when the slug is omitted, non-admins can only fall through to the
    // admin-pinned default for this exact connector. The resolver may
    // otherwise return a recency-picked provider-wide row, which would let a
    // member silently use an OAuth client the admin never blessed.
    if (
      !callerIsAdmin &&
      (!authSelection.appAuthProfile.is_default_for_connector ||
        authSelection.appAuthProfile.connector_key !== args.connector_key)
    ) {
      return {
        error: `No default OAuth app configured for this connector. Ask an admin to pin a ${authSelection.oauthMethod?.provider ?? args.connector_key} app as the default in /oauth-apps.`,
      };
    }
  }

  const displayName = await resolveConnectionDisplayName({
    explicitName: args.display_name,
    connectorName: connector.name,
    username: effectiveCreatedBy
      ? ((
          (await resolveUsernames([{ created_by: effectiveCreatedBy }], 'created_by'))[0] as {
            created_by_username?: string;
          }
        )?.created_by_username ?? null)
      : null,
  });

  const visibility = await resolveConnectionVisibility(
    organizationId,
    effectiveCreatedBy,
    authSelection?.authProfile?.profile_kind
  );
  const connectorFeedsSchema = (connector.feeds_schema ?? null) as Record<
    string,
    FeedDefinition
  > | null;
  const mergedConfig = {
    ...((connector.default_connection_config as Record<string, unknown>) ?? {}),
    ...(args.config ?? {}),
  };
  const splitConfig = splitConfigByFeedScope(
    Object.keys(mergedConfig).length > 0 ? mergedConfig : null,
    connectorFeedsSchema
  );

  if (splitConfig.feedConfig) {
    return {
      error:
        "Feed-scoped config belongs on feeds. Create the connection first, then use manage_feeds(action='create_feed') for sync target settings.",
    };
  }

  // Managed-connector path (mirrors handleConnect): a member creating an OAuth
  // connection for a managed connector in a PUBLIC org gets a CONSENT-ONLY
  // connection — it holds the OAuth grant for cloud-delegated token fetch but
  // has no feeds, so the cloud never syncs a copy (the member's data lives only
  // on their local instance; the manage_feeds guard refuses feeds on a
  // consent_only connection). Without this, `create` (vs `connect`) would mint a
  // non-consent-only grant-holder a member could attach feeds to, breaking the
  // "data stays local" invariant.
  //
  // Deliberately NOT marked for: a `managedBy` connection (its grant lives in
  // the cloud but it SYNCS LOCALLY — consent_only and managedBy are mutually
  // exclusive), a non-OAuth method, or any non-managed / non-public-org create.
  const isManagedCreate =
    !isManagedByConnection && authSelection?.oauthMethod
      ? await isManagedPublicOrgConnect({
          organizationId,
          connectorKey: args.connector_key,
          provider: authSelection.oauthMethod.provider,
        })
      : false;
  const connectionConfigToInsert =
    isManagedCreate || splitConfig.connectionConfig
      ? {
          ...(splitConfig.connectionConfig ?? {}),
          ...(isManagedCreate ? { consent_only: true } : {}),
        }
      : null;

  // Interactive auth: always create a fresh `interactive` auth profile scoped to
  // this connection. Connection starts in pending_auth; feed is paused; an auth
  // run drives the authenticate() lifecycle which writes credentials on success.
  let interactiveAuthProfileId: number | null = null;
  if (interactiveMethod) {
    const profile = await createAuthProfile({
      organizationId,
      connectorKey: args.connector_key,
      displayName: `${displayName} (pairing)`,
      slug: `${args.connector_key}-interactive-${Date.now()}`,
      profileKind: 'interactive',
      authData: {},
      status: 'pending_auth',
      createdBy: effectiveCreatedBy ?? null,
    });
    interactiveAuthProfileId = profile.id;
  }

  // Device-bound browser auth profiles live on a specific Mac. Pin the
  // connection there automatically; reject mismatches.
  let effectiveDeviceWorkerId = deviceBinding.deviceWorkerId;
  const profileDeviceWorkerId = authSelection?.authProfile?.device_worker_id ?? null;
  if (profileDeviceWorkerId) {
    if (!effectiveDeviceWorkerId) {
      effectiveDeviceWorkerId = profileDeviceWorkerId;
    } else if (effectiveDeviceWorkerId !== profileDeviceWorkerId) {
      return {
        error: `Auth profile '${authSelection!.authProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
      };
    }
  }
  // Inheriting the device from the profile means we need to re-check the
  // per-device duplicate-connection guard — the earlier check ran against the
  // user's explicit `deviceWorkerId` (which may have been null). Without this
  // pass we'd skip the guard for device-bound profiles and hit the partial
  // unique index `idx_connections_org_connector_device_live` as a primary
  // exception instead of a clean error.
  if (effectiveDeviceWorkerId && effectiveDeviceWorkerId !== deviceBinding.deviceWorkerId) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${effectiveDeviceWorkerId}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
      };
    }
  }
  // For device-bound profiles, browser cookies live on disk in the profile's
  // user_data_dir. The server's auth_data is empty, so the readiness probe
  // returns unusable — but the connection is fine to mark active, since the
  // Mac app handles auth status independently.
  const isDeviceBoundBrowserSession =
    authSelection?.authProfile?.profile_kind === 'browser_session' && !!profileDeviceWorkerId;

  // Device-bound browser profiles can be `pending_auth` on the profile itself
  // until the user logs in (the Mac app launches the managed Chrome) — but
  // the cookies live on disk on the device, not server-side, so a run is
  // perfectly capable of executing. Mark the connection active so
  // materializeDueFeeds picks it up; the run will fail loudly if cookies
  // are missing, which is the same as any other "logged out" case.
  const connectionStatus =
    interactiveMethod ||
    (authSelection?.authProfile?.profile_kind === 'browser_session' &&
      !isDeviceBoundBrowserSession &&
      !browserProfileUsable) ||
    (authSelection?.authProfile?.status === 'pending_auth' && !isDeviceBoundBrowserSession)
      ? 'pending_auth'
      : 'active';

  // Reject cross-org entity_ids: a connection tagged with another org's entity
  // would surface under a non-existent in-org entity (mirrors manage_feeds).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err) };
  }
  const entityIdsValue =
    args.entity_ids && args.entity_ids.length > 0 ? pgBigintArray(args.entity_ids) : null;

  const slugResult = await resolveNewConnectionSlug({
    organizationId,
    connectorKey: args.connector_key,
    explicitSlug: args.slug,
    displayName,
  });
  if ('error' in slugResult) return { error: slugResult.error };

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape
  let inserted: any[];
  try {
    inserted = await insertConnectionWithSlug({
      organizationId,
      connectorKey: args.connector_key,
      displayName,
      initialSlug: slugResult.slug,
      explicit: !!args.slug?.trim(),
      doInsert: (slug) => sql`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility, device_worker_id,
          entity_ids
        ) VALUES (
          ${organizationId}, ${args.connector_key},
          ${slug},
          ${displayName},
          ${connectionStatus},
          ${interactiveAuthProfileId ?? authSelection?.authProfile?.id ?? null},
          ${authSelection?.appAuthProfile?.id ?? null},
          ${connectionConfigToInsert ? sql.json(connectionConfigToInsert) : null},
          ${effectiveCreatedBy},
          ${visibility},
          ${effectiveDeviceWorkerId},
          ${entityIdsValue}::bigint[]
        )
        RETURNING *
      `,
    });
  } catch (err) {
    if (err instanceof ConnectionSlugConflictError) return { error: err.message };
    if (isPersonalCredVisibilityViolation(err)) return { error: PERSONAL_CRED_ORG_VISIBILITY_ERROR };
    throw err;
  }

  if (authSelection?.authProfile?.profile_kind === 'oauth_account') {
    await syncOAuthConnectionsForAuthProfile(organizationId, authSelection.authProfile.id);
  }

  logger.info(
    {
      connection_id: inserted[0].id,
      connector_key: args.connector_key,
      status: connectionStatus,
    },
    'Connection created'
  );

  recordLifecycleEvent({
    organizationId,
    entityType: 'connection',
    op: 'created',
    entityId: inserted[0].id,
    summary: `Connection "${displayName}" created`,
    extra: { connector_key: args.connector_key, slug: inserted[0].slug },
  });

  return {
    action: 'create',
    connection: enrichWithAuthProfiles(
      inserted[0] as Record<string, unknown>,
      authSelection?.authProfile ?? null,
      authSelection?.appAuthProfile ?? null
    ),
    connector,
    view_url: await buildViewUrl(ctx, args.connector_key),
  };
}

// ============================================
// handleUpdate
// ============================================

export async function handleUpdate(
  args: Extract<ConnectionsArgs, { action: 'update' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Verify ownership
  const existingRows = await sql`
    SELECT c.id, c.connector_key, c.auth_profile_id, c.app_auth_profile_id, c.created_by, c.config, cd.auth_schema, cd.feeds_schema
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT auth_schema, feeds_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;
  if (existingRows.length === 0) {
    return { error: 'Connection not found' };
  }

  const existing = existingRows[0] as {
    id: number;
    connector_key: string;
    auth_schema: { methods?: Array<Record<string, unknown>> } | null;
    feeds_schema: Record<string, unknown> | null;
    auth_profile_id: number | null;
    app_auth_profile_id: number | null;
    created_by: string | null;
    config: Record<string, unknown> | null;
  };

  const hasAuthProfileArg = Object.hasOwn(args, 'auth_profile_slug');
  const hasAppAuthProfileArg = Object.hasOwn(args, 'app_auth_profile_slug');
  const hasDeviceWorkerArg = Object.hasOwn(args, 'device_worker_id');

  // `update` is now member-writable so members can edit their own
  // connection. Resolve the caller's role once up front and gate every
  // member action on "I created this connection" — admins/owners are
  // unrestricted.
  const callerIsAdmin = await resolveCallerIsAdmin(sql, {
    organizationId,
    userId: ctx.userId,
  });

  if (!callerIsAdmin) {
    if (!ctx.userId || existing.created_by !== ctx.userId) {
      return {
        error: 'You can only update connections you created.',
      };
    }
  }

  // App profile updates: non-admins may only set the connector's pinned
  // default (mirrors handleCreate's gate). Clearing the app profile is
  // admin-only — otherwise a member could strip the org default off a
  // shared connection.
  if (hasAppAuthProfileArg && !callerIsAdmin) {
    const slug = args.app_auth_profile_slug;
    if (!slug) {
      return { error: 'Only admins can clear the OAuth app profile.' };
    }
    const picked = await getAuthProfileBySlug(organizationId, slug);
    const pinned =
      picked?.profile_kind === 'oauth_app' &&
      picked.is_default_for_connector &&
      picked.connector_key === existing.connector_key;
    if (!pinned) {
      return {
        error: `Only admins can override the OAuth app profile. Ask an admin to pin '${slug}' as the default for this connector, or omit app_auth_profile_slug to use the org default.`,
      };
    }
  }

  // Account / runtime profile target-profile ownership is enforced after
  // `authSelection` resolves the profile metadata (below). Connection
  // ownership for the rebind itself is covered by the top-level
  // member-write gate above.

  // Resolve the new device-worker binding up front so a bad value rejects the
  // whole update.
  let nextDeviceWorkerId: string | null = null;
  if (hasDeviceWorkerArg) {
    const connectorDef = await getScopedConnectorDefinition({
      organizationId,
      connectorKey: existing.connector_key,
    });
    if (!connectorDef) {
      return { error: `Connector '${existing.connector_key}' not found or not active` };
    }
    const binding = await resolveDeviceBinding({
      organizationId,
      userId: ctx.userId,
      connector: connectorDef,
      deviceWorkerId: args.device_worker_id,
    });
    if ('error' in binding) return binding;
    nextDeviceWorkerId = binding.deviceWorkerId;
  }

  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: existing.connector_key,
    authSchema: existing.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
    deviceWorkerId: nextDeviceWorkerId,
  });

  if (args.auth_profile_slug && !authSelection.authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found for this connector` };
  }
  if (args.app_auth_profile_slug && !authSelection.appAuthProfile) {
    return {
      error: `App auth profile '${args.app_auth_profile_slug}' not found for this connector`,
    };
  }
  if (
    authSelection.authProfile &&
    authSelection.authProfile.profile_kind !== 'browser_session' &&
    authSelection.authProfile.status !== 'active' &&
    authSelection.authProfile.status !== 'pending_auth'
  ) {
    return {
      error: `Auth profile '${args.auth_profile_slug}' has status '${authSelection.authProfile.status}' — must be active or pending_auth`,
    };
  }
  if (authSelection.appAuthProfile && authSelection.appAuthProfile.status !== 'active') {
    return {
      error: `App auth profile '${args.app_auth_profile_slug}' has status '${authSelection.appAuthProfile.status}' — must be active`,
    };
  }

  // Non-admins may only bind to a runtime profile they own. Mirrors the
  // handleCreate target-profile guard so a member who created a connection
  // can't pivot it onto another member's credentials. `env` profiles are
  // admin-managed org-shared credentials — same rule as create.
  if (hasAuthProfileArg && !callerIsAdmin && authSelection.authProfile) {
    const profile = authSelection.authProfile;
    if (profile.profile_kind === 'env') {
      return {
        error:
          'Only admins can use env-credential auth profiles. Ask an admin to rebind this connection.',
      };
    }
    if (
      (profile.profile_kind === 'oauth_account' ||
        profile.profile_kind === 'browser_session') &&
      profile.created_by !== ctx.userId
    ) {
      return {
        error: `Auth profile '${profile.slug}' belongs to another user. Create your own profile (action: 'create_auth_profile') and use its slug instead.`,
      };
    }
  }

  const currentAuthProfile = await getAuthProfileById(organizationId, existing.auth_profile_id);
  const currentAppAuthProfile = await getAuthProfileById(
    organizationId,
    existing.app_auth_profile_id
  );

  const nextAuthProfileId = hasAuthProfileArg
    ? (authSelection.authProfile?.id ?? null)
    : existing.auth_profile_id;
  // Re-pointing a connection onto a PERSONAL credential (oauth_account) must
  // floor its visibility to 'private' — otherwise an existing 'org' connection
  // rebound onto a user's own Gmail would expose that inbox org-wide through the
  // owner's token. Downgrade-only: we never widen here (the CASE keeps the
  // current visibility when the new profile is not personal).
  const rebindToPersonalCred =
    hasAuthProfileArg && isPersonalCredentialKind(authSelection.authProfile?.profile_kind);
  const nextAppAuthProfileId = hasAppAuthProfileArg
    ? (authSelection.appAuthProfile?.id ?? null)
    : existing.app_auth_profile_id;
  const effectiveSelectedAuthProfile = hasAuthProfileArg
    ? authSelection.authProfile
    : currentAuthProfile;

  // Device-bound browser profile auto-pins the connection's device.
  const updateProfileDeviceWorkerId = effectiveSelectedAuthProfile?.device_worker_id ?? null;
  if (updateProfileDeviceWorkerId) {
    if (!hasDeviceWorkerArg) {
      // Caller didn't touch device pin — adopt the profile's device.
      nextDeviceWorkerId = updateProfileDeviceWorkerId;
    } else if (nextDeviceWorkerId && nextDeviceWorkerId !== updateProfileDeviceWorkerId) {
      return {
        error: `Auth profile '${effectiveSelectedAuthProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
      };
    } else if (!nextDeviceWorkerId) {
      nextDeviceWorkerId = updateProfileDeviceWorkerId;
    }
  }
  const isDeviceBoundBrowserSessionUpdate =
    effectiveSelectedAuthProfile?.profile_kind === 'browser_session' &&
    !!updateProfileDeviceWorkerId;

  const browserProfileUsable =
    effectiveSelectedAuthProfile?.profile_kind === 'browser_session' &&
    !isDeviceBoundBrowserSessionUpdate
      ? (
          await getBrowserSessionReadiness(
            effectiveSelectedAuthProfile.auth_data,
            existing.connector_key
          )
        ).usable
      : false;
  const effectiveStatus =
    args.status ??
    (effectiveSelectedAuthProfile?.profile_kind === 'browser_session'
      ? isDeviceBoundBrowserSessionUpdate
        ? 'active'
        : browserProfileUsable
          ? 'active'
          : 'pending_auth'
      : null);
  const splitConfig = splitConfigByFeedScope(
    args.config ?? null,
    (existing.feeds_schema as Record<string, FeedDefinition>) ?? null
  );

  if (splitConfig.feedConfig) {
    return {
      error:
        "Feed-scoped config belongs on feeds. Use manage_feeds(action='update_feed') for sync target settings.",
    };
  }

  // Config write mode: declarative `lobu apply` passes `replace_config: true`
  // so a removed manifest key actually disappears remotely. Default (merge)
  // is preserved for the web UI / partial updates.
  const replaceConfig = args.replace_config === true && args.config !== undefined;
  const connectionConfigForReplace = splitConfig.connectionConfig ?? {};

  // Consent-only is enforced BIDIRECTIONALLY: the feed-creation guard stops a
  // consent-only connection from gaining feeds, and this stops a feed-having
  // connection from becoming consent-only. Compute the consent_only flag the
  // UPDATE below would land on — replace = exactly the new config; merge =
  // existing config overlaid with the incoming keys — and reject the flip when
  // the connection still has feeds, so the "data stays local" invariant holds.
  const existingConfig = parseJsonObject(existing.config);
  const resultingConfig = replaceConfig
    ? connectionConfigForReplace
    : splitConfig.connectionConfig
      ? { ...existingConfig, ...splitConfig.connectionConfig }
      : existingConfig;
  const willBeConsentOnly = parseJsonObject(resultingConfig).consent_only === true;
  if (willBeConsentOnly && existingConfig.consent_only !== true) {
    const feedRows = await sql`
      SELECT 1 FROM feeds
      WHERE connection_id = ${args.connection_id}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (feedRows.length > 0) {
      return {
        error:
          'This connection has feeds; a consent-only connection cannot have feeds. Remove its feeds first.',
      };
    }
  }
  // Reverse direction: a consent-only grant-holder (the cloud OAuth grant behind
  // a managed connector) must STAY consent-only. Stripping the flag would let
  // feeds be added, so the cloud would start syncing the grant-holder's data —
  // breaking the "data stays local" invariant. Reject the removal.
  if (existingConfig.consent_only === true && !willBeConsentOnly) {
    return {
      error:
        'This connection is consent-only (holds an OAuth grant for delegation); the consent-only flag cannot be removed.',
    };
  }

  // Reject cross-org entity_ids on update too (skip when clearing to []).
  if (args.entity_ids !== undefined && args.entity_ids.length > 0) {
    try {
      await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }
  // Tri-state, mirrors manage_feeds: undefined = leave unchanged (null → COALESCE
  // keeps existing), explicit [] = clear ('{}' → COALESCE picks the empty array).
  const entityIdsValue =
    args.entity_ids !== undefined
      ? args.entity_ids.length > 0
        ? pgBigintArray(args.entity_ids)
        : '{}'
      : null;

  // Slug is only ever changed when the caller passes one explicitly — a
  // display_name change never touches it (that's the whole point of a stable
  // identity for `lobu apply`). An explicit slug is validated for format and
  // rejected on collision (never auto-suffixed).
  let nextSlug: string | null = null;
  const updateExplicitSlug = args.slug?.trim();
  if (updateExplicitSlug) {
    const fmtErr = connectionSlugFormatError(updateExplicitSlug);
    if (fmtErr) return { error: fmtErr };
    if (
      await connectionSlugTaken({
        organizationId,
        slug: updateExplicitSlug,
        excludeId: args.connection_id,
      })
    ) {
      return { error: `Connection slug '${updateExplicitSlug}' already exists for this organization.` };
    }
    nextSlug = updateExplicitSlug;
  }

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape
  let updated: any[];
  try {
    updated = await sql`
      UPDATE connections
      SET display_name = COALESCE(${args.display_name ?? null}, display_name),
          slug = COALESCE(${nextSlug}, slug),
          status = COALESCE(${effectiveStatus}, status),
          auth_profile_id = ${nextAuthProfileId},
          app_auth_profile_id = ${nextAppAuthProfileId},
          visibility = CASE WHEN ${rebindToPersonalCred} THEN 'private' ELSE visibility END,
          entity_ids = COALESCE(${entityIdsValue}::bigint[], entity_ids),
          config = ${
            replaceConfig
              ? sql`${sql.json(connectionConfigForReplace)}::jsonb`
              : sql`CASE WHEN ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null}::jsonb IS NOT NULL THEN COALESCE(config, '{}'::jsonb) || ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null}::jsonb ELSE config END`
          },
          updated_at = NOW()
      WHERE id = ${args.connection_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
      RETURNING *
    `;
  } catch (err) {
    if (isConnectionSlugUniqueViolation(err) && updateExplicitSlug) {
      return { error: `Connection slug '${updateExplicitSlug}' already exists for this organization.` };
    }
    if (isPersonalCredVisibilityViolation(err)) return { error: PERSONAL_CRED_ORG_VISIBILITY_ERROR };
    throw err;
  }

  if (hasDeviceWorkerArg || (updateProfileDeviceWorkerId && !hasDeviceWorkerArg)) {
    await sql`
      UPDATE connections
      SET device_worker_id = ${nextDeviceWorkerId}, updated_at = NOW()
      WHERE id = ${args.connection_id} AND organization_id = ${organizationId}
    `;
    (updated[0] as Record<string, unknown>).device_worker_id = nextDeviceWorkerId;
  }

  const updatedConnection = updated[0] as {
    id: number;
    status: string;
  };

  // Keep the internal stream in sync with connection ownership/status.
  await sql`
    UPDATE feeds
    SET status = ${mapConnectionStatusToFeedStatus(updatedConnection.status)},
        next_run_at = CASE
          WHEN ${mapConnectionStatusToFeedStatus(updatedConnection.status)} = 'active'
            THEN COALESCE(next_run_at, NOW())
          ELSE next_run_at
        END,
        updated_at = NOW()
    WHERE connection_id = ${updatedConnection.id}
  `;

  const effectiveAuth = hasAuthProfileArg ? authSelection.authProfile : currentAuthProfile;
  const effectiveAppAuth = hasAppAuthProfileArg
    ? authSelection.appAuthProfile
    : currentAppAuthProfile;

  if (effectiveAuth?.profile_kind === 'oauth_account') {
    await syncOAuthConnectionsForAuthProfile(organizationId, effectiveAuth.id);
  }

  return {
    action: 'update',
    connection: enrichWithAuthProfiles(
      updated[0] as Record<string, unknown>,
      effectiveAuth ?? null,
      effectiveAppAuth ?? null
    ),
  };
}

// ============================================
// handleDelete
// ============================================

export async function handleDelete(
  args: Extract<ConnectionsArgs, { action: 'delete' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Tear down any provider webhook subscription BEFORE the soft-delete, while
  // the connection row (with its stored externalId + credentials) is still
  // readable. Best-effort: the helper logs + swallows failures so a provider
  // hiccup never blocks the delete.
  await unregisterConnectorWebhook({
    organizationId,
    connectionId: args.connection_id,
  });

  const deleted = await sql`
    UPDATE connections
    SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
    WHERE id = ${args.connection_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id, slug, display_name, connector_key
  `;

  if (deleted.length === 0) {
    return { error: 'Connection not found or already deleted' };
  }

  // Cancel any pending runs for this connection's feeds
  await sql`
    UPDATE runs SET status = 'cancelled', completed_at = NOW()
    WHERE feed_id IN (SELECT id FROM feeds WHERE connection_id = ${args.connection_id})
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  // Record change event in knowledge for audit trail
  const conn = deleted[0];
  const affectedFeeds = await sql`
    SELECT DISTINCT unnest(entity_ids) AS entity_id
    FROM feeds
    WHERE connection_id = ${args.connection_id}
      AND entity_ids IS NOT NULL
      AND deleted_at IS NULL
  `;
  const entityIds = affectedFeeds
    .map((row: { entity_id: number | string | null }) => Number(row.entity_id))
    .filter((value) => Number.isFinite(value));
  const connName = conn.display_name || conn.connector_key || args.connection_id;
  recordChangeEvent({
    entityIds: entityIds.map(Number),
    organizationId,
    title: `Connection deleted: ${connName}`,
    content: `Connection "${connName}" (id: ${args.connection_id}, connector: ${conn.connector_key}) was deleted.`,
    metadata: {
      action: 'connection_deleted',
      connection_id: args.connection_id,
      connector_key: conn.connector_key,
      slug: conn.slug,
      display_name: conn.display_name,
    },
  });
  recordLifecycleEvent({
    organizationId,
    entityType: 'connection',
    op: 'deleted',
    entityId: args.connection_id,
    summary: `Connection "${connName}" deleted`,
    extra: { connector_key: conn.connector_key, slug: conn.slug },
  });

  return {
    action: 'delete',
    deleted: true,
    connection_id: args.connection_id,
    slug: conn.slug as string,
  };
}
