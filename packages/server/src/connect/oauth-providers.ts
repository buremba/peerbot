/**
 * OAuth Provider Configurations & Helpers
 *
 * Provider-specific OAuth URLs, token exchange, and user info fetching.
 * Used by the Connect Link flow for unauthenticated OAuth completion.
 */

import logger from '../utils/logger';

type OAuthTokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

interface OAuthProviderConfig {
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
  /** Extra params to include in the authorization URL */
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
}

const providers: Record<string, OAuthProviderConfig> = {
  google: {
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    authParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  github: {
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  microsoft: {
    authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    authParams: {
      response_mode: 'query',
    },
    tokenEndpointAuthMethod: 'client_secret_post',
  },
  reddit: {
    authorizationUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    userinfoUrl: 'https://oauth.reddit.com/api/v1/me',
    authParams: {
      duration: 'permanent',
      response_type: 'code',
    },
    tokenEndpointAuthMethod: 'client_secret_basic',
  },
};

export function getBuiltinProviderConfig(provider: string): OAuthProviderConfig | null {
  return providers[provider] ?? null;
}

function resolveProviderConfig(params: {
  provider: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
}): OAuthProviderConfig | null {
  const builtIn = providers[params.provider] ?? null;

  const authorizationUrl = params.authorizationUrl ?? builtIn?.authorizationUrl;
  const tokenUrl = params.tokenUrl ?? builtIn?.tokenUrl;
  const userinfoUrl = params.userinfoUrl ?? builtIn?.userinfoUrl;
  const authParams = {
    ...(builtIn?.authParams ?? {}),
    ...(params.authParams ?? {}),
  };
  const tokenEndpointAuthMethod =
    params.tokenEndpointAuthMethod ?? builtIn?.tokenEndpointAuthMethod ?? 'client_secret_post';

  if (!authorizationUrl || !tokenUrl) return null;

  return {
    authorizationUrl,
    tokenUrl,
    ...(userinfoUrl ? { userinfoUrl } : {}),
    ...(Object.keys(authParams).length > 0 ? { authParams } : {}),
    tokenEndpointAuthMethod,
  };
}

/**
 * Build the OAuth authorization URL
 */
export function buildAuthorizationUrl(params: {
  provider: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  authorizationUrl?: string;
  authParams?: Record<string, string>;
  codeChallenge?: string;
}): string | null {
  const config = resolveProviderConfig({
    provider: params.provider,
    authorizationUrl: params.authorizationUrl,
    authParams: params.authParams,
    tokenUrl: 'https://example.invalid/token',
  });
  if (!config) return null;

  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);

  url.searchParams.set('scope', params.scopes.join(' '));

  // Add provider-specific or connector-specific extra params
  if (config.authParams) {
    for (const [key, value] of Object.entries(config.authParams)) {
      url.searchParams.set(key, value);
    }
  }

  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return url.toString();
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  tokenType: string;
}

/**
 * Exchange an authorization code for tokens
 */
export async function exchangeCodeForTokens(params: {
  provider: string;
  code: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUri: string;
  tokenUrl?: string;
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  codeVerifier?: string;
}): Promise<OAuthTokens | null> {
  const config = resolveProviderConfig({
    provider: params.provider,
    tokenUrl: params.tokenUrl,
    tokenEndpointAuthMethod: params.tokenEndpointAuthMethod,
    authorizationUrl: 'https://example.invalid/authorize',
  });
  if (!config) return null;

  const authMethod = config.tokenEndpointAuthMethod ?? 'client_secret_post';

  const bodyParams: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
  };

  if (params.codeVerifier) {
    bodyParams.code_verifier = params.codeVerifier;
  }

  if (authMethod === 'client_secret_post') {
    bodyParams.client_id = params.clientId;
    if (params.clientSecret) {
      bodyParams.client_secret = params.clientSecret;
    }
  } else if (authMethod === 'none') {
    bodyParams.client_id = params.clientId;
  }

  const body = new URLSearchParams(bodyParams);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (authMethod === 'client_secret_basic') {
    const credentials = Buffer.from(`${params.clientId}:${params.clientSecret || ''}`).toString(
      'base64'
    );
    headers.Authorization = `Basic ${credentials}`;
  }

  // GitHub returns JSON only if Accept header is set
  if (params.provider === 'github') {
    headers.Accept = 'application/json';
  }

  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      logger.error(
        { provider: params.provider, status: response.status, body: text },
        'OAuth token exchange failed'
      );
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;

    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresIn: (data.expires_in as number) ?? null,
      scope: (data.scope as string) ?? null,
      tokenType: (data.token_type as string) ?? 'Bearer',
    };
  } catch (error) {
    logger.error({ provider: params.provider, error }, 'OAuth token exchange error');
    return null;
  }
}

interface OAuthUserInfo {
  id: string;
  email: string | null;
  name: string | null;
}

async function fetchRawUserInfo(params: {
  provider: string;
  accessToken: string;
  userinfoUrl?: string;
}): Promise<Record<string, unknown> | null> {
  const config = resolveProviderConfig({
    provider: params.provider,
    userinfoUrl: params.userinfoUrl,
    authorizationUrl: 'https://example.invalid/authorize',
    tokenUrl: 'https://example.invalid/token',
  });
  if (!config?.userinfoUrl) return null;

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.accessToken}`,
    };

    // Reddit requires a User-Agent header for all API calls
    if (params.provider === 'reddit') {
      headers['User-Agent'] = 'owletto:connector:v1.0 (by /u/owletto)';
    }

    const response = await fetch(config.userinfoUrl, { headers });

    if (!response.ok) return null;

    const rawData = (await response.json()) as Record<string, unknown>;
    return rawData.data && typeof rawData.data === 'object'
      ? (rawData.data as Record<string, unknown>)
      : rawData;
  } catch (error) {
    logger.error({ provider: params.provider, error }, 'OAuth userinfo fetch error');
    return null;
  }
}

/**
 * Fetch raw and normalized user info in a single HTTP call.
 */
export async function fetchUserInfoWithRaw(params: {
  provider: string;
  accessToken: string;
  userinfoUrl?: string;
}): Promise<{ raw: Record<string, unknown> | null; normalized: OAuthUserInfo | null }> {
  const raw = await fetchRawUserInfo(params);
  if (!raw) return { raw: null, normalized: null };
  return { raw, normalized: normalizeUserInfo(params.provider, raw) };
}

function normalizeUserInfo(provider: string, data: Record<string, unknown>): OAuthUserInfo | null {
  try {
    switch (provider) {
      case 'google':
        return {
          id: String(data.id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? null,
        };
      case 'github':
        return {
          id: String(data.id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? (data.login as string) ?? null,
        };
      case 'microsoft':
        return {
          id: String(data.id),
          email: (data.mail as string) ?? (data.userPrincipalName as string) ?? null,
          name: (data.displayName as string) ?? null,
        };
      case 'reddit':
        return {
          id: String(data.id),
          email: null,
          name: (data.name as string) ?? null,
        };
      default: {
        const id = data.id ?? data.sub;
        if (id === undefined || id === null) return null;
        return {
          id: String(id),
          email: (data.email as string) ?? null,
          name: (data.name as string) ?? (data.username as string) ?? null,
        };
      }
    }
  } catch (error) {
    logger.error({ provider, error }, 'OAuth userinfo normalization error');
    return null;
  }
}
