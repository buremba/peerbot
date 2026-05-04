/**
 * OAuth Scope Constants and Helpers
 *
 * Single source of truth for OAuth scope definitions and the helper utilities
 * that normalize, compare, and persist scope lists across auth_data records.
 */

/** All available scopes */
export const AVAILABLE_SCOPES = ['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read'] as const;

/** Default scopes for MCP access */
export const DEFAULT_SCOPES = ['mcp:read', 'mcp:write'] as const;

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

export function hasAllScopes(granted: Iterable<string>, required: Iterable<string>): boolean {
  const grantedSet = new Set(
    Array.from(granted)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
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
