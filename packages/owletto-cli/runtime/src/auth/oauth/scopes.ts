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
