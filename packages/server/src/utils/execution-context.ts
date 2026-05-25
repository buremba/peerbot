import { CredentialService } from '../auth/credentials';
import { resolveCloudCredential } from '../connect/cloud-credential';
import { getBuiltinProviderConfig } from '../connect/oauth-providers';
import { type DbClient, getDb } from '../db/client';
import { getAuthProfileById, normalizeAuthValues } from './auth-profiles';
import { getOAuthAuthMethods, normalizeConnectorAuthSchema } from './connector-auth';
import { parseJsonObject } from '@lobu/core';
import { errorMessage } from './errors';
import logger from './logger';

interface ExecutionOAuthCredentials {
  provider: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: string | null;
  scope?: string | null;
}

interface ResolvedExecutionAuth {
  credentials: ExecutionOAuthCredentials | null;
  connectionCredentials: Record<string, string>;
  sessionState: Record<string, unknown> | null;
  browserUserDataDir: string | null;
}

interface ResolveExecutionAuthParams {
  organizationId: string;
  connectionId: number;
  authProfileId?: number | null;
  appAuthProfileId?: number | null;
  credentialDb: DbClient;
  logContext?: Record<string, unknown>;
  logMessage?: string;
}

export async function resolveExecutionAuth(
  params: ResolveExecutionAuthParams
): Promise<ResolvedExecutionAuth> {
  const authProfile = await getAuthProfileById(params.organizationId, params.authProfileId ?? null);
  const appAuthProfile = await getAuthProfileById(
    params.organizationId,
    params.appAuthProfileId ?? null
  );

  let credentials: ExecutionOAuthCredentials | null = null;

  // Managed-connector branch: when the LOCAL connection is `managedBy` a cloud
  // (public) org, the grant lives in the cloud — fetch a fresh access token for
  // THIS user's own cloud connection via POST /oauth/connection-token. A null
  // result means the connection uses the local credential path below, which is
  // unchanged. The managed-by descriptor comes from the trusted connection
  // `config`, never from raw auth_data keys.
  const managed = await resolveManagedByForConnection(
    params.organizationId,
    params.connectionId
  );
  if (managed) {
    const accessToken = await fetchManagedConnectionToken(managed, {
      ...params.logContext,
      connection_id: params.connectionId,
    });
    if (accessToken) {
      credentials = {
        provider: appAuthProfile?.provider ?? 'managed',
        accessToken: accessToken.access_token,
        refreshToken: null,
        expiresAt: accessToken.expires_at ?? null,
        scope: null,
      };
    }
    return {
      credentials,
      connectionCredentials: {},
      sessionState: null,
      browserUserDataDir: null,
    };
  }

  if (authProfile?.profile_kind === 'oauth_account' && authProfile.account_id) {
    try {
      const credentialService = new CredentialService(params.credentialDb);
      const oauthConfig =
        appAuthProfile?.profile_kind === 'oauth_app'
          ? await resolveExecutionOAuthConfig(
              params.organizationId,
              params.connectionId,
              normalizeAuthValues(appAuthProfile.auth_data ?? {})
            )
          : undefined;
      const tokens = await credentialService.getConnectionTokens(
        params.connectionId,
        authProfile.account_id,
        oauthConfig
      );
      if (tokens?.provider && tokens.accessToken) {
        credentials = {
          provider: tokens.provider,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
          scope: tokens.scope,
        };
      }
    } catch (error) {
      logger.warn(
        {
          ...params.logContext,
          connection_id: params.connectionId,
          error: errorMessage(error),
        },
        params.logMessage ?? 'Failed to resolve execution credentials'
      );
    }
  }

  const connectionCredentials = {
    ...normalizeAuthValues(appAuthProfile?.auth_data ?? {}),
    ...normalizeAuthValues(
      authProfile?.profile_kind === 'env' ? (authProfile.auth_data ?? {}) : {}
    ),
  };
  let sessionState =
    authProfile?.profile_kind === 'browser_session' || authProfile?.profile_kind === 'interactive'
      ? ((authProfile.auth_data as Record<string, unknown>) ?? null)
      : null;

  // Device-bound browser profiles either:
  //   user_data_dir → managed Chrome with isolated cookies; or
  //   cdp_url       → attach to a running Chrome via remote debugging port.
  // Cookies stay on the device in both cases; the server never holds them.
  let browserUserDataDir: string | null = null;
  if (authProfile?.profile_kind === 'browser_session' && authProfile.device_worker_id) {
    browserUserDataDir = authProfile.user_data_dir ?? null;
    const cdpUrl = authProfile.cdp_url ?? null;
    if (browserUserDataDir) {
      sessionState = { ...(sessionState ?? {}), user_data_dir: browserUserDataDir };
    }
    if (cdpUrl) {
      sessionState = { ...(sessionState ?? {}), cdp_url: cdpUrl };
    }
  }

  return {
    credentials,
    connectionCredentials,
    sessionState,
    browserUserDataDir,
  };
}

/**
 * A managed-connector descriptor resolved from a LOCAL connection's `config`.
 * When present, the connection's OAuth grant lives in a cloud (public) org: the
 * local instance fetches a fresh access token for THIS user's own cloud
 * connection at runtime, authenticating with the instance's cloud PAT.
 */
interface ManagedByDescriptor {
  /** The cloud org slug/id the managed connector lives under. */
  org: string;
  /** The connector key to fetch the user's connection token for. */
  connectorKey: string;
  /** Cloud base URL (no trailing `/oauth/connection-token`). */
  baseUrl: string;
  /**
   * The cloud bearer credential — the user's OWN device-login access token
   * (`lobu login`, carrying `connections:token`), or the headless/CI fallback
   * `LOBU_CLOUD_PAT`. Resolved by `resolveCloudCredential`.
   */
  token: string;
}

/**
 * Resolve the {@link ManagedByDescriptor} for a connection, or `null` when the
 * connection is NOT managed (i.e. it uses the local/unchanged credential path).
 *
 * A connection opts into the managed path by carrying `config.managedBy = {
 * org }` (set via `defineConnection({ connector, managedBy })`). The cloud
 * bearer credential AND the cloud base URL are sourced ONLY from the local
 * instance's own login (`resolveCloudCredential`: the stored `lobu login`
 * device credential, falling back to `LOBU_CLOUD_PAT`/`LOBU_CLOUD_URL` for
 * headless/CI). The connection config supplies ONLY the `org`; it CANNOT
 * influence where the credential is sent (a connection-controlled URL would let
 * a malicious config exfiltrate the cloud credential). Returns `null` (so the
 * connection falls through to the local path) when the descriptor or the cloud
 * credential is missing.
 */
async function resolveManagedByForConnection(
  organizationId: string,
  connectionId: number
): Promise<ManagedByDescriptor | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT connector_key, config
    FROM connections
    WHERE id = ${connectionId}
      AND organization_id = ${organizationId}
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    connector_key: string;
    config: Record<string, unknown> | null;
  }>;
  if (rows.length === 0) return null;

  const config = parseJsonObject(rows[0].config);
  const managedByRaw = config.managedBy;
  if (!managedByRaw || typeof managedByRaw !== 'object' || Array.isArray(managedByRaw)) {
    return null;
  }
  const managedBy = managedByRaw as Record<string, unknown>;
  const org = typeof managedBy.org === 'string' ? managedBy.org.trim() : '';
  if (!org) return null;

  // The credential + base URL come from the local instance's OWN login (or the
  // env fallback), never from the connection config — so a malicious config
  // can't redirect where the credential is sent.
  const cloud = await resolveCloudCredential();
  if (!cloud) return null;

  return { org, connectorKey: rows[0].connector_key, baseUrl: cloud.baseUrl, token: cloud.token };
}

/**
 * Fetch a fresh access token for a managed connection from the cloud via POST
 * /oauth/connection-token. The cloud holds the managed grant + secret and
 * refreshes server-side; we only ever receive `{ access_token, expires_at }`.
 * Returns null on any failure so the connection resolves without credentials
 * (fail-soft, like the local path).
 *
 * Deliberately uncached: this resolves once per worker run / feed sync (not per
 * message), so a fresh fetch is cheap — and skipping a process-shared token
 * cache means one caller's cloud token can never be served to another.
 */
async function fetchManagedConnectionToken(
  managed: ManagedByDescriptor,
  logContext: Record<string, unknown>
): Promise<{ access_token: string; expires_at: string | null } | null> {
  let tokenUrl: string;
  try {
    tokenUrl = new URL(`${managed.baseUrl}/oauth/connection-token`).toString();
  } catch {
    logger.warn({ ...logContext }, 'Managed connection cloud URL is not a valid absolute URL');
    return null;
  }

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${managed.token}`,
      },
      body: JSON.stringify({ org: managed.org, connector_key: managed.connectorKey }),
    });
    if (!response.ok) {
      logger.warn(
        { ...logContext, status: response.status },
        'Managed connection token fetch failed'
      );
      return null;
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_at?: string | null;
    };
    if (!body.access_token) return null;
    return { access_token: body.access_token, expires_at: body.expires_at ?? null };
  } catch (error) {
    logger.warn(
      { ...logContext, error: errorMessage(error) },
      'Managed connection token fetch error'
    );
    return null;
  }
}

async function resolveExecutionOAuthConfig(
  organizationId: string,
  connectionId: number,
  appAuthValues: Record<string, string>
): Promise<
  | {
      tokenUrl: string;
      clientId: string;
      clientSecret?: string;
      authMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
    }
  | undefined
> {
  const sql = getDb();
  const rows = await sql`
    SELECT c.connector_key, cd.auth_schema
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    WHERE c.id = ${connectionId}
      AND c.organization_id = ${organizationId}
    LIMIT 1
  `;

  if (rows.length === 0) return undefined;

  const row = rows[0] as { connector_key: string; auth_schema: unknown };
  const authSchema = normalizeConnectorAuthSchema(row.auth_schema);
  const oauthMethod = getOAuthAuthMethods(authSchema)[0];
  if (!oauthMethod) return undefined;

  const builtin = getBuiltinProviderConfig(oauthMethod.provider);
  const tokenUrl = oauthMethod.tokenUrl ?? builtin?.tokenUrl;
  if (!tokenUrl) return undefined;

  const providerUpper = oauthMethod.provider.toUpperCase();
  const clientIdKey = oauthMethod.clientIdKey || `${providerUpper}_CLIENT_ID`;
  const clientSecretKey = oauthMethod.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;
  const clientId = appAuthValues[clientIdKey];
  if (!clientId) return undefined;

  const clientSecret = appAuthValues[clientSecretKey];
  const authMethod = oauthMethod.tokenEndpointAuthMethod ?? builtin?.tokenEndpointAuthMethod;
  return {
    tokenUrl,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(authMethod ? { authMethod } : {}),
  };
}

export function mergeExecutionConfig(...configs: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    Object.assign(merged, parseJsonObject(config));
  }
  return merged;
}
