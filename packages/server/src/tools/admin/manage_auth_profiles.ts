/**
 * Tool: manage_auth_profiles
 *
 * Manage reusable auth profiles for connector authentication.
 *
 * Actions:
 * - list_auth_profiles: List reusable auth profiles
 * - get_auth_profile: Get a reusable auth profile
 * - test_auth_profile: Test a reusable auth profile
 * - create_auth_profile: Create a reusable auth profile
 * - update_auth_profile: Update a reusable auth profile
 * - delete_auth_profile: Delete a reusable auth profile
 */

import { type Static, Type } from '@sinclair/typebox';
import { getDb } from '../../db/client';
import type { Env } from '../../index';
import {
  type AuthProfileKind,
  type AuthProfileStatus,
  createAuthProfile,
  deleteAuthProfile,
  getAuthProfileBySlug,
  getBrowserSessionReadiness,
  listAuthProfiles,
  normalizeAuthProfileSlug,
  normalizeAuthValues,
  summarizeBrowserSessionAuthData,
  updateAuthProfile,
} from '../../utils/auth-profiles';
import { createConnectToken } from '../../utils/connect-tokens';
import type { ToolContext } from '../registry';
import { routeAction } from './action-router';
import { getScopedConnectorDefinition } from './connector-definition-helpers';
import {
  buildOAuthConnectConfig,
  getBrowserMethods,
  getConnectBaseUrl,
  getEnvKeyMethods,
  getOAuthCredentialKeys,
  getOAuthMethods,
  resolveRequestedOAuthScopes,
  serializeAuthProfile,
} from './helpers/connection-helpers';

// ============================================
// Schema
// ============================================

const ListAuthProfilesAction = Type.Object({
  action: Type.Literal('list_auth_profiles'),
  connector_key: Type.Optional(Type.String({ description: 'Filter by connector key' })),
  provider: Type.Optional(Type.String({ description: 'Filter by OAuth provider (e.g. "google")' })),
  profile_kind: Type.Optional(
    Type.Union([
      Type.Literal('env'),
      Type.Literal('oauth_app'),
      Type.Literal('oauth_account'),
      Type.Literal('browser_session'),
    ])
  ),
});

const GetAuthProfileAction = Type.Object({
  action: Type.Literal('get_auth_profile'),
  auth_profile_slug: Type.String({ description: 'Auth profile slug' }),
});

const TestAuthProfileAction = Type.Object({
  action: Type.Literal('test_auth_profile'),
  auth_profile_slug: Type.String({ description: 'Auth profile slug' }),
});

const CreateAuthProfileAction = Type.Object({
  action: Type.Literal('create_auth_profile'),
  connector_key: Type.String({ description: 'Connector key (e.g. x, google.gmail)' }),
  profile_kind: Type.Union([
    Type.Literal('env'),
    Type.Literal('oauth_app'),
    Type.Literal('oauth_account'),
    Type.Literal('browser_session'),
  ]),
  display_name: Type.String({ description: 'User-facing auth profile name' }),
  slug: Type.Optional(
    Type.String({ description: 'Stable public identifier for the auth profile' })
  ),
  credentials: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Schema-driven auth values for env or OAuth app profiles',
    })
  ),
  auth_data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: 'Raw auth/session payload for browser-backed profiles',
    })
  ),
  requested_scopes: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional OAuth scopes selected in addition to the connector required scopes.',
    })
  ),
});

const UpdateAuthProfileAction = Type.Object({
  action: Type.Literal('update_auth_profile'),
  auth_profile_slug: Type.String({ description: 'Existing auth profile slug' }),
  display_name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String({ description: 'New auth profile slug' })),
  credentials: Type.Optional(Type.Record(Type.String(), Type.String())),
  auth_data: Type.Optional(Type.Record(Type.String(), Type.Any())),
  requested_scopes: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Optional OAuth scopes selected in addition to the connector required scopes.',
    })
  ),
  status: Type.Optional(Type.String({ description: 'active, pending_auth, error, revoked' })),
  reconnect: Type.Optional(
    Type.Boolean({
      description:
        'Re-issue a connect token for an oauth_account profile. Returns connect_url for re-authorization.',
    })
  ),
});

const DeleteAuthProfileAction = Type.Object({
  action: Type.Literal('delete_auth_profile'),
  auth_profile_slug: Type.String({ description: 'Auth profile slug to delete' }),
  force: Type.Optional(
    Type.Boolean({ description: 'Force delete even if active connections reference this profile' })
  ),
});

export const ManageAuthProfilesSchema = Type.Union([
  ListAuthProfilesAction,
  GetAuthProfileAction,
  TestAuthProfileAction,
  CreateAuthProfileAction,
  UpdateAuthProfileAction,
  DeleteAuthProfileAction,
]);

// ============================================
// Result Types
// ============================================

type ManageAuthProfilesResult =
  | { error: string }
  | { action: 'list_auth_profiles'; auth_profiles: any[] }
  | { action: 'get_auth_profile'; auth_profile: any }
  | {
      action: 'test_auth_profile';
      status: 'ok' | 'warning' | 'error';
      message: string;
      expires_at?: string | null;
      cookie_count?: number;
      auth_cookie_name?: string | null;
      is_expired?: boolean;
      cdp_url?: string | null;
      auth_mode?: 'cdp' | 'cookies' | 'empty';
    }
  | {
      action: 'create_auth_profile';
      auth_profile?: any;
      pending_slug?: string;
      connect_url?: string;
      connect_token?: string;
    }
  | { action: 'update_auth_profile'; auth_profile: any; connect_url?: string }
  | { action: 'delete_auth_profile'; deleted: true; auth_profile_slug: string };

type AuthProfilesArgs = Static<typeof ManageAuthProfilesSchema>;

// ============================================
// Main Function (Action Router)
// ============================================

export async function manageAuthProfiles(
  args: AuthProfilesArgs,
  _env: Env,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  return routeAction<ManageAuthProfilesResult>('manage_auth_profiles', args.action, ctx, {
    list_auth_profiles: () =>
      handleListAuthProfiles(
        args as Extract<AuthProfilesArgs, { action: 'list_auth_profiles' }>,
        ctx
      ),
    get_auth_profile: () =>
      handleGetAuthProfile(args as Extract<AuthProfilesArgs, { action: 'get_auth_profile' }>, ctx),
    test_auth_profile: () =>
      handleTestAuthProfile(
        args as Extract<AuthProfilesArgs, { action: 'test_auth_profile' }>,
        ctx
      ),
    create_auth_profile: () =>
      handleCreateAuthProfile(
        args as Extract<AuthProfilesArgs, { action: 'create_auth_profile' }>,
        ctx
      ),
    update_auth_profile: () =>
      handleUpdateAuthProfile(
        args as Extract<AuthProfilesArgs, { action: 'update_auth_profile' }>,
        ctx
      ),
    delete_auth_profile: () =>
      handleDeleteAuthProfile(
        args as Extract<AuthProfilesArgs, { action: 'delete_auth_profile' }>,
        ctx
      ),
  });
}

// ============================================
// Action Handlers
// ============================================

async function handleListAuthProfiles(
  args: Extract<AuthProfilesArgs, { action: 'list_auth_profiles' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfiles = await listAuthProfiles({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key ?? null,
    profileKind: (args.profile_kind as AuthProfileKind | undefined) ?? null,
    provider: args.provider ?? null,
  });

  return {
    action: 'list_auth_profiles',
    auth_profiles: authProfiles.map(serializeAuthProfile),
  };
}

async function handleGetAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'get_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfile = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  return {
    action: 'get_auth_profile',
    auth_profile: serializeAuthProfile(authProfile),
  };
}

async function handleTestAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'test_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const authProfile = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  if (authProfile.profile_kind === 'browser_session') {
    const summary = summarizeBrowserSessionAuthData(
      authProfile.auth_data,
      authProfile.connector_key
    );
    if (summary.cdp_url) {
      const readiness = await getBrowserSessionReadiness(
        authProfile.auth_data,
        authProfile.connector_key
      );
      return {
        action: 'test_auth_profile',
        status: readiness.usable ? 'ok' : 'warning',
        message: readiness.usable
          ? `Browser session profile '${authProfile.slug}' CDP endpoint reachable`
          : `Browser session profile '${authProfile.slug}' CDP configured but endpoint not responding at ${summary.cdp_url}`,
        ...summary,
        cdp_url: readiness.resolved_cdp_url ?? summary.cdp_url,
      };
    }
    if (summary.cookie_count === 0) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `Browser session profile '${authProfile.slug}' has no cookies`,
        ...summary,
      };
    }
    if (!summary.auth_cookie_name) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `Browser session profile '${authProfile.slug}' has cookies but no likely auth cookie`,
        ...summary,
      };
    }
    return {
      action: 'test_auth_profile',
      status: summary.is_expired ? 'error' : 'ok',
      message: summary.is_expired
        ? `${summary.auth_cookie_name} expired`
        : `${summary.auth_cookie_name} valid`,
      ...summary,
    };
  }

  if (authProfile.profile_kind === 'oauth_account') {
    const sql = getDb();
    if (!authProfile.account_id) {
      return {
        action: 'test_auth_profile',
        status: 'warning',
        message: `OAuth account profile '${authProfile.slug}' is not linked yet`,
      };
    }

    const rows = await sql`
      SELECT "accessToken" IS NOT NULL AS has_token,
             "accessTokenExpiresAt",
             "refreshToken" IS NOT NULL AS has_refresh
      FROM "account"
      WHERE id = ${authProfile.account_id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return {
        action: 'test_auth_profile',
        status: 'error',
        message: `OAuth account profile '${authProfile.slug}' is linked to a missing account`,
      };
    }

    const account = rows[0] as {
      has_token: boolean;
      accessTokenExpiresAt: string | null;
      has_refresh: boolean;
    };
    if (!account.has_token) {
      return {
        action: 'test_auth_profile',
        status: 'error',
        message: `OAuth account profile '${authProfile.slug}' has no access token`,
      };
    }

    const expiresAt = account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt).toISOString()
      : null;
    const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
    return {
      action: 'test_auth_profile',
      status: isExpired && !account.has_refresh ? 'error' : 'ok',
      message: isExpired
        ? account.has_refresh
          ? 'Token expired but refresh token available'
          : 'Token expired and no refresh token'
        : 'Credentials valid',
      expires_at: expiresAt,
    };
  }

  const authValues = normalizeAuthValues(authProfile.auth_data);
  const hasKeys = Object.keys(authValues).length > 0;
  return {
    action: 'test_auth_profile',
    status: hasKeys ? 'ok' : 'warning',
    message: hasKeys
      ? `Auth profile '${authProfile.slug}' configured`
      : `Auth profile '${authProfile.slug}' has no credentials`,
  };
}

async function syncConnectionsForBrowserAuthProfile(
  organizationId: string,
  authProfileId: number,
  active: boolean
): Promise<void> {
  const sql = getDb();
  const nextConnectionStatus = active ? 'active' : 'pending_auth';
  const nextFeedStatus = active ? 'active' : 'paused';
  const nextRunAtValue = active ? sql`NOW()` : sql`NULL`;

  await sql`
    UPDATE connections
    SET status = ${nextConnectionStatus},
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND auth_profile_id = ${authProfileId}
  `;

  await sql`
    UPDATE feeds f
    SET status = ${nextFeedStatus},
        next_run_at = ${nextRunAtValue},
        updated_at = NOW()
    FROM connections c
    WHERE f.connection_id = c.id
      AND c.organization_id = ${organizationId}
      AND c.auth_profile_id = ${authProfileId}
  `;
}

async function handleCreateAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'create_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const connector = await getScopedConnectorDefinition({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key,
  });

  if (!connector) {
    return { error: `Connector '${args.connector_key}' not found or not active` };
  }

  if (args.profile_kind === 'oauth_account') {
    const oauthMethod = getOAuthMethods(connector.auth_schema)[0];
    if (!oauthMethod) {
      return { error: `Connector '${args.connector_key}' does not support OAuth account profiles` };
    }

    // Don't create the profile yet — store metadata in the connect token and
    // create the real profile as active in the OAuth callback.
    const pendingSlug = normalizeAuthProfileSlug(
      args.slug,
      args.display_name || `${connector.name} ${oauthMethod.provider} Account`
    );

    const requestedScopes = resolveRequestedOAuthScopes(oauthMethod, args.requested_scopes);
    const connectToken = await createConnectToken({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
      authType: 'oauth',
      authConfig: {
        ...buildOAuthConnectConfig(oauthMethod, requestedScopes),
        requestedScopes,
        pendingProfileMeta: {
          displayName: args.display_name || `${connector.name} ${oauthMethod.provider} Account`,
          slug: pendingSlug,
          connectorKey: args.connector_key,
          provider: oauthMethod.provider,
        },
      },
      createdBy: ctx.userId,
    });

    return {
      action: 'create_auth_profile',
      pending_slug: pendingSlug,
      connect_url: `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`,
      connect_token: connectToken.token,
    };
  }

  if (args.profile_kind === 'browser_session') {
    const browserMethod = getBrowserMethods(connector.auth_schema)[0];
    if (!browserMethod) {
      return { error: `Connector '${args.connector_key}' does not support browser auth profiles` };
    }

    const authData =
      browserMethod.capture === 'cdp'
        ? {
            cdp_url:
              typeof args.auth_data?.cdp_url === 'string' &&
              args.auth_data.cdp_url.trim().length > 0
                ? args.auth_data.cdp_url.trim()
                : browserMethod.defaultCdpUrl || 'auto',
          }
        : ((args.auth_data as Record<string, unknown> | undefined) ?? {});
    const browserSessionReady =
      browserMethod.capture === 'cdp'
        ? (await getBrowserSessionReadiness(authData, args.connector_key)).usable
        : false;

    const authProfile = await createAuthProfile({
      organizationId: ctx.organizationId,
      connectorKey: args.connector_key,
      displayName: args.display_name,
      slug: args.slug,
      profileKind: 'browser_session',
      authData,
      status: browserSessionReady ? 'active' : 'pending_auth',
      createdBy: ctx.userId ?? 'api',
    });

    return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
  }

  const credentials = normalizeAuthValues(args.credentials ?? {});
  if (Object.keys(credentials).length === 0) {
    const expectedKeys: string[] = [];
    if (args.profile_kind === 'oauth_app') {
      const oauthMethod = getOAuthMethods(connector.auth_schema)[0];
      if (oauthMethod) {
        const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(oauthMethod);
        expectedKeys.push(clientIdKey, clientSecretKey);
      }
    } else {
      const envMethod = getEnvKeyMethods(connector.auth_schema)[0];
      if (envMethod?.fields) {
        for (const field of envMethod.fields) {
          if (field.required !== false) expectedKeys.push(field.key);
        }
      }
    }
    const hint = expectedKeys.length > 0 ? ` Expected keys: ${expectedKeys.join(', ')}` : '';
    return { error: `Credentials are required for ${args.profile_kind} auth profiles.${hint}` };
  }

  const provider =
    args.profile_kind === 'oauth_app'
      ? (getOAuthMethods(connector.auth_schema)[0]?.provider ?? null)
      : null;

  const authProfile = await createAuthProfile({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key,
    displayName: args.display_name,
    slug: args.slug,
    profileKind: args.profile_kind,
    authData: credentials,
    provider,
    createdBy: ctx.userId ?? 'api',
  });

  return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleUpdateAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'update_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  let authProfile = await updateAuthProfile({
    organizationId: ctx.organizationId,
    slug: args.auth_profile_slug,
    displayName: args.display_name,
    nextSlug: args.slug,
    authData:
      args.auth_data !== undefined
        ? (args.auth_data as Record<string, unknown>)
        : args.credentials
          ? normalizeAuthValues(args.credentials)
          : undefined,
    status: args.status as AuthProfileStatus | undefined,
  });

  if (!authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  const authProfileProvider = authProfile.provider;

  if (
    authProfile.profile_kind === 'oauth_account' &&
    authProfileProvider &&
    args.requested_scopes
  ) {
    const connector = await getScopedConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: authProfile.connector_key,
    });
    const oauthMethod = connector
      ? getOAuthMethods(connector.auth_schema).find((m) => m.provider === authProfileProvider)
      : undefined;

    if (oauthMethod) {
      const requestedScopes = resolveRequestedOAuthScopes(oauthMethod, args.requested_scopes);
      authProfile =
        (await updateAuthProfile({
          organizationId: ctx.organizationId,
          slug: authProfile.slug,
          authData: {
            ...(authProfile.auth_data ?? {}),
            requested_scopes: requestedScopes,
          },
        })) ?? authProfile;
    }
  }

  if (args.reconnect && authProfile.profile_kind === 'oauth_account' && authProfileProvider) {
    const connector = await getScopedConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: authProfile.connector_key,
    });
    const oauthMethod = connector
      ? getOAuthMethods(connector.auth_schema).find((m) => m.provider === authProfileProvider)
      : undefined;

    if (oauthMethod) {
      const requestedScopes = resolveRequestedOAuthScopes(
        oauthMethod,
        args.requested_scopes ??
          (authProfile.auth_data?.requested_scopes as string[] | undefined) ??
          undefined
      );
      authProfile =
        (await updateAuthProfile({
          organizationId: ctx.organizationId,
          slug: authProfile.slug,
          authData: {
            ...(authProfile.auth_data ?? {}),
            requested_scopes: requestedScopes,
          },
        })) ?? authProfile;

      const connectToken = await createConnectToken({
        organizationId: ctx.organizationId,
        authProfileId: authProfile.id,
        connectorKey: authProfile.connector_key,
        authType: 'oauth',
        authConfig: {
          ...buildOAuthConnectConfig(oauthMethod, requestedScopes),
          requestedScopes,
        },
        createdBy: ctx.userId,
      });

      return {
        action: 'update_auth_profile',
        auth_profile: serializeAuthProfile(authProfile),
        connect_url: `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`,
      };
    }
  }

  if (authProfile.profile_kind === 'browser_session') {
    const browserSessionReady = await getBrowserSessionReadiness(
      authProfile.auth_data,
      authProfile.connector_key
    );
    const nextStatus = browserSessionReady.usable ? 'active' : 'pending_auth';
    if (authProfile.status !== nextStatus) {
      authProfile =
        (await updateAuthProfile({
          organizationId: ctx.organizationId,
          slug: authProfile.slug,
          status: nextStatus,
        })) ?? authProfile;
    }
    await syncConnectionsForBrowserAuthProfile(
      ctx.organizationId,
      authProfile.id,
      browserSessionReady.usable
    );
  }

  return { action: 'update_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleDeleteAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'delete_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  const sql = getDb();
  const existing = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
  if (!existing) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  // Check if active connections reference this profile
  const usageRows = await sql`
    SELECT COUNT(*)::int AS count
    FROM connections
    WHERE organization_id = ${ctx.organizationId}
      AND (auth_profile_id = ${existing.id} OR app_auth_profile_id = ${existing.id})
      AND status != 'revoked'
      AND deleted_at IS NULL
  `;
  const usageCount = (usageRows[0] as { count: number }).count;
  if (usageCount > 0 && !args.force) {
    return {
      error: `Auth profile '${args.auth_profile_slug}' is used by ${usageCount} active connection(s). Pass force: true to delete anyway.`,
    };
  }

  // Clean up connect tokens referencing this profile
  await sql`
    UPDATE connect_tokens
    SET auth_profile_id = NULL
    WHERE auth_profile_id = ${existing.id}
  `;

  // Pause browser-backed connections BEFORE deleting (ON DELETE SET NULL would orphan them)
  if (existing.profile_kind === 'browser_session') {
    await syncConnectionsForBrowserAuthProfile(ctx.organizationId, existing.id, false);
  }

  const deleted = await deleteAuthProfile(ctx.organizationId, args.auth_profile_slug);
  if (!deleted) {
    return { error: `Failed to delete auth profile '${args.auth_profile_slug}'` };
  }

  return {
    action: 'delete_auth_profile',
    deleted: true,
    auth_profile_slug: args.auth_profile_slug,
  };
}
