/**
 * OAuth Scope Constants
 *
 * Single source of truth for all OAuth scope definitions.
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
