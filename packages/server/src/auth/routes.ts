/**
 * Authentication & Account Routes
 *
 * REST endpoints for account and token management:
 * - GET /api/accounts - List user's linked OAuth accounts
 * - GET /api/agents - List OAuth agents (clients) for an organization
 * - POST /api/:orgSlug/tokens - Create org-scoped personal access tokens
 */

import { createHmac } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { createDbClientFromEnv } from '../db/client';
import type { Env } from '../index';
import { errorMessage } from '../utils/errors';
import { resolveBaseUrl } from './base-url';
import { createAuth } from './index';
import { mcpAuth, requireAuth } from './middleware';
import { OAuthClientsStore } from './oauth/clients';
import { PersonalAccessTokenService } from './tokens';

const credentialRoutes = new Hono<{ Bindings: Env }>();

function getAuthenticatedUser(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user) {
    throw new Error('Authenticated user missing from context');
  }
  return user;
}

/**
 * List user's linked OAuth accounts
 */
credentialRoutes.get('/accounts', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const sql = createDbClientFromEnv(c.env);

  const result = await sql`
    SELECT
      id,
      "accountId",
      "providerId",
      "accessToken" IS NOT NULL as "hasAccessToken",
      "refreshToken" IS NOT NULL as "hasRefreshToken",
      "accessTokenExpiresAt",
      scope,
      "createdAt"
    FROM "account"
    WHERE "userId" = ${user.id}
    ORDER BY "createdAt" DESC
  `;
  return c.json({ accounts: result });
});

// ============================================
// OAuth Agents Routes
// ============================================

/**
 * List OAuth agents (clients) for an organization
 */
credentialRoutes.get('/agents', requireAuth, async (c) => {
  const user = getAuthenticatedUser(c);
  const orgSlug = c.req.query('org_slug');

  const sql = createDbClientFromEnv(c.env);

  let organizationId: string;

  if (orgSlug) {
    const membership = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      JOIN "organization" o ON o.id = m."organizationId"
      WHERE m."userId" = ${user.id}
        AND o.slug = ${orgSlug}
      LIMIT 1
    `;
    if (membership.length === 0) {
      return c.json({ error: `Not a member of organization '${orgSlug}'` }, 403);
    }
    organizationId = membership[0].organization_id as string;
  } else {
    // Fall back to user's first org membership
    const defaultOrg = await sql`
      SELECT m."organizationId" as organization_id
      FROM "member" m
      WHERE m."userId" = ${user.id}
      ORDER BY m."createdAt" ASC
      LIMIT 1
    `;
    if (defaultOrg.length === 0) {
      return c.json({ error: 'No organization membership found' }, 404);
    }
    organizationId = defaultOrg[0].organization_id as string;
  }
  const clientsStore = new OAuthClientsStore(sql);
  const agents = await clientsStore.listClientsByOrganization(organizationId);

  return c.json({ agents });
});

// ============================================
// Org-scoped Personal Access Token Routes
// ============================================

const AVAILABLE_PAT_SCOPES = new Set(['mcp:read', 'mcp:write', 'mcp:admin', 'profile:read']);
const DEFAULT_PAT_SCOPE = 'mcp:read mcp:write';
const MAX_PAT_EXPIRY_DAYS = 3650;

function authorizeTokenCreation(c: Context<{ Bindings: Env }>) {
  const user = c.get('user');
  if (!user?.id) {
    return { error: c.json({ error: 'Unauthorized', message: 'Authentication required' }, 401) };
  }

  const organizationId = c.get('organizationId');
  if (!organizationId) {
    return { error: c.json({ error: 'Organization slug is required in URL' }, 400) };
  }

  const role = c.get('memberRole');
  if (role !== 'owner' && role !== 'admin') {
    return { error: c.json({ error: 'Token creation requires org owner or admin access' }, 403) };
  }

  const authSource = c.get('authSource');
  if (authSource === 'pat') {
    return {
      error: c.json(
        { error: 'Use `lobu login` with OAuth or a web session to create server tokens' },
        403
      ),
    };
  }

  const scopes = c.get('mcpAuthInfo')?.scopes ?? [];
  if (authSource === 'oauth' && !scopes.includes('mcp:admin')) {
    return { error: c.json({ error: 'Token creation requires mcp:admin scope' }, 403) };
  }

  return { user, organizationId };
}

function normalizePatScope(scope: unknown): string | undefined {
  if (scope === undefined || scope === null || scope === '') return DEFAULT_PAT_SCOPE;
  if (typeof scope !== 'string') {
    throw new Error('scope must be a space-separated string');
  }
  const scopes = Array.from(new Set(scope.split(/\s+/).map((value) => value.trim()).filter(Boolean)));
  if (scopes.length === 0) return DEFAULT_PAT_SCOPE;
  const invalid = scopes.filter((value) => !AVAILABLE_PAT_SCOPES.has(value));
  if (invalid.length > 0) {
    throw new Error(`Invalid scope(s): ${invalid.join(', ')}`);
  }
  return scopes.join(' ');
}

function normalizeExpiryDays(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_PAT_EXPIRY_DAYS) {
    throw new Error(`expiresInDays must be an integer between 1 and ${MAX_PAT_EXPIRY_DAYS}`);
  }
  return days;
}

/**
 * Create an org-scoped Personal Access Token for servers/CI.
 * Requires an owner/admin web session or OAuth bearer with mcp:admin scope.
 */
credentialRoutes.post('/:orgSlug/tokens', mcpAuth, async (c) => {
  const authorized = authorizeTokenCreation(c);
  if ('error' in authorized) return authorized.error;

  const body = await c.req.json<{
    name?: string;
    description?: string;
    scope?: string;
    expiresInDays?: number;
  }>();

  const name = body.name?.trim();
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const description = typeof body.description === 'string' ? body.description.trim() : undefined;
  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);

  try {
    const token = await patService.create(authorized.user.id, authorized.organizationId, name, {
      ...(description ? { description } : {}),
      scope: normalizePatScope(body.scope),
      expiresInDays: normalizeExpiryDays(body.expiresInDays),
    });
    return c.json({ token }, 201);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 400);
  }
});

/**
 * Exchange a Personal Access Token for a Better Auth session cookie.
 *
 * Lets a holder of a valid PAT (CLI users, the macOS menu-bar app, deep links
 * from the operator's terminal) hop into the web UI without typing a password.
 * The endpoint validates the PAT, mints a fresh session row tied to the same
 * user, signs the session token with BETTER_AUTH_SECRET (matching what
 * Better Auth would set), and 302-redirects to `next` (default `/`).
 *
 * `next` is restricted to relative paths to prevent open-redirect abuse. The
 * Referrer-Policy header keeps the PAT out of the next page's Referer.
 */
credentialRoutes.get('/exchange-token', async (c) => {
  // Don't leak the PAT into the next request's Referer header.
  c.header('Referrer-Policy', 'no-referrer');

  const token = c.req.query('token')?.trim();
  if (!token) {
    return c.json({ error: 'missing_token', error_description: 'token query param is required' }, 400);
  }

  const sql = createDbClientFromEnv(c.env);
  const patService = new PersonalAccessTokenService(sql);
  const authInfo = await patService.verify(token);
  if (!authInfo) {
    return c.json({ error: 'invalid_token', error_description: 'token is invalid, expired, or revoked' }, 401);
  }

  const secret = c.env.BETTER_AUTH_SECRET;
  if (!secret) {
    return c.json(
      { error: 'server_misconfigured', error_description: 'BETTER_AUTH_SECRET not set' },
      500
    );
  }

  const auth = await createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(authInfo.userId);
  if (!session?.token) {
    return c.json({ error: 'session_create_failed', error_description: 'failed to mint session' }, 500);
  }

  // Match Better Auth's cookie shape: `<token>.<base64(HMAC-SHA256(token, secret))>`,
  // URL-encoded. Cookie name picks up the __Secure- prefix when the request
  // arrived over HTTPS so it stays compatible with the prod baseURL rule.
  const sig = createHmac('sha256', secret).update(session.token).digest('base64');
  const cookieValue = encodeURIComponent(`${session.token}.${sig}`);
  // Match Better Auth's cookie-prefix rule: __Secure- iff the public baseURL
  // is https. Resolve via the same helper used during sign-in so the prefix
  // matches even when TLS is terminated by a reverse proxy (Tailscale Funnel,
  // nginx, cloudflared) and the loopback bind itself speaks plain HTTP.
  const isHttps = resolveBaseUrl({ request: c.req.raw }).startsWith('https://');
  const cookieName = isHttps ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
  const cookieParts = [
    `${cookieName}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 7}`,
  ];
  if (isHttps) cookieParts.push('Secure');
  c.header('Set-Cookie', cookieParts.join('; '));

  const rawNext = c.req.query('next') ?? '/';
  const safeNext = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  return c.redirect(safeNext, 302);
});

export { credentialRoutes };
