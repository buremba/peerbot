/**
 * Shared helpers for connection-related admin tools.
 *
 * Used by manage_connections, manage_feeds, and manage_auth_profiles.
 */

import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import {
  type AuthProfileKind,
  type AuthProfileRow,
  browserSessionIsUsable,
  createAuthProfile,
  getAuthProfileBySlug,
  getPrimaryAuthProfileForKind,
  normalizeAuthProfileSlug,
  normalizeAuthValues,
  resolveAuthProfileSlugToId,
  summarizeBrowserSessionAuthData,
  updateAuthProfile,
} from '../../../utils/auth-profiles';
import { DEFAULT_SCHEDULE } from '../../../utils/cron';
import {
  readGrantedScopesFromAuthData,
  readRequestedScopesFromAuthData,
} from '../../../utils/oauth-scopes';
import { getWorkspaceRole } from '../../../utils/organization-access';
import {
  buildConnectionsUrl,
  getOrganizationSlug,
  getPublicWebUrl,
} from '../../../utils/url-builder';
import type { ToolContext } from '../../registry';

// ============================================
// Auth Schema Types
// ============================================

type OAuthAuthMethod = {
  type: 'oauth';
  provider: string;
  requiredScopes?: string[];
  optionalScopes?: string[];
  loginScopes?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  clientIdKey?: string;
  clientSecretKey?: string;
  loginProvisioning?: {
    autoCreateConnection?: boolean;
  };
};

type EnvKeyAuthMethod = {
  type: 'env_keys';
  required?: boolean;
  fields?: Array<{
    key: string;
    label?: string;
    description?: string;
    secret?: boolean;
    required?: boolean;
    example?: string;
  }>;
};

type BrowserAuthMethod = {
  type: 'browser';
  required?: boolean;
  description?: string;
  capture?: 'cli' | 'cdp';
  defaultCdpUrl?: string;
};

type InteractiveAuthMethod = {
  type: 'interactive';
  required?: boolean;
  scope?: 'connection' | 'org';
  expectedArtifact?: 'qr' | 'code' | 'redirect' | 'prompt';
  timeoutSec?: number;
  description?: string;
};

type AuthSchema =
  | { methods?: Array<Record<string, unknown>> }
  | Record<string, unknown>
  | null
  | undefined;

// ============================================
// Auth Schema Helpers
// ============================================

function getAuthMethods(authSchema: AuthSchema): Array<Record<string, unknown>> {
  const methods = (authSchema as { methods?: unknown } | null)?.methods;
  return Array.isArray(methods) ? methods : [];
}

export function getOAuthMethods(authSchema: AuthSchema): OAuthAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is OAuthAuthMethod =>
      method.type === 'oauth' && typeof method.provider === 'string'
  );
}

export function getEnvKeyMethods(authSchema: AuthSchema): EnvKeyAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is EnvKeyAuthMethod => method.type === 'env_keys'
  );
}

export function getBrowserMethods(authSchema: AuthSchema): BrowserAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is BrowserAuthMethod => method.type === 'browser'
  );
}

export function getInteractiveMethods(authSchema: AuthSchema): InteractiveAuthMethod[] {
  return getAuthMethods(authSchema).filter(
    (method): method is InteractiveAuthMethod => method.type === 'interactive'
  );
}

export function getOAuthCredentialKeys(method: OAuthAuthMethod): {
  clientIdKey: string;
  clientSecretKey: string;
} {
  const providerUpper = method.provider.toUpperCase();
  return {
    clientIdKey:
      typeof method.clientIdKey === 'string' && method.clientIdKey.trim().length > 0
        ? method.clientIdKey
        : `${providerUpper}_CLIENT_ID`,
    clientSecretKey:
      typeof method.clientSecretKey === 'string' && method.clientSecretKey.trim().length > 0
        ? method.clientSecretKey
        : `${providerUpper}_CLIENT_SECRET`,
  };
}

export function resolveRequestedOAuthScopes(
  method: OAuthAuthMethod,
  requestedScopes?: string[] | null
): string[] {
  const requiredScopes = Array.isArray(method.requiredScopes)
    ? method.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const optionalScopes = new Set(
    Array.isArray(method.optionalScopes)
      ? method.optionalScopes.filter((scope): scope is string => typeof scope === 'string')
      : []
  );
  const requestedOptionalScopes = (requestedScopes ?? []).filter(
    (scope): scope is string => typeof scope === 'string' && optionalScopes.has(scope)
  );
  return Array.from(new Set([...requiredScopes, ...requestedOptionalScopes]));
}

export function buildOAuthConnectConfig(
  method: OAuthAuthMethod,
  requestedScopes?: string[] | null
): Record<string, unknown> {
  const authParams =
    method.authParams && typeof method.authParams === 'object'
      ? Object.fromEntries(
          Object.entries(method.authParams).filter(([, value]) => typeof value === 'string')
        )
      : undefined;

  return {
    provider: method.provider,
    scopes: resolveRequestedOAuthScopes(method, requestedScopes),
    ...getOAuthCredentialKeys(method),
    ...(typeof method.authorizationUrl === 'string'
      ? { authorizationUrl: method.authorizationUrl }
      : {}),
    ...(typeof method.tokenUrl === 'string' ? { tokenUrl: method.tokenUrl } : {}),
    ...(typeof method.userinfoUrl === 'string' ? { userinfoUrl: method.userinfoUrl } : {}),
    ...(authParams && Object.keys(authParams).length > 0 ? { authParams } : {}),
    ...(method.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: method.tokenEndpointAuthMethod }
      : {}),
    ...(typeof method.usePkce === 'boolean' ? { usePkce: method.usePkce } : {}),
  };
}

function splitAuthValuesBySchema(
  authSchema: AuthSchema,
  authValues: Record<string, string>
): {
  envValues: Record<string, string>;
  oauthAppProfiles: Array<{ provider: string; credentials: Record<string, string> }>;
} {
  const oauthProfiles: Array<{ provider: string; credentials: Record<string, string> }> = [];
  const claimedKeys = new Set<string>();

  for (const method of getOAuthMethods(authSchema)) {
    const { clientIdKey, clientSecretKey } = getOAuthCredentialKeys(method);
    const credentials: Record<string, string> = {};

    if (authValues[clientIdKey]) {
      credentials[clientIdKey] = authValues[clientIdKey];
      claimedKeys.add(clientIdKey);
    }
    if (authValues[clientSecretKey]) {
      credentials[clientSecretKey] = authValues[clientSecretKey];
      claimedKeys.add(clientSecretKey);
    }

    if (Object.keys(credentials).length > 0) {
      oauthProfiles.push({ provider: method.provider.toLowerCase(), credentials });
    }
  }

  const envValues = Object.fromEntries(
    Object.entries(authValues).filter(([key]) => !claimedKeys.has(key))
  );

  return { envValues, oauthAppProfiles: oauthProfiles };
}

// ============================================
// upsertConnectorAuthProfiles
// ============================================

export async function upsertConnectorAuthProfiles(params: {
  organizationId: string;
  connectorKey: string;
  connectorName: string;
  authSchema: AuthSchema;
  authValues: Record<string, string>;
  createdBy: string;
}): Promise<string[]> {
  const keysUpdated = new Set<string>();
  const { envValues, oauthAppProfiles } = splitAuthValuesBySchema(
    params.authSchema,
    params.authValues
  );

  for (const profile of oauthAppProfiles) {
    const profileSlug = normalizeAuthProfileSlug(`${params.connectorKey}-${profile.provider}-app`);
    const existing = await getAuthProfileBySlug(params.organizationId, profileSlug);
    if (existing) {
      await updateAuthProfile({
        organizationId: params.organizationId,
        slug: profileSlug,
        displayName: `${params.connectorName} ${profile.provider[0]?.toUpperCase() ?? ''}${profile.provider.slice(1)} App`,
        authData: profile.credentials,
        status: 'active',
        provider: profile.provider,
      });
    } else {
      await createAuthProfile({
        organizationId: params.organizationId,
        connectorKey: params.connectorKey,
        displayName: `${params.connectorName} ${profile.provider[0]?.toUpperCase() ?? ''}${profile.provider.slice(1)} App`,
        slug: profileSlug,
        profileKind: 'oauth_app',
        authData: profile.credentials,
        provider: profile.provider,
        createdBy: params.createdBy,
      });
    }
    for (const key of Object.keys(profile.credentials)) {
      keysUpdated.add(key);
    }
  }

  if (Object.keys(envValues).length > 0) {
    const profileSlug = normalizeAuthProfileSlug(`${params.connectorKey}-default`);
    const existing = await getAuthProfileBySlug(params.organizationId, profileSlug);
    if (existing) {
      await updateAuthProfile({
        organizationId: params.organizationId,
        slug: profileSlug,
        displayName: `${params.connectorName} Default`,
        authData: envValues,
        status: 'active',
      });
    } else {
      await createAuthProfile({
        organizationId: params.organizationId,
        connectorKey: params.connectorKey,
        displayName: `${params.connectorName} Default`,
        slug: profileSlug,
        profileKind: 'env',
        authData: envValues,
        createdBy: params.createdBy,
      });
    }
    for (const key of Object.keys(envValues)) {
      keysUpdated.add(key);
    }
  }

  return Array.from(keysUpdated);
}

// ============================================
// Shared Helpers
// ============================================

export function getDefaultSchedule(env: Env): string {
  return env.DEFAULT_SYNC_SCHEDULE ?? DEFAULT_SCHEDULE;
}

export function mapConnectionStatusToFeedStatus(status: string): 'active' | 'paused' {
  return status === 'active' ? 'active' : 'paused';
}

export function enrichWithAuthProfiles(
  row: Record<string, unknown>,
  authProfile: AuthProfileRow | null,
  appAuthProfile: AuthProfileRow | null
): Record<string, unknown> {
  return {
    ...row,
    auth_profile_slug: authProfile?.slug ?? null,
    auth_profile_name: authProfile?.display_name ?? null,
    auth_profile_status: authProfile?.status ?? null,
    app_auth_profile_slug: appAuthProfile?.slug ?? null,
    app_auth_profile_name: appAuthProfile?.display_name ?? null,
    app_auth_profile_status: appAuthProfile?.status ?? null,
  };
}

export function getConnectBaseUrl(ctx: ToolContext): string {
  return (ctx.baseUrl ?? (ctx.requestUrl ? new URL(ctx.requestUrl).origin : '')).replace(
    /\/+$/,
    ''
  );
}

export async function buildViewUrl(
  ctx: ToolContext,
  connectorKey?: string | null
): Promise<string | undefined> {
  const baseUrl = getPublicWebUrl(ctx.requestUrl, ctx.baseUrl);
  const ownerSlug = await getOrganizationSlug(ctx.organizationId);
  if (!ownerSlug || !baseUrl) return undefined;
  return buildConnectionsUrl(ownerSlug, baseUrl, connectorKey);
}

export async function resolveConnectionVisibility(
  organizationId: string,
  userId?: string | null
): Promise<'org' | 'private'> {
  if (!userId) return 'org';
  const sql = getDb();
  const role = await getWorkspaceRole(sql, organizationId, userId);
  return role === 'owner' || role === 'admin' ? 'org' : 'private';
}

export async function resolveConnectionDisplayName(params: {
  explicitName?: string | null;
  connectorName: string;
  username?: string | null;
}): Promise<string> {
  if (params.explicitName?.trim()) return params.explicitName.trim();

  if (params.username) return `${params.connectorName} (${params.username})`;
  return params.connectorName;
}

// ============================================
// Auth Selection
// ============================================

interface AuthSelectionResult {
  selectedKind: 'none' | AuthProfileKind;
  authProfile: AuthProfileRow | null;
  appAuthProfile: AuthProfileRow | null;
  oauthMethod: OAuthAuthMethod | null;
  envMethod: EnvKeyAuthMethod | null;
  browserMethod: BrowserAuthMethod | null;
  preferredMethodType: 'none' | 'oauth' | 'env_keys' | 'browser';
}

function getPreferredAuthMethodType(
  authSchema: AuthSchema
): AuthSelectionResult['preferredMethodType'] {
  for (const method of getAuthMethods(authSchema)) {
    if (method.type === 'oauth' || method.type === 'env_keys' || method.type === 'browser') {
      return method.type;
    }
  }
  return 'none';
}

const EMPTY_SELECTION = (params: {
  oauthMethod: OAuthAuthMethod | null;
  envMethod: EnvKeyAuthMethod | null;
  browserMethod: BrowserAuthMethod | null;
  preferredMethodType?: AuthSelectionResult['preferredMethodType'];
}): AuthSelectionResult => ({
  selectedKind: 'none',
  authProfile: null,
  appAuthProfile: null,
  oauthMethod: params.oauthMethod,
  envMethod: params.envMethod,
  browserMethod: params.browserMethod,
  preferredMethodType: params.preferredMethodType ?? 'none',
});

export async function resolveConnectionAuthSelection(params: {
  organizationId: string;
  connectorKey: string;
  authSchema:
    | { methods?: Array<Record<string, unknown>> }
    | Record<string, unknown>
    | null
    | undefined;
  authProfileSlug?: string | null;
  appAuthProfileSlug?: string | null;
}): Promise<AuthSelectionResult> {
  const { organizationId, connectorKey } = params;
  const oauthMethod = getOAuthMethods(params.authSchema)[0] ?? null;
  const envMethod = getEnvKeyMethods(params.authSchema)[0] ?? null;
  const browserMethod = getBrowserMethods(params.authSchema)[0] ?? null;
  const preferredMethodType = getPreferredAuthMethodType(params.authSchema);

  // 1. Resolve explicitly selected auth profile, or auto-select the primary
  //    auth profile for the connector's preferred auth method.
  const authProfile =
    (await resolveAuthProfileSlugToId({
      organizationId,
      slug: params.authProfileSlug,
      connectorKey,
    })) ??
    (preferredMethodType === 'env_keys' && envMethod
      ? await getPrimaryAuthProfileForKind({ organizationId, connectorKey, profileKind: 'env' })
      : null) ??
    (preferredMethodType === 'browser' && browserMethod
      ? await getPrimaryAuthProfileForKind({
          organizationId,
          connectorKey,
          profileKind: 'browser_session',
        })
      : null) ??
    (preferredMethodType === 'oauth' && oauthMethod
      ? await getPrimaryAuthProfileForKind({
          organizationId,
          connectorKey,
          profileKind: 'oauth_account',
          provider: oauthMethod.provider,
        })
      : null);

  if (!authProfile) {
    return EMPTY_SELECTION({ oauthMethod, envMethod, browserMethod, preferredMethodType });
  }

  // 2. For OAuth accounts, also resolve the app credentials profile.
  const needsAppAuth = authProfile.profile_kind === 'oauth_account' || !!params.appAuthProfileSlug;
  const appAuthProfile = needsAppAuth
    ? ((await resolveAuthProfileSlugToId({
        organizationId,
        slug: params.appAuthProfileSlug,
        expectedKind: 'oauth_app',
        connectorKey,
      })) ??
      (oauthMethod && authProfile.profile_kind === 'oauth_account'
        ? await getPrimaryAuthProfileForKind({
            organizationId,
            connectorKey,
            profileKind: 'oauth_app',
            provider: oauthMethod.provider,
          })
        : null))
    : null;

  return {
    selectedKind: authProfile.profile_kind,
    authProfile,
    appAuthProfile,
    oauthMethod,
    envMethod,
    browserMethod,
    preferredMethodType,
  };
}

// ============================================
// Serialization
// ============================================

export function serializeAuthProfile(authProfile: AuthProfileRow): Record<string, unknown> {
  const browserSummary =
    authProfile.profile_kind === 'browser_session'
      ? summarizeBrowserSessionAuthData(authProfile.auth_data, authProfile.connector_key)
      : null;

  return {
    id: authProfile.id,
    organization_id: authProfile.organization_id,
    slug: authProfile.slug,
    display_name: authProfile.display_name,
    connector_key: authProfile.connector_key,
    profile_kind: authProfile.profile_kind,
    status: authProfile.status,
    provider: authProfile.provider,
    created_by: authProfile.created_by,
    created_at: authProfile.created_at,
    updated_at: authProfile.updated_at,
    ...(authProfile.profile_kind === 'oauth_account'
      ? {
          requested_scopes: readRequestedScopesFromAuthData(authProfile.auth_data),
          granted_scopes: readGrantedScopesFromAuthData(authProfile.auth_data),
        }
      : {}),
    ...(browserSummary ?? {}),
    ...(authProfile.profile_kind === 'browser_session'
      ? {
          has_auth_data:
            !!browserSummary?.cdp_url ||
            browserSessionIsUsable(authProfile.auth_data, authProfile.connector_key),
        }
      : {}),
  };
}

// ============================================
// Post-install Auth Upsert
// ============================================

export async function maybeUpsertAuthAfterInstall(
  installed: { connectorKey: string; name: string; authSchema: AuthSchema },
  authValues: Record<string, string> | undefined,
  ctx: ToolContext
): Promise<void> {
  const normalized = normalizeAuthValues(authValues ?? {});
  if (Object.keys(normalized).length > 0) {
    await upsertConnectorAuthProfiles({
      organizationId: ctx.organizationId,
      connectorKey: installed.connectorKey,
      connectorName: installed.name,
      authSchema: installed.authSchema,
      authValues: normalized,
      createdBy: ctx.userId ?? 'api',
    });
  }
}
