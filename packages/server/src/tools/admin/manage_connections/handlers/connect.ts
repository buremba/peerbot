/**
 * Connect action handler: create connection + OAuth flow in one call.
 */

import { randomUUID } from "node:crypto";
import { getDb, pgBigintArray, type DbClient } from "../../../../db/client";
import { notifyConnectionPermissionRequest } from "../../../../notifications/triggers";
import {
	getPrimaryAuthProfileForKind,
	getBrowserSessionReadiness,
	createAuthProfile,
} from "../../../../utils/auth-profiles";
import {
  ConnectionSlugConflictError,
  connectionSlugFormatError,
  insertConnectionWithSlug,
  resolveNewConnectionSlug,
} from "../../../../utils/connections";
import { recordLifecycleEvent } from "../../../../utils/insert-event";
import { recordToolConfigChange } from "../../helpers/config-audit";
import logger from "../../../../utils/logger";
import { ensureConnectorInstalled } from "../../../../utils/ensure-connector-installed";
import {
  buildOAuthConnectConfig,
  ensureEnvBackedOAuthAppProfile,
  getConnectBaseUrl,
	getInteractiveMethods,
  resolveConnectionAuthSelection,
  resolveConnectionDisplayName,
  resolveConnectionVisibility,
} from "../../helpers/connection-helpers";
import { assertEntityIdsInOrg } from "../../helpers/db-helpers";
import {
  buildAppInstallationSetupUrl,
  rejectUnboundAppInstallationCreate,
} from "../../helpers/app-installation-guard";
import { buildOAuthAppProfileSetupError } from "../../helpers/connector-setup-errors";
import {
	type FeedDefinition,
	splitConfigByFeedScope,
} from "../../helpers/feed-helpers";
import { getScopedConnectorDefinition } from "../../../../catalog/connector-definitions";
import { buildConnectionsUrl } from "../../../../utils/url-builder";
import { getOrgUrlContext } from "../../../view-urls";
import { createConnectToken } from "../../../../utils/connect-tokens";
import { registerConnectorWebhook } from "../../../../connect/webhook-registration";
import { createAuthRun } from "../../../../runs/queue-service";
import { resolveUsernames } from "../../../../utils/resolve-usernames";
import type { ToolContext } from "../../../registry";
import type { ManageConnectionsResult, ConnectionsArgs } from "../schemas";
import {
	resolveDeviceBinding,
	isManagedPublicOrgConnect,
} from "./device-binding";
import { getErrorMessage } from "@lobu/core";
import {
	activeConnectionPoll,
	appendSetupAttemptId,
	buildConnectionSetupContinuation,
	buildSafeConnectionResumeCall,
	installedConnectorPoll,
	type ConnectionSetupFamily,
	type ConnectionSetupNextAction,
} from "../../helpers/connect-setup-continuation";

export async function handleConnect(
	args: Extract<ConnectionsArgs, { action: "connect" }>,
	ctx: ToolContext,
): Promise<ManageConnectionsResult> {
  const sql = getDb();
  const { organizationId, userId } = ctx;
	const resumeCall = buildSafeConnectionResumeCall(
		"connections.connect",
		args,
	);

  const { ownerSlug, baseUrl } = await getOrgUrlContext(ctx);
  const buildSetupUrl = (opts?: { connectorKey?: string; install?: string }) =>
    ownerSlug && baseUrl
      ? buildConnectionsUrl(
          ownerSlug,
          baseUrl,
          opts?.connectorKey,
					opts?.install ? { install: opts.install } : undefined,
        )
      : undefined;

  // Ensure connector is installed from bundled catalog if needed
	await ensureConnectorInstalled({
		organizationId,
		connectorKey: args.connector_key,
	});

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

  const setupUrl = buildSetupUrl({ connectorKey: args.connector_key });

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
    gatewayBaseUrl: getConnectBaseUrl(ctx),
    setupUrl,
  });
  if (appInstallGuard) {
		const setupAttemptId =
			appInstallGuard.provider === "github" && appInstallGuard.install_url
				? randomUUID()
				: undefined;
		// Setup-required continuation: the App install callback creates the active
		// connection itself, so do NOT instruct a retry of connect. The guard's
		// ConnectorSetupError already carries the absolute install_url.
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: "app_installation",
			nextAction:
				appInstallGuard.next_action === "install_app"
					? "install_app"
					: "open_setup",
			instructions: appInstallGuard.error,
			errorCode: appInstallGuard.error_code,
			installType: appInstallGuard.install_type,
			...(appInstallGuard.install_shape
				? { installShape: appInstallGuard.install_shape }
				: {}),
			...(appInstallGuard.setup_instructions
				? { setupInstructions: appInstallGuard.setup_instructions }
				: {}),
			...(setupAttemptId
				? {
						completionCheck: installedConnectorPoll(
							args.connector_key,
							setupAttemptId,
						),
						setupAttemptId,
					}
				: {}),
			setupUrl: await buildAppInstallationSetupUrl(ctx, args.connector_key),
			...(appInstallGuard.install_url
				? {
						installUrl: setupAttemptId
							? appendSetupAttemptId(
									appInstallGuard.install_url,
									setupAttemptId,
								)
							: appInstallGuard.install_url,
					}
				: {}),
			...(appInstallGuard.provider
				? { provider: appInstallGuard.provider }
				: {}),
		});
  }

  const deviceBinding = await resolveDeviceBinding({
    organizationId,
    userId,
    connector,
    deviceWorkerId: args.device_worker_id,
  });
	if ("error" in deviceBinding) {
		if (connector.required_capability && !args.device_worker_id) {
			return buildConnectionSetupContinuation({
				action: "connect",
				connectorKey: args.connector_key,
				setupFamily: "device_bound",
				nextAction: "connect_device",
				instructions: deviceBinding.error,
				setupUrl,
			});
		}
		return deviceBinding;
	}
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
			action: "connect",
      connection_id: pending.id,
      slug: pending.slug,
			status: "pending_auth",
			auth_type: "oauth",
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
		!authSelection.oauthMethod &&
		!authSelection.envMethod &&
		!authSelection.browserMethod;
	const profileDeviceWorkerIdConnect =
		authSelection.authProfile?.device_worker_id ?? null;
  let effectiveDeviceWorkerIdConnect = deviceBinding.deviceWorkerId;
  if (profileDeviceWorkerIdConnect) {
    if (!effectiveDeviceWorkerIdConnect) {
      effectiveDeviceWorkerIdConnect = profileDeviceWorkerIdConnect;
		} else if (
			effectiveDeviceWorkerIdConnect !== profileDeviceWorkerIdConnect
		) {
      return {
        error: `Auth profile '${authSelection.authProfile!.slug}' lives on a different device than the one selected; pick that device or a different profile.`,
        setup_url: setupUrl,
      };
    }
  }
  const isDeviceBoundBrowserSessionConnect =
		authSelection.authProfile?.profile_kind === "browser_session" &&
    !!profileDeviceWorkerIdConnect;
  // Same guard as create-path: when the profile contributed a device we
  // didn't already check against, re-run the duplicate-connection check now
  // so the partial unique index never decides the outcome with a raw error.
	if (
		effectiveDeviceWorkerIdConnect &&
		effectiveDeviceWorkerIdConnect !== deviceBinding.deviceWorkerId
	) {
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
		authSelection.authProfile?.profile_kind === "browser_session" &&
    !isDeviceBoundBrowserSessionConnect
			? (
					await getBrowserSessionReadiness(
						authSelection.authProfile.auth_data,
						args.connector_key,
					)
				).usable
      : false;
  // Device-bound browser_session profiles are "ready" by virtue of the
  // cookies being on disk on the device. `getBrowserSessionReadiness` only
  // looks at server-side auth_data, which is empty for these — without this
  // exemption the connect path rejects them with "select or create a browser
  // auth profile" even when the Mac app just created one.
  const hasReadySelection =
    !!authSelection.authProfile &&
		(authSelection.authProfile.profile_kind === "browser_session"
      ? isDeviceBoundBrowserSessionConnect || browserProfileUsable
			: authSelection.authProfile.status === "active") &&
		(authSelection.selectedKind !== "oauth_account" ||
			(authSelection.appAuthProfile?.status === "active" &&
				!!authSelection.appAuthProfile));

  const needsConnectFlow =
		authSelection.preferredMethodType === "oauth" &&
    !!authSelection.oauthMethod &&
    !hasReadySelection &&
    !args.auth_profile_slug;
  const needsBrowserAuth =
    !!authSelection.browserMethod &&
    !!authSelection.authProfile &&
		authSelection.authProfile.profile_kind === "browser_session" &&
    !isDeviceBoundBrowserSessionConnect &&
    !browserProfileUsable;
	// Interactive-auth connectors (e.g. WhatsApp QR) bypass standard auth-profile
	// selection: the connection starts pending_auth and an auth run drives the
	// interactive pairing. Without this, an interactive connector looks like
	// no-auth (oauth/env/browser methods all absent) and connect would wrongly
	// create an ACTIVE, unauthenticated connection.
	const interactiveMethod =
		getInteractiveMethods(connector.auth_schema)[0] ?? null;
	const isInteractiveConnect = !!interactiveMethod && !hasReadySelection;
	const connectionStatus =
		needsConnectFlow || needsBrowserAuth || isInteractiveConnect
			? "pending_auth"
			: "active";

	if (isInteractiveConnect && !userId) {
    return {
			error: "Interactive pairing requires an authenticated user.",
      setup_url: setupUrl,
    };
  }

	if (
		!hasNoAuth &&
		!needsConnectFlow &&
		!needsBrowserAuth &&
		!hasReadySelection &&
		!isInteractiveConnect
	) {
		// Setup-required continuation: a known auth method needs a profile/config
		// the caller hasn't supplied. Non-terminal — the caller fixes it then retries.
		const family: ConnectionSetupFamily = authSelection.browserMethod
			? "browser"
			: authSelection.envMethod
				? "env_keys"
				: "oauth";
		const nextAction: ConnectionSetupNextAction = authSelection.browserMethod
			? "pair_browser"
			: "select_auth_profile";
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: family,
			nextAction,
			instructions: authSelection.browserMethod
				? "Select or create a browser auth profile before connecting."
				: authSelection.oauthMethod &&
						authSelection.selectedKind !== "oauth_account"
					? "Select or create an OAuth account profile before connecting."
					: authSelection.envMethod
						? "Select or create an auth profile (or pass env credentials) before connecting."
						: "Selected auth profile is not ready yet.",
			setupUrl,
			resumeCall,
		});
	}

  // Create the connection
  const connectDisplayName = await resolveConnectionDisplayName({
    explicitName: args.display_name,
    connectorName: connector.name,
    username: userId
      ? ((
					(
						await resolveUsernames([{ created_by: userId }], "created_by")
					)[0] as {
            created_by_username?: string;
          }
        )?.created_by_username ?? null)
      : null,
  });

  const connectVisibility = await resolveConnectionVisibility(
    organizationId,
    userId,
		authSelection?.authProfile?.profile_kind,
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
		connectorFeedsSchema,
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
		args.entity_ids && args.entity_ids.length > 0
			? pgBigintArray(args.entity_ids)
			: null;

  const connectSlugResult = await resolveNewConnectionSlug({
    organizationId,
    connectorKey: args.connector_key,
    explicitSlug: args.slug,
    displayName: connectDisplayName,
  });
	if ("error" in connectSlugResult)
		return { error: connectSlugResult.error, setup_url: setupUrl };

	const insertConnection = (
		db: DbClient,
		authProfileId: number | null,
		useSavepoint: boolean,
	) =>
		insertConnectionWithSlug({
      organizationId,
      connectorKey: args.connector_key,
      displayName: connectDisplayName,
      initialSlug: connectSlugResult.slug,
      explicit: !!args.slug?.trim(),
			db,
			doInsert: (slug) => {
				const insert = () => db`
        INSERT INTO connections (
          organization_id, connector_key, slug, display_name, status,
          auth_profile_id, app_auth_profile_id, config, created_by, visibility, device_worker_id,
          entity_ids
        ) VALUES (
          ${organizationId}, ${args.connector_key},
          ${slug},
          ${connectDisplayName},
          ${connectionStatus},
            ${authProfileId ?? authSelection.authProfile?.id ?? null},
          ${authSelection.appAuthProfile?.id ?? null},
            ${connectionConfigToInsert ? db.json(connectionConfigToInsert) : null},
          ${userId},
          ${connectVisibility},
          ${effectiveDeviceWorkerIdConnect},
          ${connectEntityIdsValue}::bigint[]
        )
        RETURNING *
        `;
				return useSavepoint ? db.savepoint(insert) : insert();
			},
    });

	// Profile, connection, and auth run are one durable unit. A failed run
	// creation rolls back both rows, so another replica can never observe an
	// orphaned pending connection that has no pairing work queued.
	let insertedConn: Record<string, unknown>[];
	let interactiveAuthRunId: number | null = null;
	try {
		if (isInteractiveConnect) {
			const bundle = await sql.begin(async (tx) => {
				const profile = await createAuthProfile(
					{
						organizationId,
						connectorKey: args.connector_key,
						displayName: `${connectDisplayName} (pairing)`,
						slug: `${args.connector_key}-interactive-${Date.now()}`,
						profileKind: "interactive",
						authData: {},
						status: "pending_auth",
						createdBy: userId,
					},
					tx,
				);
				const rows = await insertConnection(tx, profile.id, true);
				const authRunId = await createAuthRun(
					{
						organizationId,
						connectorKey: args.connector_key,
						authProfileId: profile.id,
						createdByUserId: userId!,
					},
					tx,
				);
				return { rows, authRunId };
			});
			insertedConn = bundle.rows as Record<string, unknown>[];
			interactiveAuthRunId = bundle.authRunId;
		} else {
			insertedConn = (await insertConnection(sql, null, false)) as Record<
				string,
				unknown
			>[];
		}
  } catch (err) {
		if (err instanceof ConnectionSlugConflictError)
			return { error: err.message, setup_url: setupUrl };
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
		"Connection created via connect flow",
  );

  recordLifecycleEvent({
    organizationId,
		entityType: "connection",
		op: "created",
    entityId: connection.id,
    summary: `Connection "${connectDisplayName}" created`,
		extra: {
			connector_key: args.connector_key,
			slug: connection.slug,
			via: "connect",
		},
  });

  recordToolConfigChange(ctx, {
		resourceKind: "connection",
    resourceId: connection.id,
		op: "created",
    summary: `Connection '${connectDisplayName}' created`,
    state: insertedConn[0] as Record<string, unknown>,
  });

	// Interactive pairing: the connection is pending_auth with a fresh
	// interactive profile. Kick off the auth run (the lifecycle that emits QR /
	// code artifacts) and return a setup_required continuation. The auth run —
	// not a connect retry — completes the connection.
	if (isInteractiveConnect) {
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: "interactive",
			nextAction: "pair_interactive",
			instructions:
				"Connection created as pending_auth. Complete interactive pairing (e.g. scan the QR code) via the auth run, then poll connections.get until status=active.",
			setupUrl: buildSetupUrl({ connectorKey: args.connector_key }),
			connectionId: connection.id,
			slug: connection.slug,
			completionCheck: activeConnectionPoll(connection.id),
			authRunId: interactiveAuthRunId!,
		});
	}

  // If active immediately, return simple result
  if (!needsConnectFlow && !needsBrowserAuth) {
    // Active now with resolvable credentials (env/PAT path) — if the connector
    // declares a webhook block and a feed target is configured, subscribe with
    // the provider once. Best-effort; failures are logged, not fatal.
		await registerConnectorWebhook({
			organizationId,
			connectionId: connection.id,
		});
    return {
			action: "connect",
      connection_id: connection.id,
      slug: connection.slug,
			status: "active",
			message: "Connection created and active.",
      view_url: buildSetupUrl({ connectorKey: args.connector_key }),
    };
  }

  if (needsBrowserAuth) {
    return {
			action: "connect",
      connection_id: connection.id,
      slug: connection.slug,
			status: "pending_auth",
			auth_type: "browser",
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
		// Reached when a non-oauth method still needs setup (e.g. browser pairing
		// whose profile wasn't ready). Surface a continuation, not a prose error.
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: authSelection.browserMethod ? "browser" : "env_keys",
			nextAction: authSelection.browserMethod
				? "pair_browser"
				: "select_auth_profile",
			instructions:
				"This connection still needs an auth profile or pairing step before it can run. Complete it, then retry connect.",
			setupUrl,
			resumeCall,
		});
  }

  const oauthMethod = authSelection.oauthMethod;
  const appAuthProfile =
    authSelection.appAuthProfile ??
    (await getPrimaryAuthProfileForKind({
      organizationId,
      connectorKey: args.connector_key,
			profileKind: "oauth_app",
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

	if (!appAuthProfile || appAuthProfile.status !== "active") {
    await rollbackConnection();

		const setupError = buildOAuthAppProfileSetupError({
      connectorKey: args.connector_key,
      method: oauthMethod,
      setupUrl,
    });
		// OAuth app credentials are a setup step, not a business error. Surface a
		// continuation so an agent can read next_action and drive the admin to
		// configure the OAuth app, then retry connect.
		return buildConnectionSetupContinuation({
			action: "connect",
			connectorKey: args.connector_key,
			setupFamily: "oauth",
			nextAction: "configure_oauth_app",
			instructions: setupError.setup_instructions
				? `${setupError.error} ${setupError.setup_instructions}`
				: setupError.error,
			setupUrl: setupError.setup_url ?? setupUrl,
			provider: oauthMethod.provider,
			errorCode: setupError.error_code,
			installType: setupError.install_type,
			...(setupError.setup_instructions
				? { setupInstructions: setupError.setup_instructions }
				: {}),
			resumeCall,
		});
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
		authType: "oauth",
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
	}).catch((err) =>
		logger.error(err, "Failed to send connection permission notification"),
	);

  return {
		action: "connect",
    connection_id: connection.id,
    slug: connection.slug,
		status: "pending_auth",
		auth_type: "oauth",
    connect_url: connectUrl,
    connect_token: connectToken.token,
    expires_at: new Date(connectToken.expires_at).toISOString(),
    instructions: `Send the connect_url to the user to complete OAuth authorization with ${oauthMethod.provider}. Poll this connection with action='get' until status='active'.`,
  };
}
