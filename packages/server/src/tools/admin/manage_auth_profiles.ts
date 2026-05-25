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
  revokeOAuthAppProfileAtomic,
  setDefaultAuthProfileForConnector,
  summarizeBrowserSessionAuthData,
  updateAuthProfile,
} from '../../utils/auth-profiles';
import { createConnectToken } from '../../utils/connect-tokens';
import { getWorkspaceRole } from '../../utils/organization-access';
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
  connector_key: Type.Optional(
    Type.String({
      description:
        'Connector key (e.g. x, google.gmail). Required for env/oauth profiles; optional for browser_session (device-scoped resource).',
    })
  ),
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

const SetDefaultAuthProfileAction = Type.Object({
  action: Type.Literal('set_default_auth_profile'),
  connector_key: Type.String({ description: 'Connector key to pin the default for' }),
  auth_profile_slug: Type.Union([Type.String(), Type.Null()], {
    description: 'OAuth app profile slug to pin as the org default, or null to clear.',
  }),
});

export const ManageAuthProfilesSchema = Type.Union([
  ListAuthProfilesAction,
  GetAuthProfileAction,
  TestAuthProfileAction,
  CreateAuthProfileAction,
  UpdateAuthProfileAction,
  DeleteAuthProfileAction,
  SetDefaultAuthProfileAction,
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
  | { action: 'delete_auth_profile'; deleted: true; auth_profile_slug: string }
  | {
      action: 'set_default_auth_profile';
      connector_key: string;
      auth_profile: any | null;
    };

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
    set_default_auth_profile: () =>
      handleSetDefaultAuthProfile(
        args as Extract<AuthProfilesArgs, { action: 'set_default_auth_profile' }>,
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

/**
 * When an oauth_app profile is revoked/errored, any connection that mints
 * tokens against it can no longer authenticate. Flip those connections to
 * pending_auth so the UI surfaces the breakage; the admin re-pins or rotates
 * the app, then operators re-authorize the connection.
 */
async function syncConnectionsForOAuthAppProfile(
  organizationId: string,
  authProfileId: number,
  active: boolean
): Promise<void> {
  const sql = getDb();
  const nextConnectionStatus = active ? 'active' : 'pending_auth';

  await sql`
    UPDATE connections
    SET status = ${nextConnectionStatus},
        updated_at = NOW()
    WHERE organization_id = ${organizationId}
      AND app_auth_profile_id = ${authProfileId}
      AND deleted_at IS NULL
  `;
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
  // Only oauth_account profiles are user-personal; every other kind is an
  // org-shared credential (env keys, OAuth app client_id/secret, browser
  // session, interactive). Gate non-personal kinds on admin role.
  if (args.profile_kind !== 'oauth_account') {
    const role = ctx.userId
      ? await getWorkspaceRole(getDb(), ctx.organizationId, ctx.userId)
      : null;
    if (role !== 'admin' && role !== 'owner') {
      return {
        error: `Only admins can create ${args.profile_kind} auth profiles. Ask an organization owner or admin to configure these credentials.`,
      };
    }
  }

  // browser_session profiles are device-scoped; connector_key is optional
  // (only used as a hint to look up a default cdp_url). Other kinds remain
  // per-connector and require it.
  const connector = args.connector_key
    ? await getScopedConnectorDefinition({
        organizationId: ctx.organizationId,
        connectorKey: args.connector_key,
      })
    : null;

  if (args.connector_key && !connector) {
    return { error: `Connector '${args.connector_key}' not found or not active` };
  }

  // Handle browser_session up front — it's the only kind that may skip
  // connector_key entirely. Everything below assumes a connector context.
  if (args.profile_kind === 'browser_session') {
    return handleCreateBrowserSessionProfile(args, ctx, connector);
  }

  if (!args.connector_key || !connector) {
    return { error: `connector_key is required for ${args.profile_kind} auth profiles` };
  }
  const connectorKey: string = args.connector_key;

  if (args.profile_kind === 'oauth_account') {
    const oauthMethod = getOAuthMethods(connector.auth_schema)[0];
    if (!oauthMethod) {
      return { error: `Connector '${connectorKey}' does not support OAuth account profiles` };
    }

    const displayName =
      args.display_name || `${connector.name} ${oauthMethod.provider} Account`;
    // Idempotent: if a profile with this slug already exists, reuse it (issue a
    // fresh connect token if it still needs auth). This lets a connection
    // reference `auth_profile_slug = <slug>` in the *same* `lobu apply` —
    // previously this branch never persisted a row, so the slug didn't resolve.
    const existing = args.slug
      ? await getAuthProfileBySlug(ctx.organizationId, normalizeAuthProfileSlug(args.slug, displayName))
      : null;
    if (existing) {
      if (existing.profile_kind !== 'oauth_account' || existing.connector_key !== connectorKey) {
        return {
          error: `Auth profile '${existing.slug}' already exists with a different kind/connector (${existing.profile_kind} / ${existing.connector_key}) — use a new slug`,
        };
      }
      // Non-admins reusing an existing oauth_account slug must own it —
      // otherwise a member who knows another member's pending profile slug
      // could mint a fresh connect token for it and complete OAuth into a
      // profile already referenced by someone else's connections.
      const role = ctx.userId
        ? await getWorkspaceRole(getDb(), ctx.organizationId, ctx.userId)
        : null;
      const callerIsAdmin = role === 'admin' || role === 'owner';
      if (!callerIsAdmin && existing.created_by !== ctx.userId) {
        return {
          error: `Auth profile '${existing.slug}' belongs to another user. Choose a different slug.`,
        };
      }
      if (existing.status === 'active') {
        return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(existing) };
      }
      const requestedScopes = resolveRequestedOAuthScopes(oauthMethod, args.requested_scopes);
      const connectToken = await createConnectToken({
        organizationId: ctx.organizationId,
        connectorKey,
        authType: 'oauth',
        authProfileId: existing.id,
        authConfig: {
          ...buildOAuthConnectConfig(oauthMethod, requestedScopes),
          requestedScopes,
        },
        createdBy: ctx.userId,
      });
      return {
        action: 'create_auth_profile',
        auth_profile: serializeAuthProfile(existing),
        connect_url: `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`,
        connect_token: connectToken.token,
      };
    }

    // Create a real `pending_auth` row up front so downstream
    // `auth_profile_slug` lookups (connection create, etc.) resolve. The OAuth
    // callback flips it to `active` once the user finishes authorization.
    const authProfile = await createAuthProfile({
      organizationId: ctx.organizationId,
      connectorKey,
      displayName,
      slug: args.slug,
      profileKind: 'oauth_account',
      authData: {},
      provider: oauthMethod.provider.toLowerCase(),
      status: 'pending_auth',
      createdBy: ctx.userId ?? 'api',
    });

    const requestedScopes = resolveRequestedOAuthScopes(oauthMethod, args.requested_scopes);
    let connectToken: Awaited<ReturnType<typeof createConnectToken>>;
    try {
      connectToken = await createConnectToken({
        organizationId: ctx.organizationId,
        connectorKey,
        authType: 'oauth',
        authProfileId: authProfile.id,
        authConfig: {
          ...buildOAuthConnectConfig(oauthMethod, requestedScopes),
          requestedScopes,
        },
        createdBy: ctx.userId,
      });
    } catch (err) {
      // Best-effort cleanup so a token-insert failure doesn't orphan a
      // `pending_auth` profile. (The orphan is self-healing — a retry reuses
      // the row and issues a fresh token — but cleaning up keeps state tidy.)
      await deleteAuthProfile(ctx.organizationId, authProfile.slug).catch(() => undefined);
      throw err;
    }

    return {
      action: 'create_auth_profile',
      auth_profile: serializeAuthProfile(authProfile),
      connect_url: `${getConnectBaseUrl(ctx)}/connect/${connectToken.token}/oauth/start`,
      connect_token: connectToken.token,
    };
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
    connectorKey,
    displayName: args.display_name,
    slug: args.slug,
    profileKind: args.profile_kind,
    authData: credentials,
    provider,
    createdBy: ctx.userId ?? 'api',
  });

  return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleCreateBrowserSessionProfile(
  args: Extract<AuthProfilesArgs, { action: 'create_auth_profile' }>,
  ctx: ToolContext,
  connector: Awaited<ReturnType<typeof getScopedConnectorDefinition>>
): Promise<ManageAuthProfilesResult> {
  // browser_session profiles are device-scoped resources — connector_key, if
  // provided, is just a hint for picking a default cdp_url from a known
  // connector's browser method. The stored profile is not connector-bound.
  const browserMethod = connector
    ? (getBrowserMethods(connector.auth_schema)[0] ?? null)
    : null;
  const captureMode = browserMethod?.capture ?? 'cdp';

  const authData =
    captureMode === 'cdp'
      ? {
          cdp_url:
            typeof args.auth_data?.cdp_url === 'string' &&
            args.auth_data.cdp_url.trim().length > 0
              ? args.auth_data.cdp_url.trim()
              : browserMethod?.defaultCdpUrl || 'auto',
        }
      : ((args.auth_data as Record<string, unknown> | undefined) ?? {});
  const browserSessionReady =
    captureMode === 'cdp'
      ? (await getBrowserSessionReadiness(authData, null)).usable
      : false;

  const authProfile = await createAuthProfile({
    organizationId: ctx.organizationId,
    connectorKey: null,
    displayName: args.display_name,
    slug: args.slug,
    profileKind: 'browser_session',
    authData,
    status: browserSessionReady ? 'active' : 'pending_auth',
    createdBy: ctx.userId ?? 'api',
  });

  return { action: 'create_auth_profile', auth_profile: serializeAuthProfile(authProfile) };
}

async function handleUpdateAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'update_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  // Mirror create gating: only oauth_account profiles are member-editable.
  // env / oauth_app / browser_session are org-shared credentials — admin only.
  // For oauth_account, non-admins can only touch a profile they created — the
  // slug alone shouldn't let one member rotate another member's tokens.
  const existingForRoleCheck = await getAuthProfileBySlug(
    ctx.organizationId,
    args.auth_profile_slug
  );
  if (existingForRoleCheck) {
    const role = ctx.userId
      ? await getWorkspaceRole(getDb(), ctx.organizationId, ctx.userId)
      : null;
    const callerIsAdmin = role === 'admin' || role === 'owner';
    if (existingForRoleCheck.profile_kind !== 'oauth_account' && !callerIsAdmin) {
      return {
        error: `Only admins can modify ${existingForRoleCheck.profile_kind} auth profiles.`,
      };
    }
    if (
      !callerIsAdmin &&
      existingForRoleCheck.profile_kind === 'oauth_account' &&
      existingForRoleCheck.created_by !== ctx.userId
    ) {
      return {
        error: `You can only update OAuth account profiles you created. Ask an admin if you need to manage another member's profile.`,
      };
    }

  }

  // The payload that will actually be persisted: an explicit `auth_data` wins,
  // else `credentials` (normalized to a string map), else undefined (leave the
  // existing auth_data as-is).
  const updateAuthDataPayload: Record<string, unknown> | undefined =
    args.auth_data !== undefined
      ? (args.auth_data as Record<string, unknown>)
      : args.credentials
        ? normalizeAuthValues(args.credentials)
        : undefined;

  let authProfile = await updateAuthProfile({
    organizationId: ctx.organizationId,
    slug: args.auth_profile_slug,
    displayName: args.display_name,
    nextSlug: args.slug,
    authData: updateAuthDataPayload,
    status: args.status as AuthProfileStatus | undefined,
  });

  if (!authProfile) {
    return { error: `Auth profile '${args.auth_profile_slug}' not found` };
  }

  const authProfileProvider = authProfile.provider;

  if (
    authProfile.profile_kind === 'oauth_account' &&
    authProfileProvider &&
    args.requested_scopes &&
    authProfile.connector_key
  ) {
    const profileConnectorKey = authProfile.connector_key;
    const connector = await getScopedConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: profileConnectorKey,
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

  if (
    args.reconnect &&
    authProfile.profile_kind === 'oauth_account' &&
    authProfileProvider &&
    authProfile.connector_key
  ) {
    const profileConnectorKey = authProfile.connector_key;
    const connector = await getScopedConnectorDefinition({
      organizationId: ctx.organizationId,
      connectorKey: profileConnectorKey,
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
        connectorKey: profileConnectorKey,
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

  // Cascade for oauth_app: admins flipping an app profile to revoked/error
  // need dependent connections to surface as broken (instead of silently
  // continuing to point at a profile whose creds the gateway can no longer
  // resolve). For the revoke/error case we re-do the status flip inside a
  // transaction together with the cascade + default-clear so there's no
  // window where connections still reference the revoked profile (the prior
  // updateAuthProfile call above already wrote status, but its tx is now
  // closed — this overwrite is idempotent and lands the full state change
  // atomically).
  if (authProfile.profile_kind === 'oauth_app') {
    if (authProfile.status === 'revoked' || authProfile.status === 'error') {
      const atomic = await revokeOAuthAppProfileAtomic({
        organizationId: ctx.organizationId,
        profileId: authProfile.id,
        nextStatus: authProfile.status,
      });
      if (atomic) authProfile = atomic;
    } else if (authProfile.status === 'active') {
      await syncConnectionsForOAuthAppProfile(ctx.organizationId, authProfile.id, true);
    }
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

  // Sync + delete must happen atomically: between flipping dependent
  // connections to `pending_auth` and the DELETE, a concurrent
  // `manage_connections.create` could insert a new connection referencing
  // this profile. The FK `ON DELETE SET NULL` would then leave that
  // connection active with `app_auth_profile_id = NULL`. Lock the profile
  // row up front (`FOR UPDATE` conflicts with the FK insert's FOR KEY SHARE
  // lock, so concurrent inserts block until we commit and then fail FK).
  const deleted = await sql.begin(async (tx) => {
    const lockRows = await tx`
      SELECT id FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND id = ${existing.id}
      FOR UPDATE
    `;
    if (lockRows.length === 0) return null;

    await tx`
      UPDATE connect_tokens
      SET auth_profile_id = NULL
      WHERE auth_profile_id = ${existing.id}
    `;

    if (existing.profile_kind === 'browser_session') {
      // Pause dependent connections + their feeds (mirrors
      // syncConnectionsForBrowserAuthProfile, inlined for tx locality).
      await tx`
        UPDATE connections
        SET status = 'pending_auth', updated_at = NOW()
        WHERE organization_id = ${ctx.organizationId}
          AND auth_profile_id = ${existing.id}
      `;
      await tx`
        UPDATE feeds f
        SET status = 'paused',
            next_run_at = NULL,
            updated_at = NOW()
        FROM connections c
        WHERE f.connection_id = c.id
          AND c.organization_id = ${ctx.organizationId}
          AND c.auth_profile_id = ${existing.id}
      `;
    }

    if (existing.profile_kind === 'oauth_app') {
      await tx`
        UPDATE connections
        SET status = 'pending_auth', updated_at = NOW()
        WHERE organization_id = ${ctx.organizationId}
          AND app_auth_profile_id = ${existing.id}
          AND deleted_at IS NULL
      `;
    }

    // Explicitly null the FK columns before delete. The FK is composite
    // `(organization_id, *_auth_profile_id) ON DELETE SET NULL`; without a
    // SET NULL column list, Postgres would attempt to null organization_id
    // too (NOT NULL → constraint violation). Setting only the profile-id
    // column here avoids that and matches the intended semantic.
    await tx`
      UPDATE connections
      SET auth_profile_id = NULL, updated_at = NOW()
      WHERE organization_id = ${ctx.organizationId}
        AND auth_profile_id = ${existing.id}
    `;
    await tx`
      UPDATE connections
      SET app_auth_profile_id = NULL, updated_at = NOW()
      WHERE organization_id = ${ctx.organizationId}
        AND app_auth_profile_id = ${existing.id}
    `;

    const deletedRows = await tx`
      DELETE FROM auth_profiles
      WHERE organization_id = ${ctx.organizationId}
        AND id = ${existing.id}
      RETURNING id
    `;
    return deletedRows.length > 0 ? deletedRows[0] : null;
  });
  if (!deleted) {
    return { error: `Failed to delete auth profile '${args.auth_profile_slug}'` };
  }

  return {
    action: 'delete_auth_profile',
    deleted: true,
    auth_profile_slug: args.auth_profile_slug,
  };
}

async function handleSetDefaultAuthProfile(
  args: Extract<AuthProfilesArgs, { action: 'set_default_auth_profile' }>,
  ctx: ToolContext
): Promise<ManageAuthProfilesResult> {
  if (args.auth_profile_slug !== null) {
    const target = await getAuthProfileBySlug(ctx.organizationId, args.auth_profile_slug);
    if (!target) {
      return { error: `Auth profile '${args.auth_profile_slug}' not found` };
    }
    if (target.profile_kind !== 'oauth_app') {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is a ${target.profile_kind} profile; only oauth_app profiles can be pinned as connector defaults.`,
      };
    }
    if (target.connector_key !== args.connector_key) {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is bound to connector '${target.connector_key}', not '${args.connector_key}'.`,
      };
    }
    if (target.status !== 'active') {
      return {
        error: `Auth profile '${args.auth_profile_slug}' is ${target.status}; only active profiles can be pinned as the default.`,
      };
    }
  }

  const pinned = await setDefaultAuthProfileForConnector({
    organizationId: ctx.organizationId,
    connectorKey: args.connector_key,
    slug: args.auth_profile_slug,
  });

  return {
    action: 'set_default_auth_profile',
    connector_key: args.connector_key,
    auth_profile: pinned ? serializeAuthProfile(pinned) : null,
  };
}
