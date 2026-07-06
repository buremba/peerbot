/**
 * Connect action handler: create connection + OAuth flow in one call.
 */

import { getDb, pgBigintArray } from '../../../../db/client';
import { notifyConnectionPermissionRequest } from '../../../../notifications/triggers';
import { getPrimaryAuthProfileForKind, getBrowserSessionReadiness } from '../../../../utils/auth-profiles';
import {
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  insertConnectionWithSlug,
  resolveNewConnectionSlug,
} from '../../../../utils/connections';
import { applyEntityLinkOverrides } from '../../../../utils/entity-link-validation';
import { recordLifecycleEvent } from '../../../../utils/insert-event';
import { recordToolConfigChange } from '../../helpers/config-audit';
import logger from '../../../../utils/logger';
import { ensureConnectorInstalled } from '../../../../utils/ensure-connector-installed';
import {
  buildOAuthConnectConfig,
  ensureEnvBackedOAuthAppProfile,
  getConnectBaseUrl,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
} from '../../helpers/connection-helpers';
import { assertEntityIdsInOrg } from '../../helpers/db-helpers';
import { rejectUnboundAppInstallationCreate } from '../../helpers/app-installation-guard';
import { type FeedDefinition, splitConfigByFeedScope } from '../../helpers/feed-helpers';
import { getScopedConnectorDefinition } from '../../../../catalog/connector-definitions';
import { buildConnectionsUrl } from '../../../../utils/url-builder';
import { getOrgUrlContext } from '../../../view-urls';
import { createConnectToken } from '../../../../utils/connect-tokens';
import { registerConnectorWebhook } from '../../../../connect/webhook-registration';
import { resolveUsernames } from '../../../../utils/resolve-usernames';
import type { ToolContext } from '../../../registry';
import type { ManageConnectionsResult, ConnectionsArgs } from '../schemas';
import { resolveDeviceBinding, isManagedPublicOrgConnect } from './device-binding';
import { getErrorMessage } from "@lobu/core";

export async function handleConnect(
  args: Extract<ConnectionsArgs, { action: 'connect' }>,
  ctx: ToolContext
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
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

  // Reject a direct connect of an UNBOUND app_installation connection (no
  // installation_ref AND no other auth intent) — those are created only by the
  // App install callback. Selection-aware: a connect that supplies an auth
  // profile / app profile / env creds / managedBy resolves to a different method
  // and is allowed through.
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

  const setupUrl = buildSetupUrl({ connectorKey: args.connector_key });

  // Validate an explicit slug up-front (same boundary check create does).
  const explicitSlug = args.slug?.trim();
  if (explicitSlug) {
    const fmtErr = connectionSlugFormatError(explicitSlug);
    if (fmtErr) return { error: fmtErr };
  }

  // Idempotent: reuse an existing pending_auth connection with a valid connect
  // token for the same connector/user. When the caller asked for a specific
  // slug, only reuse a pending row whose slug matches — otherwise we'd hand back
  // a connection under the wrong stable identity, so fall through and create a
  // fresh row with the requested slug instead.
  const pendingRows = await sql`
    SELECT c.id, c.slug, ct.token, ct.expires_at
    FROM connections c
    JOIN connect_tokens ct ON ct.connection_id = c.id
      AND ct.status = 'pending' AND ct.expires_at > NOW()
    WHERE c.organization_id = ${organizationId}
      AND c.connector_key = ${args.connector_key}
      AND c.status = 'pending_auth'
      AND c.deleted_at IS NULL
      ${explicitSlug ? sql`AND c.slug = ${explicitSlug}` : sql``}
      ${deviceBinding.deviceWorkerId ? sql`AND c.device_worker_id = ${deviceBinding.deviceWorkerId}` : sql``}
      ${userId ? sql`AND c.created_by = ${userId}` : sql``}
    ORDER BY ct.created_at DESC
    LIMIT 1
  `;
  if (pendingRows.length > 0) {
    const pending = pendingRows[0] as {
      id: number;
      slug: string;
      token: string;
      expires_at: Date | string;
    };
    const connectUrl = `${getConnectBaseUrl(ctx)}/connect/${pending.token}/oauth/start`;
    return {
      action: 'connect',
      connection_id: pending.id,
      slug: pending.slug,
      status: 'pending_auth',
      auth_type: 'oauth',
      connect_url: connectUrl,
      connect_token: pending.token,
      expires_at: new Date(pending.expires_at).toISOString(),
      instructions: `A pending connection already exists. Send the connect_url to the user to complete OAuth authorization. Poll with action='get' until status='active'.`,
    };
  }

  const authSelection = await resolveConnectionAuthSelection({
    organizationId,
    connectorKey: args.connector_key,
    authSchema: connector.auth_schema,
    authProfileSlug: args.auth_profile_slug,
    appAuthProfileSlug: args.app_auth_profile_slug,
    deviceWorkerId: deviceBinding.deviceWorkerId,
  });

  const hasNoAuth =
    !authSelection.oauthMethod && !authSelection.envMethod && !authSelection.browserMethod;
  const profileDeviceWorkerIdConnect = authSelection.authProfile?.device_worker_id ?? null;
  let effectiveDeviceWorkerIdConnect = deviceBinding.deviceWorkerId;
  if (profileDeviceWorkerIdConnect) {
    if (!effectiveDeviceWorkerIdConnect) {
      effectiveDeviceWorkerIdConnect = profileDeviceWorkerIdConnect;
    } else if (effectiveDeviceWorkerIdConnect !== profileDeviceWorkerIdConnect) {
      return {
        error: `Auth profile '${authSelection.authProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
        setup_url: setupUrl,
      };
    }
  }
  const isDeviceBoundBrowserSessionConnect =
    authSelection.authProfile?.profile_kind === 'browser_session' &&
    !!profileDeviceWorkerIdConnect;
  // Same guard as create-path: when the profile contributed a device we
  // didn't already check against, re-run the duplicate-connection check now
  // so the partial unique index never decides the outcome with a raw error.
  if (effectiveDeviceWorkerIdConnect && effectiveDeviceWorkerIdConnect !== deviceBinding.deviceWorkerId) {
    const dup = (await sql`
      SELECT id FROM connections
      WHERE organization_id = ${organizationId}
        AND connector_key = ${args.connector_key}
        AND device_worker_id = ${effectiveDeviceWorkerIdConnect}
        AND deleted_at IS NULL
      LIMIT 1
    `) as unknown as Array<{ id: number }>;
    if (dup.length > 0) {
      return {
        error: `A ${connector.name} connection (id: ${dup[0].id}) is already assigned to that device in this org.`,
        setup_url: setupUrl,
      };
    }
  }
  const browserProfileUsable =
    authSelection.authProfile?.profile_kind === 'browser_session' &&
    !isDeviceBoundBrowserSessionConnect
      ? (await getBrowserSessionReadiness(authSelection.authProfile.auth_data, args.connector_key))
          .usable
      : false;
  // Device-bound browser_session profiles are "ready" by virtue of the
  // cookies being on disk on the device. `getBrowserSessionReadiness` only
  // looks at server-side auth_data, which is empty for these — without this
  // exemption the connect path rejects them with "select or create a browser
  // auth profile" even when the Mac app just created one.
  const hasReadySelection =
    !!authSelection.authProfile &&
    (authSelection.authProfile.profile_kind === 'browser_session'
      ? isDeviceBoundBrowserSessionConnect || browserProfileUsable
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
    !isDeviceBoundBrowserSessionConnect &&
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

  const connectVisibility = await resolveConnectionVisibility(
    organizationId,
    userId,
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
      setup_url: setupUrl,
    };
  }

  // Managed-connector path: a member connecting a managed connector in a PUBLIC
  // org gets a CONSENT-ONLY connection — it holds the OAuth grant for delegation
  // but has no feeds, so the cloud never syncs a copy (the data lives only on
  // the member's local instance). The consent_only flag lives in the trusted
  // connection `config` (where managedBy lives), and the manage_feeds guard
  // already refuses to create feeds on a consent_only connection.
  const isManagedConnect = authSelection.oauthMethod
    ? await isManagedPublicOrgConnect({
        organizationId,
        connectorKey: args.connector_key,
        provider: authSelection.oauthMethod.provider,
      })
    : false;
  const connectionConfigToInsert =
    isManagedConnect || splitConfig.connectionConfig
      ? {
          ...(splitConfig.connectionConfig ?? {}),
          ...(isManagedConnect ? { consent_only: true } : {}),
        }
      : null;

  // Reject cross-org entity_ids (mirrors handleCreate / manage_feeds).
  try {
    await assertEntityIdsInOrg(sql, organizationId, args.entity_ids);
  } catch (err) {
    return { error: getErrorMessage(err), setup_url: setupUrl };
  }
  const connectEntityIdsValue =
    args.entity_ids && args.entity_ids.length > 0 ? pgBigintArray(args.entity_ids) : null;

  const connectSlugResult = await resolveNewConnectionSlug({
    organizationId,
    connectorKey: args.connector_key,
    explicitSlug: args.slug,
    displayName: connectDisplayName,
  });
  if ('error' in connectSlugResult) return { error: connectSlugResult.error, setup_url: setupUrl };

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape
  let insertedConn: any[];
  try {
    insertedConn = await insertConnectionWithSlug({
      organizationId,
      connectorKey: args.connector_key,
      displayName: connectDisplayName,
      initialSlug: connectSlugResult.slug,
      explicit: !!args.slug?.trim(),
      doInsert: (slug) => sql`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility, device_worker_id,
          entity_ids
        ) VALUES (
          ${organizationId}, ${args.connector_key},
          ${slug},
          ${connectDisplayName},
          ${connectionStatus},
          ${authSelection.authProfile?.id ?? null},
          ${authSelection.appAuthProfile?.id ?? null},
          ${connectionConfigToInsert ? sql.json(connectionConfigToInsert) : null},
          ${userId},
          ${connectVisibility},
          ${effectiveDeviceWorkerIdConnect},
          ${connectEntityIdsValue}::bigint[]
        )
        RETURNING *
      `,
    });
  } catch (err) {
    if (err instanceof ConnectionSlugConflictError) return { error: err.message, setup_url: setupUrl };
    throw err;
  }

  const connection = insertedConn[0] as {
    id: number;
    slug: string;
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

  recordLifecycleEvent({
    organizationId,
    entityType: 'connection',
    op: 'created',
    entityId: connection.id,
    summary: `Connection "${connectDisplayName}" created`,
    extra: { connector_key: args.connector_key, slug: connection.slug, via: 'connect' },
  });

  recordToolConfigChange(ctx, {
    resourceKind: 'connection',
    resourceId: connection.id,
    op: 'created',
    summary: `Connection '${connectDisplayName}' created`,
    state: insertedConn[0] as Record<string, unknown>,
  });

  // If active immediately, return simple result
  if (!needsConnectFlow && !needsBrowserAuth) {
    // Active now with resolvable credentials (env/PAT path) — if the connector
    // declares a webhook block and a feed target is configured, subscribe with
    // the provider once. Best-effort; failures are logged, not fatal.
    await registerConnectorWebhook({ organizationId, connectionId: connection.id });
    return {
      action: 'connect',
      connection_id: connection.id,
      slug: connection.slug,
      status: 'active',
      message: 'Connection created and active.',
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  if (needsBrowserAuth) {
    return {
      action: 'connect',
      connection_id: connection.id,
      slug: connection.slug,
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
    })) ??
    // Auto-provision an env-backed app profile from deployment env vars
    // (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET etc.) — the same client GitHub
    // LOGIN already uses — so connecting a connector whose OAuth app creds are
    // env-configured needs zero manual secret entry. No-op (null) when those
    // env vars are absent, falling through to the original guidance below.
    (await ensureEnvBackedOAuthAppProfile({
      organizationId,
      connectorKey: args.connector_key,
      connectorName: connector.name,
      method: oauthMethod,
      createdBy: userId,
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
    slug: connection.slug,
    status: 'pending_auth',
    auth_type: 'oauth',
    connect_url: connectUrl,
    connect_token: connectToken.token,
    expires_at: new Date(connectToken.expires_at).toISOString(),
    instructions: `Send the connect_url to the user to complete OAuth authorization with ${oauthMethod.provider}. Poll this connection with action='get' until status='active'.`,
  };
}
