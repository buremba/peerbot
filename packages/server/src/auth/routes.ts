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
 * IPv4/IPv6 loopback peer check. Matches what
 * `packages/server/src/utils/loopback.ts:isLoopbackHost` did before it
 * was deleted in lobu#827, kept inline here so this file owns the
 * `/local-init` trust boundary without depending on that helper file
 * coming back.
 *
 * Accepts: 127.0.0.0/8, ::1, ::ffff:127.0.0.0/8 (IPv4-mapped IPv6).
 */
function isLoopbackAddress(addr: string): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '[::1]') return true;
  // IPv4-mapped IPv6 form Node sometimes hands us when bound to ::
  const ipv4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  return ipv4.startsWith('127.');
}

/**
 * Mint a Better Auth session for a user and return the Set-Cookie value.
 * Centralised so /exchange-token and /local-init produce identical cookies.
 */
async function mintSessionCookieValue(
  c: Context<{ Bindings: Env }>,
  userId: string
): Promise<{ cookieName: string; cookieHeader: string; sessionToken: string } | { error: string }> {
  const secret = c.env.BETTER_AUTH_SECRET;
  if (!secret) return { error: 'BETTER_AUTH_SECRET not set' };

  const auth = await createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);
  if (!session?.token) return { error: 'failed to mint session' };

  // Cookie shape: `<token>.<base64(HMAC-SHA256(token, secret))>`, URL-encoded.
  const sig = createHmac('sha256', secret).update(session.token).digest('base64');
  const cookieValue = encodeURIComponent(`${session.token}.${sig}`);
  // __Secure- prefix iff the canonical baseURL is https — matches whatever
  // Better Auth would set during normal sign-in even when TLS is terminated
  // by a reverse proxy and the bind itself speaks plain HTTP.
  const isHttps = resolveBaseUrl({ request: c.req.raw }).startsWith('https://');
  const cookieName = isHttps ? '__Secure-better-auth.session_token' : 'better-auth.session_token';
  const parts = [
    `${cookieName}=${cookieValue}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 7}`,
  ];
  if (isHttps) parts.push('Secure');
  return { cookieName, cookieHeader: parts.join('; '), sessionToken: session.token };
}

/**
 * Resolve a `?token=…` deep-link credential to a user id.
 *
 * Accepts either a Personal Access Token (`owl_pat_*`, validated against
 * `personal_access_tokens`) or a Better Auth session token (looked up in
 * `session`). The session-token path lets the macOS menu bar — which holds
 * a session token from POST /api/local-init — deep-link the user into
 * the SPA without ever issuing a PAT.
 */
async function resolveDeepLinkToken(
  c: Context<{ Bindings: Env }>,
  token: string
): Promise<string | null> {
  if (token.startsWith('owl_pat_')) {
    const sql = createDbClientFromEnv(c.env);
    const authInfo = await new PersonalAccessTokenService(sql).verify(token);
    return authInfo?.userId ?? null;
  }
  // Treat anything else as a session token. Better Auth's adapter looks it up
  // by the raw token (the unsigned half of the cookie value).
  const auth = await createAuth(c.env, c.req.raw);
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.findSession(token);
  return session?.session?.userId ?? null;
}

/**
 * Exchange a deep-link token (PAT or Better Auth session token) for a
 * Better Auth session cookie scoped to the same user, then 302 to `next`.
 *
 * Lets a holder of a valid bootstrap PAT / menu-bar session hop into the
 * web UI without typing a password. `next` is restricted to relative paths
 * to prevent open-redirect abuse; Referrer-Policy keeps the token out of
 * the next page's Referer.
 */
credentialRoutes.get('/exchange-token', async (c) => {
  c.header('Referrer-Policy', 'no-referrer');

  const token = c.req.query('token')?.trim();
  if (!token) {
    return c.json(
      { error: 'missing_token', error_description: 'token query param is required' },
      400
    );
  }

  const userId = await resolveDeepLinkToken(c, token);
  if (!userId) {
    return c.json(
      { error: 'invalid_token', error_description: 'token is invalid, expired, or revoked' },
      401
    );
  }

  const minted = await mintSessionCookieValue(c, userId);
  if ('error' in minted) {
    return c.json(
      { error: 'session_create_failed', error_description: minted.error },
      500
    );
  }
  c.header('Set-Cookie', minted.cookieHeader);

  const rawNext = c.req.query('next') ?? '/';
  const safeNext = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';
  return c.redirect(safeNext, 302);
});

/**
 * Mint a Better Auth session + worker PAT for the install's single user.
 *
 * Used by the macOS menu bar and the CLI's `local` context — both run on
 * the same host as the server, both want a credential they can send as
 * `Authorization: Bearer <session-token>` without prompting the user for
 * an OAuth device flow.
 *
 * Identity model: the install has exactly one user (enforced by
 * `LOBU_SINGLE_USER` + the sign-up-blocking hook in auth/index.tsx).
 * Whatever email the operator used at /sign-up is the identity; local-init
 * finds that user and mints credentials for them. There is no pre-seeded
 * placeholder. When the DB has zero users, we return `no_user_yet` and
 * point the caller at /sign-up.
 *
 * Trust model:
 *   - Refuses when any `x-forwarded-*` / `forwarded` header is present. A
 *     Tailscale Funnel / ngrok / cloudflared / nginx proxy fronting a
 *     loopback bind sets these — the bind looks local but the *exposure*
 *     isn't, so a public client could otherwise reach this endpoint.
 *   - Refuses when the deployment has more than one user (legacy bootstrap
 *     row counts as zero — see the `id <> 'bootstrap-user'` filter below).
 *   - Refuses when the single user has no personal org (shouldn't happen —
 *     databaseHooks.user.create.after provisions one).
 *
 * Returns the session token in the response body too, so non-cookie
 * clients (CLI persisting to ~/.config/lobu/credentials.json, Mac app
 * persisting in OAuthCredentials) can send it as Bearer next time.
 */

credentialRoutes.post('/local-init', async (c) => {
  // Defense-in-depth: the embedded runner defaults to a loopback bind,
  // but an operator may override HOST=0.0.0.0 and accidentally expose
  // /local-init to the LAN. Refuse any request whose actual TCP peer
  // isn't loopback. This is the *primary* trust boundary; the
  // forwarded-* + X-Lobu-Client checks below are extra layers.
  //
  // `peerRemoteAddress` is set by the env-swap middleware in server.ts /
  // start-local.ts before c.env is replaced with the app config object.
  const peer = c.var.peerRemoteAddress;
  if (peer && !isLoopbackAddress(peer)) {
    return c.json(
      {
        error: 'non_loopback_peer',
        error_description:
          '/api/local-init refuses non-loopback connections. The embedded runner should bind to 127.0.0.1; check HOST.',
      },
      403
    );
  }

  const proxied =
    c.req.header('x-forwarded-for') ||
    c.req.header('x-forwarded-host') ||
    c.req.header('x-forwarded-proto') ||
    c.req.header('x-real-ip') ||
    c.req.header('forwarded');
  if (proxied) {
    return c.json(
      {
        error: 'proxied_request_refused',
        error_description:
          '/api/local-init is for loopback callers only (Mac menu bar, local CLI). Forwarded-* headers are not allowed.',
      },
      403
    );
  }

  // CSRF gate: require a custom header so the only callers that can hit
  // this endpoint are ones that can mint custom headers AND survive a
  // CORS preflight — i.e. native clients (menubar, CLI) and browser
  // extensions with host_permissions (the Chrome extension). A random
  // malicious web page firing a no-preflight simple POST against
  // localhost:8787 from a victim's browser can't add this header, so the
  // browser would issue a preflight, which we don't allow for foreign
  // origins → request rejected before this handler runs.
  if (!c.req.header('x-lobu-client')) {
    return c.json(
      {
        error: 'missing_client_header',
        error_description:
          '/api/local-init requires the X-Lobu-Client header (CSRF mitigation). Native clients and browser extensions set it; plain web pages can\'t.',
      },
      403
    );
  }

  const sql = createDbClientFromEnv(c.env);
  // Find the single user this install belongs to. The historical design seeded
  // a fake `bootstrap-user` ahead of time and minted sessions for it — but
  // that created a fork the moment the operator signed up via web with a real
  // email (one identity for the Mac app + CLI, another for the web UI). Now we
  // skip the seed and mint for whichever real user signed up first; the
  // single-user-mode hook in auth/index.tsx prevents anyone else from joining.
  //
  // Exclude any leftover `bootstrap-user` rows from pre-this-change installs:
  // if both still exist, prefer the real user. After this lands, ensureBootstrap-
  // User is gone — fresh installs have no `bootstrap-user` row at all.
  const userRows = (await sql`
    SELECT id, email, name
      FROM "user"
     WHERE id <> 'bootstrap-user'
     ORDER BY "createdAt" ASC
     LIMIT 2
  `) as unknown as Array<{ id: string; email: string; name: string }>;

  if (userRows.length === 0) {
    return c.json(
      {
        error: 'no_user_yet',
        error_description:
          'No user exists yet on this install. Open the web UI and sign up first; the menubar / CLI will pick up the new user on the next /api/local-init call.',
        // Owletto's SPA routes signup via /auth/sign-up (mapped by
        // auth/$pathname.tsx → /auth/login?intent=sign-up). A bare /sign-up
        // would fall into the $owner catch-all and loop through the login
        // redirect — pre-PR-908 codex review caught this.
        signup_url: '/auth/sign-up',
      },
      404
    );
  }
  if (userRows.length > 1) {
    return c.json(
      {
        error: 'not_single_user',
        error_description:
          '/api/local-init is only for single-user local installs. This deployment has multiple users; sign in normally via /api/auth/sign-in/email.',
      },
      404
    );
  }
  const user = userRows[0]!;

  // Find the user's personal org (provisioned by databaseHooks.user.create.after).
  const orgRows = (await sql`
    SELECT id, slug, name
      FROM "organization"
     WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${user.id}
     LIMIT 1
  `) as unknown as Array<{ id: string; slug: string; name: string }>;
  const org = orgRows[0];
  if (!org) {
    return c.json(
      {
        error: 'personal_org_missing',
        error_description:
          "User exists but has no personal org. databaseHooks.user.create.after may not have run; can't mint a worker PAT without an org binding.",
      },
      500
    );
  }

  const minted = await mintSessionCookieValue(c, user.id);
  if ('error' in minted) {
    return c.json(
      { error: 'session_create_failed', error_description: minted.error },
      500
    );
  }
  c.header('Set-Cookie', minted.cookieHeader);

  // The session token alone is not enough for native worker callers — the
  // /api/workers/* middleware checks for `device_worker:run` / `mcp:admin`
  // in mcpAuthInfo.scopes, and a Better Auth session carries no scopes.
  // Mint a worker-scoped PAT alongside the session so the menu bar's
  // watcher poll loop and the Chrome extension's device-worker poll both
  // work zero-config. PostgreSQL still holds the truth (PAT hash in
  // `personal_access_tokens`, session row in `session`); nothing on disk.
  const workerPat = await new PersonalAccessTokenService(sql).create(
    user.id,
    org.id,
    'local-init',
    {
      description: 'Auto-minted by POST /api/local-init for local-runner clients.',
      scope: 'device_worker:run mcp:read mcp:write mcp:admin',
    }
  );

  return c.json({
    session_token: minted.sessionToken,
    cookie_name: minted.cookieName,
    // PAT plaintext — clients use this as `Authorization: Bearer <token>`
    // for everything (`/api/workers/poll`, MCP, REST). Long-lived; clients
    // are expected to persist in OS-level secure storage (Keychain,
    // chrome.storage.local, ~/.config/lobu/credentials.json).
    device_token: workerPat.token,
    device_token_scope: workerPat.scope,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    organization: {
      id: org.id,
      slug: org.slug,
      name: org.name,
    },
  });
});

export { credentialRoutes };
