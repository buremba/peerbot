/**
 * Authentication middleware for Hono
 *
 * mcpAuth handles OAuth/PAT/session/anonymous.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../index';
import { getWorkspaceProvider } from '../workspace';
import { createAuth } from './index';
import type { AuthInfo } from './oauth/types';

// Extend Hono context with auth properties
declare module 'hono' {
  interface ContextVariableMap {
    user: {
      id: string;
      name: string;
      email: string;
      emailVerified: boolean;
      image?: string | null;
      phoneNumber?: string | null;
      phoneNumberVerified?: boolean | null;
    } | null;
    session: {
      id: string;
      userId: string;
      token: string;
      expiresAt: Date;
      activeOrganizationId?: string | null;
    } | null;
    organizationId: string | null;
    memberRole: string | null;
    mcpAuthInfo: AuthInfo | null;
    mcpIsAuthenticated: boolean;
    subdomainOrg: string | null;
    /**
     * How the current request authenticated. Set by `mcpAuth` /
     * `MultiTenantProvider.resolveAuth`. Admin-tier routes that previously
     * implicitly assumed web-session auth use this to refuse weak PATs.
     *
     * - `session`     — better-auth session cookie (web app)
     * - `pat`         — `owl_pat_*` bearer (Personal Access Token)
     * - `oauth`       — OAuth 2.1 access token bearer
     * - `cli-token`   — `lobu login` CLI token bearer
     * - `null`        — anonymous / unauthenticated request
     */
    authSource: 'session' | 'pat' | 'oauth' | 'cli-token' | null;
  }
}

/**
 * Middleware: Require valid session
 */
export async function requireAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = await createAuth(c.env);
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || !session.user) {
      return c.json({ error: 'Unauthorized', message: 'Valid session required' }, 401);
    }
    c.set('user', session.user);
    c.set('session', session.session);
    return next();
  } catch (error) {
    console.error('[Auth] Session check failed:', error);
    return c.json({ error: 'Unauthorized', message: 'Session validation failed' }, 401);
  }
}

/**
 * Middleware: MCP authentication (optional auth for MCP endpoints)
 * Delegates entirely to WorkspaceProvider.resolveAuth.
 */
export async function mcpAuth(c: Context<{ Bindings: Env }>, next: Next) {
  return getWorkspaceProvider().resolveAuth(c, next);
}
