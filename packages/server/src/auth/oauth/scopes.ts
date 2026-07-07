/**
 * OAuth Scope Constants and Helpers
 *
 * Single source of truth for OAuth scope definitions and the helper utilities
 * that normalize, compare, and persist scope lists across auth_data records.
 */

/** All available scopes */
export const AVAILABLE_SCOPES = [
  'mcp:read',
  'mcp:write',
  'mcp:admin',
  'profile:read',
  'device_worker:run',
  // Least-privilege scope for the managed-connector runtime token fetch
  // (POST /oauth/connection-token). Deliberately NOT in DEFAULT_SCOPES so a
  // broad member PAT cannot mint managed-connection access tokens — the local
  // instance's LOBU_CLOUD_PAT must be minted explicitly with this scope
  // (`lobu token create --scope connections:token`).
  'connections:token',
] as const;

/** Default scopes for MCP access */
export const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'] as const;

/**
 * Scopes a Personal Access Token may be minted with (POST /api/:orgSlug/tokens).
 *
 * `device_worker:run` is deliberately excluded — it is only granted via the
 * device-flow consent. `connections:token` lets a PAT call
 * POST /oauth/connection-token to fetch a managed connector's access token
 * (the local instance's LOBU_CLOUD_PAT is minted with it); mintable here, but
 * NOT a default scope.
 */
export const AVAILABLE_PAT_SCOPES = [
  'mcp:read',
  'mcp:write',
  'mcp:admin',
  'profile:read',
  'connections:token',
] as const;

/**
 * Default scope requested when device-authing against an external MCP server
 * (gateway device-auth flow). Includes `profile:read` so the gateway can
 * introspect who the credential belongs to.
 */
export const DEFAULT_MCP_DEVICE_SCOPE = 'mcp:read mcp:write profile:read';

/**
 * The least-privilege scope a token must carry to fetch a managed connector's
 * access token via POST /oauth/connection-token.
 *
 * It is granted ONLY on the first-party `lobu login` device-code grant, and
 * only when that grant EXPLICITLY REQUESTS it (the CLI now includes
 * `connections:token` in the scope it sends to the device-authorization
 * endpoint; see `packages/cli/src/internal/oauth.ts`). The device-approve
 * handler grants exactly the requested scope — it is NOT auto-appended.
 *
 * It is NEVER granted on the generic authorization-code consent path (the one
 * arbitrary third-party MCP clients use — Claude Desktop, Cursor, …), and it is
 * never silently widened onto any device client that did not request it. A
 * non-interactive PAT (`lobu token create`) likewise does NOT get it by
 * default; it must be requested explicitly (`--scope connections:token`). This
 * keeps a broad `mcp` CI PAT — or any DCR-registered device client — from
 * minting managed-connection tokens, so the endpoint gate stays meaningful.
 */
export const CONNECTIONS_TOKEN_SCOPE = 'connections:token';

/** Default scopes as a space-separated string (for OAuth params) */
export const DEFAULT_SCOPES_STRING = DEFAULT_SCOPES.join(' ');

/**
 * Strip `mcp:admin` from a requested scope string when the user is not an
 * owner/admin of the target org. The runtime tool-access checks reject
 * admin-tier actions for non-admins anyway, so filtering at consent makes
 * the stored token scope match the user's actual privileges and avoids
 * a confusing "reconnect with admin access" error after grant.
 *
 * Returns `null` when the caller requested at least one scope but role-based
 * filtering removed all of them. The caller must reject the request with
 * `invalid_scope` (RFC 6749 §4.1.2.1) — silently persisting an empty grant
 * is unsafe because downstream parsing treats null/empty stored scope as the
 * default scope set, which would unintentionally widen privileges.
 */
export function filterScopeByRole(
  scope: string | undefined | null,
  memberRole: string | null
): string | null {
  const requested = (scope || '')
    .split(' ')
    .map((value) => value.trim())
    .filter(Boolean);
  const isAdmin = memberRole === 'owner' || memberRole === 'admin';
  const granted = isAdmin ? requested : requested.filter((s) => s !== 'mcp:admin');
  if (requested.length > 0 && granted.length === 0) {
    return null;
  }
  return granted.join(' ');
}

export function normalizeScopeList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(/[\s,]+/)
          .map((part) => part.trim())
          .filter(Boolean)
      : [];

  return Array.from(
    new Set(raw.filter((scope): scope is string => typeof scope === 'string').map((s) => s.trim()))
  ).filter(Boolean);
}

function equivalentScopes(scope: string): string[] {
  switch (scope) {
    case 'email':
    case 'https://www.googleapis.com/auth/userinfo.email':
      return ['email', 'https://www.googleapis.com/auth/userinfo.email'];
    case 'profile':
    case 'https://www.googleapis.com/auth/userinfo.profile':
      return ['profile', 'https://www.googleapis.com/auth/userinfo.profile'];
    default:
      return [scope];
  }
}

export function hasAllScopes(granted: Iterable<string>, required: Iterable<string>): boolean {
  const grantedSet = new Set<string>();
  for (const scope of granted) {
    const normalized = scope.trim();
    if (!normalized) continue;
    for (const equivalent of equivalentScopes(normalized)) {
      grantedSet.add(equivalent);
    }
  }
  for (const scope of required) {
    const normalized = scope.trim();
    if (!normalized) continue;
    if (!grantedSet.has(normalized)) return false;
  }
  return true;
}

export function readRequestedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.requested_scopes);
}

export function readGrantedScopesFromAuthData(
  authData: Record<string, unknown> | null | undefined
): string[] {
  return normalizeScopeList(authData?.granted_scopes);
}

export function mergeOAuthScopeAuthData(
  authData: Record<string, unknown> | null | undefined,
  params: {
    requestedScopes?: string[] | null;
    grantedScopes?: string[] | null;
    identity?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  return {
    ...(authData ?? {}),
    ...(params.requestedScopes
      ? { requested_scopes: normalizeScopeList(params.requestedScopes) }
      : {}),
    ...(params.grantedScopes ? { granted_scopes: normalizeScopeList(params.grantedScopes) } : {}),
    ...(params.identity ? { identity: params.identity } : {}),
  };
}

export function getFeedRequiredScopes(
  feedsSchema: Record<string, unknown> | null | undefined,
  feedKey: string
): string[] {
  if (!feedsSchema || typeof feedsSchema !== 'object' || Array.isArray(feedsSchema)) return [];
  const byKey = (feedsSchema as Record<string, Record<string, unknown>>)[feedKey];
  if (byKey && typeof byKey === 'object') {
    return normalizeScopeList(byKey.requiredScopes);
  }

  for (const value of Object.values(feedsSchema as Record<string, Record<string, unknown>>)) {
    if (value && typeof value === 'object' && value.key === feedKey) {
      return normalizeScopeList((value as Record<string, unknown>).requiredScopes);
    }
  }

  return [];
}
