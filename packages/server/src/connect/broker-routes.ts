/**
 * OAuth Broker Routes (SPIKE)
 *
 * Nango-style managed OAuth, Lobu-native. A LOCAL Lobu instance whose
 * `oauth_app` profile is a broker-ref (see `getBrokerRef`) does not hold the
 * provider's client_id/secret. Instead it delegates the secret-requiring OAuth
 * steps to a REMOTE Lobu instance — the "broker" — over these HTTP endpoints.
 *
 * Auth handshake: the local instance calls with `Authorization: Bearer
 * <owl_pat_*>`. The broker verifies the PAT (resolving the authenticated org +
 * tenant membership, exactly as the embedded Agent API does in
 * `createLobuAuthBridge`) and uses THAT org's managed `oauth_app` profile to
 * read the real client_id/secret. The broker performs the build/exchange/
 * refresh and returns ONLY the user's tokens — the client_secret never leaves
 * the broker.
 *
 * Endpoints (all POST, all PAT-gated):
 *   - /broker/oauth/authorize-url → buildAuthorizationUrl with broker's client_id
 *   - /broker/oauth/exchange      → exchangeCodeForTokens with broker's secret
 *   - /broker/oauth/refresh       → CredentialService.refreshTokenGeneric
 */

import type { Env } from '@lobu/connector-sdk';
import { Hono } from 'hono';
import { CredentialService } from '../auth/credentials';
import { PersonalAccessTokenService } from '../auth/tokens';
import { getDb } from '../db/client';
import { getPrimaryAuthProfileForKind, normalizeAuthValues } from '../utils/auth-profiles';
import logger from '../utils/logger';
import { buildAuthorizationUrl, exchangeCodeForTokens } from './oauth-providers';

type BrokerEnv = {
  Bindings: Env;
  Variables: { brokerOrgId: string };
};

const brokerRoutes = new Hono<BrokerEnv>();

/**
 * PAT auth for broker calls. Mirrors the authoritative PAT path in
 * `createLobuAuthBridge` (gateway.ts): verify the `owl_pat_*` bearer, reject
 * null-org or non-member tokens, and stash the resolved org on the context.
 * This IS the auth gate — no/invalid/cross-tenant PAT short-circuits 401/403.
 */
brokerRoutes.use('/oauth/*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const bearerMatch = authHeader ? /^bearer\s+(.*)$/i.exec(authHeader) : null;
  const bearerValue = bearerMatch ? (bearerMatch[1] ?? '').trim() : null;

  if (!bearerValue || bearerValue.slice(0, 8).toLowerCase() !== 'owl_pat_') {
    return c.json({ error: 'unauthorized', error_description: 'Bearer PAT required' }, 401);
  }

  const sql = getDb();
  const patInfo = await new PersonalAccessTokenService(sql).verify(bearerValue);
  if (!patInfo?.userId) {
    return c.json({ error: 'invalid_token', error_description: 'PAT invalid/expired/revoked' }, 401);
  }
  if (!patInfo.organizationId) {
    return c.json(
      { error: 'invalid_token', error_description: 'PAT not scoped to an organization' },
      401
    );
  }

  // Tenant-membership check — a PAT for org A must still belong to org A.
  const memberRows = (await sql`
    SELECT 1 FROM "member"
    WHERE "userId" = ${patInfo.userId}
      AND "organizationId" = ${patInfo.organizationId}
    LIMIT 1
  `) as unknown as Array<unknown>;
  if (memberRows.length === 0) {
    return c.json(
      { error: 'forbidden', error_description: 'Token owner is not a member of this organization' },
      403
    );
  }

  c.set('brokerOrgId', patInfo.organizationId);
  return next();
});

/**
 * Resolve the broker org's managed `oauth_app` client credentials for a
 * provider/connector. The broker reads its OWN org's profile — the local
 * caller never sees these values.
 */
async function resolveBrokerClientCredentials(params: {
  organizationId: string;
  provider: string;
  connectorKey: string;
  clientIdKey?: string;
  clientSecretKey?: string;
}): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const providerUpper = params.provider.toUpperCase();
  const clientIdKey = params.clientIdKey || `${providerUpper}_CLIENT_ID`;
  const clientSecretKey = params.clientSecretKey || `${providerUpper}_CLIENT_SECRET`;

  const appProfile = await getPrimaryAuthProfileForKind({
    organizationId: params.organizationId,
    connectorKey: params.connectorKey,
    profileKind: 'oauth_app',
    provider: params.provider,
  });

  const authValues = normalizeAuthValues(appProfile?.auth_data ?? {});
  return {
    clientId: authValues[clientIdKey] ?? null,
    clientSecret: authValues[clientSecretKey] ?? null,
  };
}

interface AuthorizeUrlBody {
  connector_key?: string;
  provider?: string;
  redirect_uri?: string;
  scopes?: string[];
  state?: string;
  code_challenge?: string;
  authorization_url?: string;
  auth_params?: Record<string, string>;
  client_id_key?: string;
}

/**
 * POST /broker/oauth/authorize-url
 * Build the provider authorization URL using the broker org's managed client_id.
 */
brokerRoutes.post('/oauth/authorize-url', async (c) => {
  const orgId = c.get('brokerOrgId');
  const body = await c.req.json<AuthorizeUrlBody>().catch(() => null);
  if (!body?.provider || !body.connector_key || !body.redirect_uri || !body.state) {
    return c.json(
      {
        error: 'bad_request',
        error_description: 'provider, connector_key, redirect_uri, state required',
      },
      400
    );
  }

  const { clientId } = await resolveBrokerClientCredentials({
    organizationId: orgId,
    provider: body.provider,
    connectorKey: body.connector_key,
    clientIdKey: body.client_id_key,
  });
  if (!clientId) {
    return c.json(
      { error: 'no_managed_app', error_description: `No managed oauth_app for ${body.provider}` },
      400
    );
  }

  const authorizationUrl = buildAuthorizationUrl({
    provider: body.provider,
    clientId,
    redirectUri: body.redirect_uri,
    scopes: body.scopes ?? [],
    state: body.state,
    authorizationUrl: body.authorization_url,
    authParams: body.auth_params,
    codeChallenge: body.code_challenge,
  });
  if (!authorizationUrl) {
    return c.json({ error: 'unsupported_provider', error_description: body.provider }, 400);
  }

  return c.json({ authorization_url: authorizationUrl });
});

interface ExchangeBody {
  connector_key?: string;
  provider?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  token_url?: string;
  token_endpoint_auth_method?: 'client_secret_post' | 'client_secret_basic' | 'none';
  client_id_key?: string;
  client_secret_key?: string;
}

/**
 * POST /broker/oauth/exchange
 * Exchange an authorization code for tokens using the broker org's managed
 * client_id/secret. Returns ONLY the user's tokens — never the client_secret.
 */
brokerRoutes.post('/oauth/exchange', async (c) => {
  const orgId = c.get('brokerOrgId');
  const body = await c.req.json<ExchangeBody>().catch(() => null);
  if (!body?.provider || !body.connector_key || !body.code || !body.redirect_uri) {
    return c.json(
      {
        error: 'bad_request',
        error_description: 'provider, connector_key, code, redirect_uri required',
      },
      400
    );
  }

  const { clientId, clientSecret } = await resolveBrokerClientCredentials({
    organizationId: orgId,
    provider: body.provider,
    connectorKey: body.connector_key,
    clientIdKey: body.client_id_key,
    clientSecretKey: body.client_secret_key,
  });
  if (!clientId) {
    return c.json(
      { error: 'no_managed_app', error_description: `No managed oauth_app for ${body.provider}` },
      400
    );
  }

  const tokens = await exchangeCodeForTokens({
    provider: body.provider,
    code: body.code,
    clientId,
    clientSecret,
    redirectUri: body.redirect_uri,
    tokenUrl: body.token_url,
    tokenEndpointAuthMethod: body.token_endpoint_auth_method,
    codeVerifier: body.code_verifier,
  });
  if (!tokens) {
    return c.json({ error: 'exchange_failed', error_description: 'Token exchange failed' }, 502);
  }

  return c.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: tokens.expiresIn,
    scope: tokens.scope,
    token_type: tokens.tokenType,
  });
});

interface RefreshBody {
  connector_key?: string;
  provider?: string;
  refresh_token?: string;
  token_url?: string;
  token_endpoint_auth_method?: 'client_secret_post' | 'client_secret_basic' | 'none';
  client_id_key?: string;
  client_secret_key?: string;
}

/**
 * POST /broker/oauth/refresh
 * Refresh an access token using the broker org's managed client_id/secret.
 */
brokerRoutes.post('/oauth/refresh', async (c) => {
  const orgId = c.get('brokerOrgId');
  const body = await c.req.json<RefreshBody>().catch(() => null);
  if (!body?.provider || !body.connector_key || !body.refresh_token || !body.token_url) {
    return c.json(
      {
        error: 'bad_request',
        error_description: 'provider, connector_key, refresh_token, token_url required',
      },
      400
    );
  }

  const { clientId, clientSecret } = await resolveBrokerClientCredentials({
    organizationId: orgId,
    provider: body.provider,
    connectorKey: body.connector_key,
    clientIdKey: body.client_id_key,
    clientSecretKey: body.client_secret_key,
  });
  if (!clientId) {
    return c.json(
      { error: 'no_managed_app', error_description: `No managed oauth_app for ${body.provider}` },
      400
    );
  }

  const refreshed = await new CredentialService(getDb()).refreshTokenGeneric({
    tokenUrl: body.token_url,
    clientId,
    clientSecret: clientSecret ?? undefined,
    refreshToken: body.refresh_token,
    authMethod: body.token_endpoint_auth_method,
  });
  if (!refreshed) {
    return c.json({ error: 'refresh_failed', error_description: 'Token refresh failed' }, 502);
  }

  logger.info({ provider: body.provider, organizationId: orgId }, 'Broker refreshed token');
  return c.json({
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken ?? null,
    expires_in: Math.max(0, Math.round((refreshed.expiresAt.getTime() - Date.now()) / 1000)),
  });
});

export { brokerRoutes };
