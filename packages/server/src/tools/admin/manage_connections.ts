/**
 * Tool: manage_connections
 *
 * Manage integration connections (auth bindings to external services).
 *
 * Actions:
 * - list: List connections for the organization
 * - list_connector_definitions: List available connector definitions for picker UIs
 * - get: Get a specific connection by ID
 * - create: Create a new connection (requires pre-existing auth profiles)
 * - connect: Create connection + auth link in one call (recommended for MCP clients).
 *            Returns a connect_url for the user to complete OAuth auth for a reusable profile.
 *            Poll with get until status='active'.
 * - update: Update connection settings
 * - delete: Delete a connection
 * - test: Test connection credentials
 * - install_connector: Install connector from URL, inline source, or MCP server URL into the current org
 * - uninstall_connector: Archive the org-scoped connector definition
 * - toggle_connector_login: Toggle connector as a login provider
 * - update_connector_auth: Update reusable default auth profiles for an installed org connector
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import { notifyConnectionPermissionRequest } from '../../notifications/triggers';
import {
  EMPTY_SUMMARY,
  getOperationsSummary,
  getOperationsSummaryBatch,
} from '../../operations/catalog';
import {
  createAuthProfile,
  getAuthProfileById,
  getBrowserSessionReadiness,
  getPrimaryAuthProfileForKind,
  normalizeAuthValues,
  summarizeBrowserSessionAuthData,
} from '../../utils/auth-profiles';
import { createConnectToken } from '../../utils/connect-tokens';
import { ensureConnectorInstalled } from '../../utils/ensure-connector-installed';
import { applyEntityLinkOverrides } from '../../utils/entity-link-overrides';
import { recordChangeEvent } from '../../utils/insert-event';
import logger from '../../utils/logger';
import { syncOAuthConnectionsForAuthProfile } from '../../utils/oauth-connection-state';
import { getWorkspaceRole } from '../../utils/organization-access';
import { createAuthRun } from '../../utils/queue-helpers';
import { resolveUsernames } from '../../utils/resolve-usernames';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../../utils/run-statuses';
import { buildConnectionsUrl, getOrganizationSlug, getPublicWebUrl } from '../../utils/url-builder';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import {
  getScopedConnectorDefinition,
  installConnectorDefinitionFromSource,
  installConnectorFromMcpUrl,
  listScopedConnectorDefinitions,
  toggleConnectorLoginEnabled,
  uninstallConnectorDefinition,
} from './connector-definition-helpers';
import {
  buildOAuthConnectConfig,
  buildViewUrl,
  enrichWithAuthProfiles,
  getConnectBaseUrl,
  getInteractiveMethods,
  mapConnectionStatusToFeedStatus,
  maybeUpsertAuthAfterInstall,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
  upsertConnectorAuthProfiles,
} from './helpers/connection-helpers';
import { buildConnectorDefinitionList } from './helpers/connector-definition-list';
import { type FeedDefinition, splitConfigByFeedScope } from './helpers/feed-helpers';
import { PaginationFields } from './schemas/common-fields';

// ============================================
// Schema
// ============================================

const ListAction = Type.Object({
  action: Type.Literal('list'),
  connector_key: Type.Optional(
    Type.String({ description: 'Filter by connector key (e.g. google.gmail)' })
  ),
  status: Type.Optional(
    Type.String({ description: 'Filter by status: active, paused, error, revoked' })
  ),
  entity_id: Type.Optional(Type.Number({ description: 'Filter by linked entity ID' })),
  created_by: Type.Optional(
    Type.String({ description: 'Filter by user ID who created the connection' })
  ),
  ...PaginationFields,
});

const GetAction = Type.Object({
  action: Type.Literal('get'),
  connection_id: Type.Number({ description: 'Connection ID' }),
});

const ListConnectorDefinitionsAction = Type.Object({
  action: Type.Literal('list_connector_definitions'),
  include_installable: Type.Optional(
    Type.Boolean({
      description: 'Include installable connector catalog entries alongside installed connectors',
    })
  ),
});

const EntityLinkOverridesSchema = Type.Union(
  [
    Type.Null(),
    Type.Record(
      Type.String(),
      Type.Object({
        disable: Type.Optional(Type.Boolean()),
        retargetEntityType: Type.Optional(Type.String()),
        autoCreate: Type.Optional(Type.Boolean()),
        maskIdentities: Type.Optional(Type.Array(Type.String())),
      })
    ),
  ],
  {
    description:
      "Per-entityType override of the connector's declared entityLinks rules (keyed by the rule's entityType). Applies at the connector-definition level for this org.",
  }
);

const CreateAction = Type.Object({
  action: Type.Literal('create'),
  connector_key: Type.String({ description: 'Connector key (e.g. google.gmail)' }),
  display_name: Type.Optional(Type.String({ description: 'Human-readable name' })),
  auth_profile_slug: Type.Optional(
    Type.String({ description: 'Reusable auth profile slug for runtime/account auth' })
  ),
  app_auth_profile_slug: Type.Optional(
    Type.String({ description: 'Reusable auth profile slug for OAuth app credentials' })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), { description: 'Connection config' })
  ),
  created_by: Type.Optional(
    Type.String({
      description: 'Override the connection owner (admin/owner only). Defaults to current user.',
    })
  ),
  entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

const UpdateAction = Type.Object({
  action: Type.Literal('update'),
  connection_id: Type.Number({ description: 'Connection ID' }),
  display_name: Type.Optional(Type.String()),
  status: Type.Optional(Type.String({ description: 'active, paused, error, revoked' })),
  auth_profile_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  app_auth_profile_slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  config: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const DeleteAction = Type.Object({
  action: Type.Literal('delete'),
  connection_id: Type.Number({ description: 'Connection ID' }),
});

const ReauthenticateAction = Type.Object({
  action: Type.Literal('reauthenticate'),
  connection_id: Type.Number({
    description:
      'Connection ID whose interactive auth profile should be re-paired via a new auth run.',
  }),
});

const TestAction = Type.Object({
  action: Type.Literal('test'),
  connection_id: Type.Number({ description: 'Connection ID to test' }),
});

const InstallConnectorAction = Type.Object({
  action: Type.Literal('install_connector'),
  source_url: Type.Optional(Type.String({ description: 'Direct URL to connector source file' })),
  source_uri: Type.Optional(
    Type.String({ description: 'Local file source URI or path for connector installation' })
  ),
  source_code: Type.Optional(
    Type.String({ description: 'Inline TypeScript or pre-compiled JavaScript source code' })
  ),
  compiled: Type.Optional(
    Type.Boolean({
      description: 'Set to true if source_code is already compiled JavaScript (skip compilation)',
    })
  ),
  mcp_url: Type.Optional(
    Type.String({
      description:
        'URL to a remote MCP server (Streamable HTTP). Probes the server directly, no compilation needed.',
    })
  ),
  auth_values: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Reusable auth values for env_keys and OAuth client keys. Stored as auth profiles.',
    })
  ),
  entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

const UninstallConnectorAction = Type.Object({
  action: Type.Literal('uninstall_connector'),
  connector_key: Type.String({ description: 'Connector key to uninstall' }),
});

const ConnectAction = Type.Object({
  action: Type.Literal('connect'),
  connector_key: Type.String({ description: 'Connector key (e.g. google.gmail)' }),
  display_name: Type.Optional(
    Type.String({ description: 'Human-readable name for the connection' })
  ),
  auth_profile_slug: Type.Optional(
    Type.String({ description: 'Reusable auth profile slug for runtime/account auth' })
  ),
  app_auth_profile_slug: Type.Optional(
    Type.String({ description: 'Reusable auth profile slug for OAuth app credentials' })
  ),
  config: Type.Optional(
    Type.Record(Type.String(), Type.Any(), { description: 'Connection config' })
  ),
  entity_link_overrides: Type.Optional(EntityLinkOverridesSchema),
});

const ToggleConnectorLoginAction = Type.Object({
  action: Type.Literal('toggle_connector_login'),
  connector_key: Type.String({ description: 'Connector key (e.g. github, google.gmail)' }),
  enabled: Type.Boolean({ description: 'Enable or disable this connector as a login provider' }),
});

const UpdateConnectorAuthAction = Type.Object({
  action: Type.Literal('update_connector_auth'),
  connector_key: Type.String({ description: 'Connector key (e.g. reddit, google.gmail)' }),
  auth_values: Type.Record(Type.String(), Type.String(), {
    description: 'Auth values to upsert (env_keys and OAuth client keys)',
  }),
});

const UpdateConnectorDefaultConfigAction = Type.Object({
  action: Type.Literal('update_connector_default_config'),
  connector_key: Type.String({ description: 'Connector key' }),
  default_connection_config: Type.Record(Type.String(), Type.Any(), {
    description: 'Default connection config (auto_approve_actions, require_approval_actions, etc.)',
  }),
});

const SetConnectorEntityLinkOverridesAction = Type.Object({
  action: Type.Literal('set_connector_entity_link_overrides'),
  connector_key: Type.String({ description: 'Connector key' }),
  overrides: EntityLinkOverridesSchema,
});

const UpdateConnectorDefaultRepairAgentAction = Type.Object({
  action: Type.Literal('update_connector_default_repair_agent'),
  connector_key: Type.String({ description: 'Connector key' }),
  default_repair_agent_id: Type.Union([Type.String(), Type.Null()], {
    description:
      'Default repair agent ID for feeds of this connector. Null clears the default.',
  }),
});

export const ManageConnectionsSchema = Type.Union([
  ListAction,
  ListConnectorDefinitionsAction,
  GetAction,
  CreateAction,
  ConnectAction,
  UpdateAction,
  DeleteAction,
  ReauthenticateAction,
  TestAction,
  InstallConnectorAction,
  UninstallConnectorAction,
  ToggleConnectorLoginAction,
  UpdateConnectorAuthAction,
  UpdateConnectorDefaultConfigAction,
  UpdateConnectorDefaultRepairAgentAction,
  SetConnectorEntityLinkOverridesAction,
]);

// ============================================
// Result Types
// ============================================

type ManageConnectionsResult =
  | { error: string; setup_url?: string }
  | { action: 'list_connector_definitions'; connector_definitions: any[] }
  | {
      action: 'list';
      connections: any[];
      total: number;
      limit: number;
      offset: number;
      view_url?: string;
    }
  | { action: 'get'; connection: any; view_url?: string }
  | {
      action: 'create';
      connection: any;
      connector: any;
      view_url?: string;
      auth_run_id?: number;
    }
  | {
      action: 'connect';
      connection_id: number;
      status: 'active';
      message: string;
      view_url?: string;
    }
  | {
      action: 'connect';
      connection_id: number;
      status: 'pending_auth';
      auth_type: string;
      instructions: string;
      connect_url?: string;
      connect_token?: string;
      auth_profile_slug?: string;
      view_url?: string;
    }
  | { action: 'update'; connection: any }
  | { action: 'delete'; deleted: true; connection_id: number }
  | { action: 'reauthenticate'; connection_id: number; auth_run_id: number }
  | {
      action: 'test';
      status: string;
      message: string;
      has_token?: boolean;
      has_refresh?: boolean;
      expires_at?: string | null;
    }
  | {
      action: 'install_connector';
      installed: true;
      connector_key: string;
      name: string;
      version: string;
      code_hash: string;
      updated: boolean;
    }
  | { action: 'uninstall_connector'; uninstalled: true; connector_key: string }
  | {
      action: 'toggle_connector_login';
      success: true;
      connector_key: string;
      login_enabled: boolean;
    }
  | {
      action: 'update_connector_auth';
      success: true;
      connector_key: string;
      keys_updated: string[];
    }
  | {
      action: 'update_connector_default_config';
      success: true;
      connector_key: string;
    }
  | {
      action: 'update_connector_default_repair_agent';
      success: true;
      connector_key: string;
      default_repair_agent_id: string | null;
    }
  | {
      action: 'set_connector_entity_link_overrides';
      success: true;
      connector_key: string;
      overrides: Record<string, unknown> | null;
    };

type ConnectionsArgs = Static<typeof ManageConnectionsSchema>;

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageConnections(
  args: ConnectionsArgs,
  env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  return routeAction<ManageConnectionsResult>('manage_connections', args.action, ctx, {
    list_connector_definitions: () =>
      handleListConnectorDefinitions(
        args as Extract<ConnectionsArgs, { action: 'list_connector_definitions' }>,
        env,
        ctx
      ),
    list: () => handleList(args as Extract<ConnectionsArgs, { action: 'list' }>, ctx),
    get: () => handleGet(args as Extract<ConnectionsArgs, { action: 'get' }>, ctx),
    create: () => handleCreate(args as Extract<ConnectionsArgs, { action: 'create' }>, env, ctx),
    connect: () => handleConnect(args as Extract<ConnectionsArgs, { action: 'connect' }>, env, ctx),
    update: () => handleUpdate(args as Extract<ConnectionsArgs, { action: 'update' }>, ctx),
    delete: () => handleDelete(args as Extract<ConnectionsArgs, { action: 'delete' }>, ctx),
    reauthenticate: () =>
      handleReauthenticate(args as Extract<ConnectionsArgs, { action: 'reauthenticate' }>, ctx),
    test: () => handleTest(args as Extract<ConnectionsArgs, { action: 'test' }>, ctx),
    install_connector: () =>
      handleInstallConnector(
        args as Extract<ConnectionsArgs, { action: 'install_connector' }>,
        ctx
      ),
    uninstall_connector: () =>
      handleUninstallConnector(
        args as Extract<ConnectionsArgs, { action: 'uninstall_connector' }>,
        ctx
      ),
    toggle_connector_login: () =>
      handleToggleConnectorLogin(
        args as Extract<ConnectionsArgs, { action: 'toggle_connector_login' }>,
        ctx
      ),
    update_connector_auth: () =>
      handleUpdateConnectorAuth(
        args as Extract<ConnectionsArgs, { action: 'update_connector_auth' }>,
        ctx
      ),
    update_connector_default_config: () =>
      handleUpdateConnectorDefaultConfig(
        args as Extract<ConnectionsArgs, { action: 'update_connector_default_config' }>,
        ctx
      ),
    update_connector_default_repair_agent: () =>
      handleUpdateConnectorDefaultRepairAgent(
        args as Extract<
          ConnectionsArgs,
          { action: 'update_connector_default_repair_agent' }
        >,
        ctx
      ),
    set_connector_entity_link_overrides: () =>
      handleSetConnectorEntityLinkOverrides(
        args as Extract<ConnectionsArgs, { action: 'set_connector_entity_link_overrides' }>,
        ctx
      ),
  });
}

// ============================================
// Action Handlers
// ============================================

async function handleListConnectorDefinitions(
  args: Extract<ConnectionsArgs, { action: 'list_connector_definitions' }>,
  env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const { organizationId } = ctx;

  const rows = await listScopedConnectorDefinitions({ organizationId });
  const connectorKeys = rows.map((r) => r.key);
  const summaries = await getOperationsSummaryBatch(organizationId, connectorKeys);
  const connectorDefinitions = await buildConnectorDefinitionList({
    installedRows: rows,
    summaries,
    includeInstallable: args.include_installable,
    catalogUris: env.CONNECTOR_CATALOG_URIS,
  });

  return { action: 'list_connector_definitions', connector_definitions: connectorDefinitions };
}

async function handleList(
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
           ap.slug AS auth_profile_slug,
           ap.display_name AS auth_profile_name,
           ap.status AS auth_profile_status,
           ap.profile_kind AS auth_profile_kind,
           app.slug AS app_auth_profile_slug,
           app.display_name AS app_auth_profile_name,
           app.status AS app_auth_profile_status,
           app.profile_kind AS app_auth_profile_kind,
           (SELECT COUNT(*) FROM current_event_records e WHERE e.connection_id = c.id)::int AS event_count,
           (SELECT COUNT(*) FROM feeds f WHERE f.connection_id = c.id AND f.deleted_at IS NULL)::int AS feed_count,
           (SELECT ct.token FROM connect_tokens ct
            WHERE ct.connection_id = c.id AND ct.status = 'pending' AND ct.expires_at > NOW()
            ORDER BY ct.created_at DESC LIMIT 1) AS connect_token,
           (
             SELECT string_agg(DISTINCT ent.name, ', ' ORDER BY ent.name)
             FROM feeds f
             JOIN entities ent ON ent.id = ANY(f.entity_ids)
             WHERE f.connection_id = c.id AND f.deleted_at IS NULL
           ) AS entity_names
    FROM connections c
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
    LEFT JOIN auth_profiles app ON app.id = c.app_auth_profile_id
    WHERE c.organization_id = ${organizationId} AND c.deleted_at IS NULL
  `;

  if (args.connector_key) {
    query = sql`${query} AND c.connector_key = ${args.connector_key}`;
  }
  if (args.status) {
    query = sql`${query} AND c.status = ${args.status}`;
  }
  if (args.entity_id) {
    query = sql`${query} AND EXISTS (
      SELECT 1
      FROM feeds f
      WHERE f.connection_id = c.id
        AND f.deleted_at IS NULL
        AND ${args.entity_id} = ANY(f.entity_ids)
    )`;
  }
  if (args.created_by) {
    query = sql`${query} AND c.created_by = ${args.created_by}`;
  }

  // Visibility: non-admin users see only org connections + their own private connections
  if (ctx.userId) {
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
    return {
      ...row,
      operations_summary: operationsSummary,
      has_operations: operationsSummary.total > 0,
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

async function handleGet(
  args: Extract<ConnectionsArgs, { action: 'get' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = await sql`
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
           (SELECT COUNT(*) FROM current_event_records e WHERE e.connection_id = c.id)::int AS event_count
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
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
  `;

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

  return {
    action: 'get',
    connection: {
      ...resolved,
      ...(connectToken ? { connect_token: connectToken } : {}),
      operations_summary: operationsSummary,
      has_operations: operationsSummary.total > 0,
    },
    view_url: viewUrl,
  };
}

async function handleCreate(
  args: Extract<ConnectionsArgs, { action: 'create' }>,
  _env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;

  // Resolve effective owner — admins can create connections on behalf of other users
  let effectiveCreatedBy = userId;
  if (args.created_by && args.created_by !== userId) {
    const callerRole = await getWorkspaceRole(sql, organizationId, userId!);
    if (callerRole !== 'admin' && callerRole !== 'owner') {
      return { error: 'Only admins can create connections for other users.' };
    }
    effectiveCreatedBy = args.created_by;
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

  if (args.entity_link_overrides !== undefined) {
    const err = await applyEntityLinkOverrides(
      organizationId,
      args.connector_key,
      args.entity_link_overrides
    );
    if (err) return { error: err };
  }

  // No-auth connectors: one connection per user
  const authMethods =
    (connector.auth_schema as { methods?: Array<{ type: string }> })?.methods ?? [];
  const isNoAuth = authMethods.length > 0 && authMethods.every((m) => m.type === 'none');
  if (isNoAuth) {
    const existing = await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND created_by = ${effectiveCreatedBy}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (existing.length > 0) {
      return {
        error: `This user already has a ${connector.name} connection (id: ${existing[0].id}). No-auth connectors are limited to one connection per user.`,
      };
    }
  }

  // Detect interactive-auth connectors (e.g. WhatsApp QR). These bypass the
  // standard auth profile selection and instead drive an `authenticate()` run
  // that emits artifacts (qr/code/etc.) for the UI to render.
  const interactiveMethod = getInteractiveMethods(connector.auth_schema)[0] ?? null;

  const authSelection = interactiveMethod
    ? null
    : await resolveConnectionAuthSelection({
        organizationId,
        connectorKey: args.connector_key,
        authSchema: connector.auth_schema,
        authProfileSlug: args.auth_profile_slug,
        appAuthProfileSlug: args.app_auth_profile_slug,
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

  if (
    authSelection?.authProfile &&
    authSelection.authProfile.profile_kind !== 'browser_session' &&
    authSelection.authProfile.status !== 'active'
  ) {
    return {
      error: `Selected auth profile '${authSelection.authProfile.slug}' is not active.`,
    };
  }

  if (authSelection?.selectedKind === 'oauth_account') {
    if (!authSelection.appAuthProfile) {
      return {
        error: 'Select or create an OAuth app profile before creating the connection.',
      };
    }
    if (authSelection.appAuthProfile.status !== 'active') {
      return {
        error: `Selected app auth profile '${authSelection.appAuthProfile.slug}' is not active.`,
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

  const visibility = await resolveConnectionVisibility(organizationId, effectiveCreatedBy);
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

  const connectionStatus = interactiveMethod
    ? 'pending_auth'
    : authSelection?.authProfile?.profile_kind === 'browser_session' && !browserProfileUsable
      ? 'pending_auth'
      : 'active';

  const inserted = await sql`
    INSERT INTO connections (
      organization_id, connector_key, display_name, status,
      auth_profile_id, app_auth_profile_id, config, created_by, visibility
    ) VALUES (
      ${organizationId}, ${args.connector_key},
      ${displayName},
      ${connectionStatus},
      ${interactiveAuthProfileId ?? authSelection?.authProfile?.id ?? null},
      ${authSelection?.appAuthProfile?.id ?? null},
      ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null},
      ${effectiveCreatedBy},
      ${visibility}
    )
    RETURNING *
  `;

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

async function handleConnect(
  args: Extract<ConnectionsArgs, { action: 'connect' }>,
  _env: Env,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;

  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const ownerSlug = await getOrganizationSlug(organizationId);
  const buildSetupUrl = (opts?: { connectorKey?: string; install?: string }) =>
    ownerSlug && baseUrl
      ? buildConnectionsUrl(
          ownerSlug,
          baseUrl,
          opts?.connectorKey,
          opts?.install ? { install: opts.install } : undefined
        )
      : undefined;

  // Ensure connector is installed from bundled catalog if needed
  await ensureConnectorInstalled({ organizationId, connectorKey: args.connector_key });

  // Verify connector exists
  const connector = await getScopedConnectorDefinition({
    organizationId,
    connectorKey: args.connector_key,
  });

  if (!connector) {
    return {
      error: `Connector '${args.connector_key}' not found. Install it first from the connections page.`,
      setup_url: buildSetupUrl({ install: args.connector_key }),
    };
  }

  if (args.entity_link_overrides !== undefined) {
    const err = await applyEntityLinkOverrides(
      organizationId,
      args.connector_key,
      args.entity_link_overrides
    );
    if (err) return { error: err };
  }

  const setupUrl = buildSetupUrl({ connectorKey: args.connector_key });

  // Idempotent: reuse existing pending_auth connection with a valid connect token
  const pendingRows = await sql`
    SELECT c.id, ct.token
    FROM connections c
    JOIN connect_tokens ct ON ct.connection_id = c.id
      AND ct.status = 'pending' AND ct.expires_at > NOW()
    WHERE c.organization_id = ${organizationId}
      AND c.connector_key = ${args.connector_key}
      AND c.status = 'pending_auth'
      AND c.deleted_at IS NULL
      ${userId ? sql`AND c.created_by = ${userId}` : sql``}
    ORDER BY ct.created_at DESC
    LIMIT 1
  `;
  if (pendingRows.length > 0) {
    const pending = pendingRows[0] as { id: number; token: string };
    const connectUrl = `${getConnectBaseUrl(ctx)}/connect/${pending.token}/oauth/start`;
    return {
      action: 'connect',
      connection_id: pending.id,
      status: 'pending_auth',
      auth_type: 'oauth',
      connect_url: connectUrl,
      connect_token: pending.token,
      instructions: `A pending connection already exists. Send the connect_url to the user to complete OAuth authorization. Poll with action='get' until status='active'.`,
    };
  }

  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: args.connector_key,
    authSchema: connector.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
  });

  const hasNoAuth =
    !authSelection.oauthMethod && !authSelection.envMethod && !authSelection.browserMethod;
  const browserProfileUsable =
    authSelection.authProfile?.profile_kind === 'browser_session'
      ? (await getBrowserSessionReadiness(authSelection.authProfile.auth_data, args.connector_key))
          .usable
      : false;
  const hasReadySelection =
    !!authSelection.authProfile &&
    (authSelection.authProfile.profile_kind === 'browser_session'
      ? browserProfileUsable
      : authSelection.authProfile.status === 'active') &&
    (authSelection.selectedKind !== 'oauth_account' ||
      (authSelection.appAuthProfile?.status === 'active' && !!authSelection.appAuthProfile));

  const needsConnectFlow =
    authSelection.preferredMethodType === 'oauth' &&
    !!authSelection.oauthMethod &&
    !hasReadySelection &&
    !args.auth_profile_slug;
  const needsBrowserAuth =
    !!authSelection.browserMethod &&
    !!authSelection.authProfile &&
    authSelection.authProfile.profile_kind === 'browser_session' &&
    !browserProfileUsable;
  const connectionStatus = needsConnectFlow || needsBrowserAuth ? 'pending_auth' : 'active';

  if (!hasNoAuth && !needsConnectFlow && !needsBrowserAuth && !hasReadySelection) {
    return {
      error: authSelection.browserMethod
        ? 'Select or create a browser auth profile before creating the connection.'
        : authSelection.oauthMethod && authSelection.selectedKind !== 'oauth_account'
          ? 'Select or create an OAuth account profile before creating the connection.'
          : authSelection.envMethod
            ? 'Select or create an auth profile before creating the connection.'
            : 'Selected auth profile is not ready yet.',
      setup_url: setupUrl,
    };
  }

  // Create the connection
  const connectDisplayName = await resolveConnectionDisplayName({
    explicitName: args.display_name,
    connectorName: connector.name,
    username: userId
      ? ((
          (await resolveUsernames([{ created_by: userId }], 'created_by'))[0] as {
            created_by_username?: string;
          }
        )?.created_by_username ?? null)
      : null,
  });

  const connectVisibility = await resolveConnectionVisibility(organizationId, userId);
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
      setup_url: setupUrl,
    };
  }

  const insertedConn = await sql`
    INSERT INTO connections (
      organization_id, connector_key, display_name, status,
      auth_profile_id, app_auth_profile_id, config, created_by, visibility
    ) VALUES (
      ${organizationId}, ${args.connector_key},
      ${connectDisplayName},
      ${connectionStatus},
      ${authSelection.authProfile?.id ?? null},
      ${authSelection.appAuthProfile?.id ?? null},
      ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null},
      ${userId},
      ${connectVisibility}
    )
    RETURNING *
  `;

  const connection = insertedConn[0] as {
    id: number;
    status: string;
  };

  logger.info(
    {
      connection_id: connection.id,
      connector_key: args.connector_key,
      status: connectionStatus,
    },
    'Connection created via connect flow'
  );

  // If active immediately, return simple result
  if (!needsConnectFlow && !needsBrowserAuth) {
    return {
      action: 'connect',
      connection_id: connection.id,
      status: 'active',
      message: 'Connection created and active.',
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  if (needsBrowserAuth) {
    return {
      action: 'connect',
      connection_id: connection.id,
      status: 'pending_auth',
      auth_type: 'browser',
      auth_profile_slug: authSelection.authProfile?.slug ?? undefined,
      instructions:
        `Complete browser auth for profile '${authSelection.authProfile?.slug}'. ` +
        `Run: lobu memory browser-auth --connector ${args.connector_key} --auth-profile-slug ${authSelection.authProfile?.slug}`,
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  const rollbackConnection = async () => {
    await sql`DELETE FROM feeds WHERE connection_id = ${connection.id}`;
    await sql`DELETE FROM connections WHERE id = ${connection.id}`;
  };

  if (!authSelection.oauthMethod) {
    await rollbackConnection();
    return {
      error: 'Env-key connectors require selecting or creating an auth profile before connecting.',
      setup_url: setupUrl,
    };
  }

  const oauthMethod = authSelection.oauthMethod;
  const appAuthProfile =
    authSelection.appAuthProfile ??
    (await getPrimaryAuthProfileForKind({
      organizationId,
      connectorKey: args.connector_key,
      profileKind: 'oauth_app',
      provider: oauthMethod.provider,
    }));

  if (!appAuthProfile || appAuthProfile.status !== 'active') {
    await rollbackConnection();

    return {
      error:
        `OAuth app profile not configured for '${oauthMethod.provider}'. ` +
        'Create an OAuth app auth profile first, then retry.',
      setup_url: setupUrl,
    };
  }

  // Link app auth profile to connection; user auth profile will be created
  // when the OAuth callback completes (avoids orphaned pending_auth profiles).
  await sql`
    UPDATE connections
    SET app_auth_profile_id = ${appAuthProfile.id},
        updated_at = NOW()
    WHERE id = ${connection.id}
  `;

  const connectToken = await createConnectToken({
    connectionId: connection.id,
    organizationId,
    connectorKey: args.connector_key,
    authType: 'oauth',
    authConfig: {
      ...buildOAuthConnectConfig(oauthMethod),
      // Profile metadata — callback creates the real profile on success
      pendingProfileMeta: {
        displayName: `${args.display_name ?? connector.name} Account`,
        slug: `${args.connector_key}-${oauthMethod.provider}-account`,
        connectorKey: args.connector_key,
        provider: oauthMethod.provider,
      },
    },
    createdBy: userId,
  });

  const connectUrl = `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`;

  // Fire-and-forget notification to org admins
  notifyConnectionPermissionRequest({
    orgId: organizationId,
    connectionId: connection.id,
    connectorKey: args.connector_key,
    connectUrl,
  }).catch((err) => logger.error(err, 'Failed to send connection permission notification'));

  return {
    action: 'connect',
    connection_id: connection.id,
    status: 'pending_auth',
    auth_type: 'oauth',
    connect_url: connectUrl,
    connect_token: connectToken.token,
    instructions: `Send the connect_url to the user to complete OAuth authorization with ${oauthMethod.provider}. Poll this connection with action='get' until status='active'.`,
  };
}

async function handleUpdate(
  args: Extract<ConnectionsArgs, { action: 'update' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  // Verify ownership
  const existingRows = await sql`
    SELECT c.id, c.connector_key, c.auth_profile_id, c.app_auth_profile_id, cd.auth_schema, cd.feeds_schema
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
  };

  const hasAuthProfileArg = Object.hasOwn(args, 'auth_profile_slug');
  const hasAppAuthProfileArg = Object.hasOwn(args, 'app_auth_profile_slug');

  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: existing.connector_key,
    authSchema: existing.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
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

  const currentAuthProfile = await getAuthProfileById(organizationId, existing.auth_profile_id);
  const currentAppAuthProfile = await getAuthProfileById(
    organizationId,
    existing.app_auth_profile_id
  );

  const nextAuthProfileId = hasAuthProfileArg
    ? (authSelection.authProfile?.id ?? null)
    : existing.auth_profile_id;
  const nextAppAuthProfileId = hasAppAuthProfileArg
    ? (authSelection.appAuthProfile?.id ?? null)
    : existing.app_auth_profile_id;
  const effectiveSelectedAuthProfile = hasAuthProfileArg
    ? authSelection.authProfile
    : currentAuthProfile;
  const browserProfileUsable =
    effectiveSelectedAuthProfile?.profile_kind === 'browser_session'
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
      ? browserProfileUsable
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

  const updated = await sql`
    UPDATE connections
    SET display_name = COALESCE(${args.display_name ?? null}, display_name),
        status = COALESCE(${effectiveStatus}, status),
        auth_profile_id = ${nextAuthProfileId},
        app_auth_profile_id = ${nextAppAuthProfileId},
        config = CASE WHEN ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null}::jsonb IS NOT NULL THEN COALESCE(config, '{}'::jsonb) || ${splitConfig.connectionConfig ? sql.json(splitConfig.connectionConfig) : null}::jsonb ELSE config END,
        updated_at = NOW()
    WHERE id = ${args.connection_id} AND organization_id = ${organizationId}
    RETURNING *
  `;

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

async function handleDelete(
  args: Extract<ConnectionsArgs, { action: 'delete' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const deleted = await sql`
    UPDATE connections
    SET deleted_at = NOW(), status = 'paused', updated_at = NOW()
    WHERE id = ${args.connection_id} AND organization_id = ${organizationId} AND deleted_at IS NULL
    RETURNING id, display_name, connector_key
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
      display_name: conn.display_name,
    },
  });

  return { action: 'delete', deleted: true, connection_id: args.connection_id };
}

async function handleReauthenticate(
  args: Extract<ConnectionsArgs, { action: 'reauthenticate' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  if (!ctx.userId) {
    return { error: 'Authentication required to re-authenticate a connection' };
  }

  const rows = await sql`
    SELECT
      c.id,
      c.status AS connection_status,
      c.connector_key,
      c.auth_profile_id,
      ap.profile_kind,
      ap.status AS auth_profile_status
    FROM connections c
    LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
    WHERE c.id = ${args.connection_id}
      AND c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const row = rows[0] as {
    id: number;
    connection_status: string;
    connector_key: string;
    auth_profile_id: number | null;
    profile_kind: string | null;
    auth_profile_status: string | null;
  };

  if (!row.auth_profile_id || row.profile_kind !== 'interactive') {
    return { error: 'Connection does not use an interactive auth profile' };
  }

  const activeRuns = await sql`
    SELECT id, created_by_user_id
    FROM runs
    WHERE auth_profile_id = ${row.auth_profile_id}
      AND run_type = 'auth'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (activeRuns.length > 0) {
    const existing = activeRuns[0] as { id: unknown; created_by_user_id: string | null };
    if (existing.created_by_user_id && existing.created_by_user_id !== ctx.userId) {
      return {
        error: 'An authentication flow is already in progress for this profile by another user.',
      };
    }
    return {
      action: 'reauthenticate',
      connection_id: row.id,
      auth_run_id: Number(existing.id),
    };
  }

  if (row.auth_profile_status !== 'pending_auth') {
    await sql`
      UPDATE auth_profiles
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.auth_profile_id}
    `;
  }

  if (row.connection_status !== 'pending_auth') {
    await sql`
      UPDATE connections
      SET status = 'pending_auth', updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const authRunId = await createAuthRun({
    organizationId,
    connectorKey: row.connector_key,
    authProfileId: row.auth_profile_id,
    createdByUserId: ctx.userId,
  });

  return {
    action: 'reauthenticate',
    connection_id: row.id,
    auth_run_id: authRunId,
  };
}

async function handleTest(
  args: Extract<ConnectionsArgs, { action: 'test' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const rows = await sql`
    SELECT c.connector_key,
           c.auth_profile_id,
           c.app_auth_profile_id,
           c.status,
           cd.auth_schema
    FROM connections c
    LEFT JOIN LATERAL (
      SELECT auth_schema
      FROM connector_definitions
      WHERE key = c.connector_key
        AND status = 'active'
        AND organization_id = ${organizationId}
      ORDER BY updated_at DESC
      LIMIT 1
    ) cd ON TRUE
    WHERE c.id = ${args.connection_id} AND c.organization_id = ${organizationId}
  `;

  if (rows.length === 0) {
    return { error: 'Connection not found' };
  }

  const conn = rows[0] as any;
  const authProfile = await getAuthProfileById(
    organizationId,
    Number(conn.auth_profile_id) || null
  );
  const appAuthProfile = await getAuthProfileById(
    organizationId,
    Number(conn.app_auth_profile_id) || null
  );

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    const accountRows = await sql`
      SELECT "accessToken" IS NOT NULL AS has_token,
             "accessTokenExpiresAt",
             "refreshToken" IS NOT NULL AS has_refresh
      FROM "account"
      WHERE id = ${authProfile.account_id}
    `;

    if (accountRows.length === 0) {
      return { action: 'test', status: 'error', message: 'Linked OAuth account not found' };
    }

    const account = accountRows[0] as any;
    if (!account.has_token) {
      return {
        action: 'test',
        status: 'error',
        message: 'No access token available. Re-authenticate.',
      };
    }

    const expiresAt = account.accessTokenExpiresAt ? new Date(account.accessTokenExpiresAt) : null;
    const isExpired = expiresAt && expiresAt.getTime() < Date.now();

    return {
      action: 'test',
      status: isExpired && !account.has_refresh ? 'error' : 'ok',
      message: isExpired
        ? account.has_refresh
          ? 'Token expired but refresh token available'
          : 'Token expired and no refresh token'
        : 'Credentials valid',
      has_token: account.has_token,
      has_refresh: account.has_refresh,
      expires_at: expiresAt?.toISOString() ?? null,
    };
  }

  const profileToTest =
    authProfile?.profile_kind === 'env'
      ? authProfile
      : appAuthProfile?.profile_kind === 'oauth_app'
        ? appAuthProfile
        : null;

  if (profileToTest) {
    const creds = normalizeAuthValues(profileToTest.auth_data);
    const label = profileToTest.profile_kind === 'oauth_app' ? 'App auth' : 'Auth';
    const hasKeys = Object.keys(creds).length > 0;
    return {
      action: 'test',
      status: hasKeys ? 'ok' : 'warning',
      message: hasKeys
        ? `${label} profile '${profileToTest.slug}' configured`
        : `${label} profile '${profileToTest.slug}' has no credentials`,
    };
  }

  if (authProfile?.profile_kind === 'browser_session') {
    const summary = summarizeBrowserSessionAuthData(authProfile.auth_data, conn.connector_key);
    if (summary.cdp_url) {
      const readiness = await getBrowserSessionReadiness(authProfile.auth_data, conn.connector_key);
      return {
        action: 'test',
        status: readiness.usable ? 'ok' : 'warning',
        message: readiness.usable
          ? `Browser auth profile '${authProfile.slug}' CDP endpoint reachable`
          : `Browser auth profile '${authProfile.slug}' CDP configured but endpoint not responding at ${summary.cdp_url}`,
        expires_at: summary.expires_at,
      };
    }
    if (summary.cookie_count === 0) {
      return {
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no cookies`,
        expires_at: summary.expires_at,
      };
    }
    if (!summary.auth_cookie_name) {
      return {
        action: 'test',
        status: 'warning',
        message: `Browser auth profile '${authProfile.slug}' has no likely auth cookie`,
        expires_at: summary.expires_at,
      };
    }
    return {
      action: 'test',
      status: summary.is_expired ? 'error' : 'ok',
      message: summary.is_expired
        ? `${summary.auth_cookie_name} expired`
        : `${summary.auth_cookie_name} valid`,
      expires_at: summary.expires_at,
    };
  }

  return { action: 'test', status: 'warning', message: 'No auth profile configured' };
}

async function handleInstallConnector(
  args: Extract<ConnectionsArgs, { action: 'install_connector' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const installed = args.mcp_url
      ? await installConnectorFromMcpUrl({
          organizationId: ctx.organizationId,
          mcpUrl: args.mcp_url,
        })
      : await installConnectorDefinitionFromSource({
          organizationId: ctx.organizationId,
          sourceUrl: args.source_url,
          sourceUri: args.source_uri,
          sourceCode: args.source_code,
          compiled: args.compiled,
        });

    await maybeUpsertAuthAfterInstall(installed, args.auth_values, ctx);

    if (args.entity_link_overrides !== undefined) {
      const err = await applyEntityLinkOverrides(
        ctx.organizationId,
        installed.connectorKey,
        args.entity_link_overrides
      );
      if (err) return { error: err };
    }

    return {
      action: 'install_connector',
      installed: true,
      connector_key: installed.connectorKey,
      name: installed.name,
      version: installed.version,
      code_hash: installed.codeHash,
      updated: installed.updated,
    };
  } catch (error) {
    return {
      error: `Install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleUninstallConnector(
  args: Extract<ConnectionsArgs, { action: 'uninstall_connector' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const archived = await uninstallConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
    });
    if (!archived) {
      return { error: `Connector '${args.connector_key}' not found or already archived` };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  return { action: 'uninstall_connector', uninstalled: true, connector_key: args.connector_key };
}

/**
 * Toggle connector as a login provider.
 * Requires OAuth auth method in the connector's auth_schema.
 */
async function handleToggleConnectorLogin(
  args: Extract<ConnectionsArgs, { action: 'toggle_connector_login' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  try {
    const connector = await toggleConnectorLoginEnabled({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
      enabled: args.enabled,
    });

    if (!connector) {
      return {
        error: `Connector '${args.connector_key}' not found for this organization. Install it first.`,
      };
    }

    logger.info(
      { connector_key: args.connector_key, login_enabled: args.enabled },
      'Connector login provider toggled'
    );

    return {
      action: 'toggle_connector_login',
      success: true,
      connector_key: args.connector_key,
      login_enabled: args.enabled,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleUpdateConnectorAuth(
  args: Extract<ConnectionsArgs, { action: 'update_connector_auth' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const organizationId = ctx.organizationId;
  const userId = ctx.userId ?? 'api';

  const authValues = normalizeAuthValues(args.auth_values);
  if (Object.keys(authValues).length === 0) {
    return { error: 'No auth values provided.' };
  }

  const connectorRows = await sql`
    SELECT key, name, auth_schema
    FROM connector_definitions
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (connectorRows.length === 0) {
    return { error: `Connector '${args.connector_key}' not found for this organization.` };
  }

  const connector = connectorRows[0] as {
    key: string;
    name: string;
    auth_schema: Record<string, unknown> | null;
  };

  await upsertConnectorAuthProfiles({
    organizationId,
    connectorKey: args.connector_key,
    connectorName: connector.name,
    authSchema: connector.auth_schema,
    authValues,
    createdBy: userId,
  });

  logger.info(
    { connector_key: args.connector_key, keys: Object.keys(authValues) },
    'Connector auth profiles updated'
  );

  return {
    action: 'update_connector_auth',
    success: true,
    connector_key: args.connector_key,
    keys_updated: Object.keys(authValues),
  };
}

async function handleUpdateConnectorDefaultConfig(
  args: Extract<ConnectionsArgs, { action: 'update_connector_default_config' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const updated = await sql`
    UPDATE connector_definitions
    SET default_connection_config = ${sql.json(args.default_connection_config)},
        updated_at = NOW()
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
      AND status = 'active'
    RETURNING key
  `;

  if (updated.length === 0) {
    return { error: `Connector '${args.connector_key}' not found` };
  }

  return {
    action: 'update_connector_default_config',
    success: true,
    connector_key: args.connector_key,
  };
}

async function handleUpdateConnectorDefaultRepairAgent(
  args: Extract<ConnectionsArgs, { action: 'update_connector_default_repair_agent' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId } = ctx;

  const updated = await sql`
    UPDATE connector_definitions
    SET default_repair_agent_id = ${args.default_repair_agent_id}::text,
        updated_at = NOW()
    WHERE key = ${args.connector_key}
      AND organization_id = ${organizationId}
      AND status = 'active'
    RETURNING key
  `;

  if (updated.length === 0) {
    return { error: `Connector '${args.connector_key}' not found` };
  }

  return {
    action: 'update_connector_default_repair_agent',
    success: true,
    connector_key: args.connector_key,
    default_repair_agent_id: args.default_repair_agent_id,
  };
}

async function handleSetConnectorEntityLinkOverrides(
  args: Extract<ConnectionsArgs, { action: 'set_connector_entity_link_overrides' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const err = await applyEntityLinkOverrides(
    ctx.organizationId,
    args.connector_key,
    args.overrides
  );
  if (err) return { error: err };

  return {
    action: 'set_connector_entity_link_overrides',
    success: true,
    connector_key: args.connector_key,
    overrides: (args.overrides ?? null) as Record<string, unknown> | null,
  };
}
