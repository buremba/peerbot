/**
 * Shared OAuth refresh-token plumbing (RFC 6749 §6).
 *
 * Several call sites independently implemented the "build refresh form body /
 * client auth header / fetch token endpoint / parse token response" dance,
 * e.g. account-row token refresh (auth/credentials.ts) and the OAuth
 * base-client (gateway/auth/oauth/base-client.ts).
 *
 * The request/response mechanics live here; locking, persistence, and
 * logging stay with the callers. The two call sites historically differ in
 * exact wire details (Basic-credential encoding, client_id placement, the
 * legacy JSON body for stored device-code credentials), so the builder takes
 * a `profile` capturing each call site's established wire shape — changing
 * bytes on the wire is not this module's job.
 */

type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

/**
 * Wire profile for {@link buildRefreshRequest}:
 * - `mcp-credential` — gateway MCP credential refresh. Always sends
 *   `client_id` in the body, URL-encodes Basic credentials per
 *   RFC 6749 §2.3.1, sends `Accept: application/json`, and falls back to the
 *   legacy JSON body (secret inline) when no auth method is stored.
 * - `account-credential` — `account`-table token refresh. Form body only;
 *   with Basic auth the credentials go raw (unencoded) in the header and
 *   `client_id` is omitted from the body; defaults to `client_secret_post`.
 */
type RefreshWireProfile = 'mcp-credential' | 'account-credential';

interface RefreshRequestOptions {
  profile: RefreshWireProfile;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  /** Omitted on `mcp-credential` → legacy device-code JSON wire shape. */
  authMethod?: TokenEndpointAuthMethod;
  /** RFC 8707 resource indicator, included in the refresh body when set. */
  resource?: string;
}

interface RefreshHttpRequest {
  headers: Record<string, string>;
  body: string;
}

/** Build an RFC 6749 §2.3.1 Basic client-authentication header value. */
function buildBasicClientAuthHeader(
  clientId: string,
  clientSecret: string,
  options: { urlEncode: boolean }
): string {
  const pair = options.urlEncode
    ? `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
    : `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * Build the headers + body for a refresh-token grant request.
 * The caller performs the fetch (so it owns timeouts, logging, and locking).
 */
export function buildRefreshRequest(options: RefreshRequestOptions): RefreshHttpRequest {
  const { profile, clientId, clientSecret, refreshToken, authMethod, resource } = options;

  if (profile === 'mcp-credential') {
    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    };
    if (resource) {
      body.resource = resource;
    }

    const headers: Record<string, string> = { Accept: 'application/json' };

    if (!authMethod) {
      // Legacy device-code path — JSON body with secret inline.
      if (clientSecret) body.client_secret = clientSecret;
      headers['Content-Type'] = 'application/json';
      return { headers, body: JSON.stringify(body) };
    }

    // RFC 6749-compliant form-encoded refresh. Auth method drives where the
    // secret goes.
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (authMethod === 'client_secret_post' && clientSecret) {
      body.client_secret = clientSecret;
    } else if (authMethod === 'client_secret_basic' && clientSecret) {
      headers.Authorization = buildBasicClientAuthHeader(clientId, clientSecret, {
        urlEncode: true,
      });
    }
    return { headers, body: new URLSearchParams(body).toString() };
  }

  // account-credential profile
  const method = authMethod || 'client_secret_post';
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (method === 'client_secret_basic') {
    headers.Authorization = buildBasicClientAuthHeader(clientId, clientSecret || '', {
      urlEncode: false,
    });
  } else {
    body.set('client_id', clientId);
    if (method !== 'none' && clientSecret) {
      body.set('client_secret', clientSecret);
    }
  }
  return { headers, body: body.toString() };
}

interface ParsedRefreshedTokens {
  accessToken: string;
  /** New refresh token, or `previousRefreshToken` when the server didn't rotate. */
  refreshToken?: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAtMs: number;
}

/**
 * Validate and normalize a token-endpoint refresh response body.
 * Returns null when the payload has no string `access_token`.
 */
export function parseTokenRefreshResponse(
  data: Record<string, unknown>,
  options: { previousRefreshToken?: string; defaultExpiresInSeconds?: number } = {}
): ParsedRefreshedTokens | null {
  if (typeof data.access_token !== 'string') return null;

  const expiresInSeconds =
    typeof data.expires_in === 'number' ? data.expires_in : (options.defaultExpiresInSeconds ?? 3600);

  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === 'string' ? data.refresh_token : options.previousRefreshToken,
    expiresAtMs: Date.now() + expiresInSeconds * 1000,
  };
}
