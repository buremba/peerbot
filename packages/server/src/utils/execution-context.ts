import { CredentialService } from '../auth/credentials';
import { getBuiltinProviderConfig } from '../connect/oauth-providers';
import { type DbClient, getDb } from '../db/client';
import {
  type BrokerCredential,
  getAuthProfileById,
  normalizeAuthValues,
  resolveBrokerCredentialForConnection,
} from './auth-profiles';
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

  // The single seam for the broker branch: a non-null result means the
  // connection's app profile is an `oauth_broker`, so fetch a fresh access token
  // from the remote broker (the grant lives there). A null result means the
  // connection uses the local credential path below, which is unchanged. Never
  // sniffs raw auth_data keys.
  const broker = await resolveBrokerCredentialForConnection(
    params.organizationId,
    params.appAuthProfileId ?? null
  );
  if (broker) {
    const accessToken = await fetchBrokerAccessToken(broker, {
      ...params.logContext,
      connection_id: params.connectionId,
    });
    if (accessToken) {
      credentials = {
        provider: appAuthProfile?.provider ?? 'broker',
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
 * Loopback hostnames an `http:` broker origin is allowed to use when the
 * operator explicitly allowlists it (dev / self-broker). Everything else MUST
 * be `https:`.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Parse `LOBU_ALLOWED_BROKER_ORIGINS` into a set of normalized
 * `scheme://host[:port]` origins. This is the SSRF control surface: the local
 * instance POSTs its broker PAT to `broker_url`, so an attacker-controlled
 * `oauth_broker` profile could otherwise point that fetch at an internal
 * service or the cloud metadata endpoint. We do NOT denylist IPs/hosts
 * (bypassable via DNS rebinding + encodings); instead the operator names the
 * exact origins this instance may delegate OAuth to.
 *
 * Each entry is a full origin (`https://broker.lobu.ai`,
 * `http://localhost:8787`); paths/queries are ignored. Invalid entries are
 * dropped. An unset/empty env yields an empty set → ALL broker fetches are
 * rejected (fail-closed): a broker-backed connection without a configured
 * allowlist must not fetch.
 */
function parseAllowedBrokerOrigins(): Set<string> {
  const raw = process.env.LOBU_ALLOWED_BROKER_ORIGINS?.trim();
  const origins = new Set<string>();
  if (!raw) return origins;
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // Skip malformed entries rather than failing open.
    }
  }
  return origins;
}

/**
 * Resolve the broker request URL and enforce the operator-configured origin
 * allowlist (SSRF control). Returns the full token-endpoint URL when the
 * broker's origin is allowlisted, or `null` (with a clear warning) otherwise —
 * the caller MUST NOT fetch on null.
 *
 * Rules:
 *   - Empty/unset allowlist → reject everything (fail-closed).
 *   - The request origin must be an exact member of the allowlist.
 *   - `https:` always; `http:` only for an explicitly-allowlisted loopback
 *     origin (so opt-in dev / self-broker works).
 *
 * NOTE: full DNS-rebinding protection (resolve the host, verify the connected
 * IP isn't private at fetch time) is a production hardening follow-up; the
 * origin allowlist is the primary control here.
 */
function resolveAllowedBrokerTokenUrl(
  brokerUrl: string,
  logContext: Record<string, unknown>
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(`${brokerUrl}/broker/oauth/token`);
  } catch {
    logger.warn({ ...logContext }, 'Broker URL is not a valid absolute URL');
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger.warn({ ...logContext, origin: parsed.origin }, 'Broker URL is not http(s)');
    return null;
  }

  const allowed = parseAllowedBrokerOrigins();
  if (allowed.size === 0) {
    logger.warn(
      { ...logContext, origin: parsed.origin },
      'Broker fetch rejected: LOBU_ALLOWED_BROKER_ORIGINS is unset/empty (fail-closed)'
    );
    return null;
  }
  if (!allowed.has(parsed.origin)) {
    logger.warn(
      { ...logContext, origin: parsed.origin },
      'Broker fetch rejected: origin not in LOBU_ALLOWED_BROKER_ORIGINS'
    );
    return null;
  }

  // https everywhere; http only for an explicitly-allowlisted loopback origin.
  const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  if (parsed.protocol === 'http:' && !isLoopback) {
    logger.warn(
      { ...logContext, origin: parsed.origin },
      'Broker fetch rejected: http is only allowed for an allowlisted loopback origin'
    );
    return null;
  }

  return parsed.toString();
}

/**
 * Fetch a fresh access token for a broker-backed connection from the remote
 * broker. The broker holds the grant + client secret and refreshes server-side;
 * we only ever receive `{ access_token, expires_at }`. No caller-supplied URLs:
 * the broker base URL + PAT + connection id come from the trusted typed
 * `oauth_broker` profile on the org. Returns null on any failure so the
 * connection simply resolves without credentials (fail-soft, like the local
 * path).
 *
 * SSRF: the broker origin MUST be in the operator-configured
 * `LOBU_ALLOWED_BROKER_ORIGINS` allowlist (fail-closed when unset). The local
 * instance POSTs its PAT to `broker_url`, so an attacker-controlled profile
 * could otherwise reach internal services / cloud metadata.
 *
 * The broker `pat` (the profile's `broker_pat` field) MUST be minted with the
 * `broker:token` scope — the broker's `/broker/oauth/token` gate rejects (403)
 * any PAT lacking it, so a broad member PAT cannot be used here. Mint with
 * `lobu token create --scope broker:token`.
 */
async function fetchBrokerAccessToken(
  broker: BrokerCredential,
  logContext: Record<string, unknown>
): Promise<{ access_token: string; expires_at: string | null } | null> {
  // Enforce the origin allowlist BEFORE any outbound request — a rejected
  // origin must produce zero network traffic.
  const tokenUrl = resolveAllowedBrokerTokenUrl(broker.url, logContext);
  if (!tokenUrl) return null;

  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${broker.pat}`,
      },
      body: JSON.stringify({ connection_id: broker.connectionId }),
    });
    if (!response.ok) {
      logger.warn(
        { ...logContext, status: response.status },
        'Broker token fetch failed'
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
    logger.warn({ ...logContext, error: errorMessage(error) }, 'Broker token fetch error');
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
