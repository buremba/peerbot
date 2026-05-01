/**
 * OAuth 2.1 Routes
 *
 * HTTP endpoints for OAuth authorization server.
 * Implements RFC 8414 (AS Metadata), RFC 9728 (Protected Resource Metadata),
 * RFC 7591 (Dynamic Client Registration), and OAuth 2.1 core endpoints.
 */

import { Hono } from 'hono';
import { createDbClientFromEnv } from '../../db/client';
import type { Env } from '../../index';
import { getClientIP, getRateLimiter, RateLimitPresets } from '../../utils/rate-limiter';
import { resolveBaseUrl, safeOrigin, safeParseUrl } from '../base-url';
import { createAuth } from '../index';
import { requireAuth } from '../middleware';
import { OAuthProvider } from './provider';
import { DEFAULT_SCOPES_STRING, filterScopeByRole } from './scopes';
import type { AuthorizationParams, OAuthClientMetadata, TokenRequestParams } from './types';
import { createOAuthError, validateRedirectUri } from './utils';

const oauthRoutes = new Hono<{ Bindings: Env }>();

/**
 * Parse a request body that may be application/x-www-form-urlencoded or JSON.
 * Returns the parsed key-value pairs, or an error response.
 */
async function parseRequestBody(c: {
  req: {
    header: (name: string) => string | undefined;
    parseBody: () => Promise<Record<string, unknown>>;
    json: () => Promise<unknown>;
  };
}): Promise<Record<string, unknown> | Response> {
  const contentType = c.req.header('content-type') || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return (await c.req.parseBody()) as Record<string, unknown>;
  }
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return new Response(
      JSON.stringify(createOAuthError('invalid_request', 'Invalid request body')),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Helper to get API base URL from a Hono-style context.
 * Delegates to the shared `resolveBaseUrl()` utility.
 *
 * Skips PUBLIC_WEB_URL / LOBU_URL so OAuth discovery and endpoints always
 * reflect the domain that actually serves them (e.g. owletto.com), not a
 * downstream gateway domain that would need to proxy every /oauth/* request.
 */
function getBaseUrl(c: {
  env?: Env;
  req: { url: string; header?: (name: string) => string | undefined };
}): string {
  return resolveBaseUrl({
    header: c.req.header?.bind(c.req),
    url: c.req.url,
    skipEnvOverride: true,
  });
}

function isAllowedConsentOrigin(c: {
  env: Env;
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  const allowedOrigins = new Set<string>([new URL(c.req.url).origin, getBaseUrl(c)]);

  const originHeader = safeOrigin(c.req.header('origin'));
  if (originHeader) {
    return allowedOrigins.has(originHeader);
  }

  const refererHeader = c.req.header('referer');
  if (refererHeader) {
    const refererOrigin = safeOrigin(refererHeader);
    return refererOrigin !== null && allowedOrigins.has(refererOrigin);
  }

  return false;
}

function getRequestedScopes(scope: string | undefined | null): string[] {
  return (scope || DEFAULT_SCOPES_STRING)
    .split(' ')
    .map((value) => value.trim())
    .filter(Boolean);
}

function hasMcpScopes(scope: string | undefined | null): boolean {
  return getRequestedScopes(scope).some((value) => value.startsWith('mcp:'));
}

function getOrgSlugFromResource(resource: string | undefined | null): string | null {
  const parsed = safeParseUrl(resource);
  if (!parsed) return null;
  const match = parsed.pathname.match(/^\/mcp\/([^/]+)$/);
  const slug = match?.[1]?.trim();
  return slug && slug.length > 0 ? slug : null;
}

type OrgResolutionResult =
  | { organizationId: string; memberRole: string | null }
  | { error: ReturnType<typeof createOAuthError>; status: number }
  | { orgSelectionRequired: true; organizations: { id: unknown; name: unknown; slug: unknown }[] };

async function resolveOrganizationForGrant(params: {
  sql: ReturnType<typeof createDbClientFromEnv>;
  userId: string;
  resourceOrgSlug: string | null;
  explicitOrgId: string | undefined;
}): Promise<OrgResolutionResult> {
  const { sql, userId, resourceOrgSlug, explicitOrgId } = params;

  const lookupOrgAccess = async (column: 'slug' | 'id', value: string) => {
    if (column === 'slug') {
      return sql`
        SELECT
          o.id as organization_id,
          o.visibility,
          (
            SELECT m.role FROM "member" m
            WHERE m."organizationId" = o.id AND m."userId" = ${userId}
            LIMIT 1
          ) as member_role
        FROM "organization" o
        WHERE o.slug = ${value}
        LIMIT 1
      `;
    }

    return sql`
      SELECT
        o.id as organization_id,
        o.visibility,
        (
          SELECT m.role FROM "member" m
          WHERE m."organizationId" = o.id AND m."userId" = ${userId}
          LIMIT 1
        ) as member_role
      FROM "organization" o
      WHERE o.id = ${value}
      LIMIT 1
    `;
  };

  if (resourceOrgSlug) {
    const org = await lookupOrgAccess('slug', resourceOrgSlug);
    if (org.length === 0) {
      return {
        error: createOAuthError('invalid_request', `Organization '${resourceOrgSlug}' not found`),
        status: 400,
      };
    }
    const memberRole = (org[0].member_role as string | null) ?? null;
    const isMember = memberRole !== null;
    if (!isMember && org[0].visibility !== 'public') {
      return {
        error: createOAuthError('access_denied', 'Not a member of requested organization'),
        status: 403,
      };
    }
    return { organizationId: org[0].organization_id as string, memberRole };
  }

  if (explicitOrgId) {
    const org = await lookupOrgAccess('id', explicitOrgId);
    if (org.length === 0) {
      return {
        error: createOAuthError('access_denied', 'Not a member of the selected organization'),
        status: 403,
      };
    }
    const memberRole = (org[0].member_role as string | null) ?? null;
    const isMember = memberRole !== null;
    if (!isMember && org[0].visibility !== 'public') {
      return {
        error: createOAuthError('access_denied', 'Not a member of the selected organization'),
        status: 403,
      };
    }
    return { organizationId: org[0].organization_id as string, memberRole };
  }

  const memberships = await sql`
    SELECT m."organizationId" as organization_id, o.name, o.slug
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
    WHERE m."userId" = ${userId}
    ORDER BY m."createdAt" ASC
  `;

  if (memberships.length === 0) {
    return {
      error: createOAuthError('access_denied', 'No organization membership found for MCP scopes'),
      status: 403,
    };
  }

  return {
    orgSelectionRequired: true,
    organizations: memberships.map((m) => ({
      id: m.organization_id,
      name: m.name,
      slug: m.slug,
    })),
  };
}

/**
 * Helper to get OAuth provider
 */
function getProvider(c: { env: Env; req: { url: string } }): OAuthProvider {
  const sql = createDbClientFromEnv(c.env);
  const baseUrl = getBaseUrl(c);
  return new OAuthProvider(sql, baseUrl);
}

// ============================================
// Metadata Endpoints
// ============================================

/**
 * GET /.well-known/oauth-protected-resource
 * RFC 9728 - OAuth Protected Resource Metadata
 *
 * MCP clients fetch this first to discover authorization servers.
 */
oauthRoutes.get('/.well-known/oauth-protected-resource/:path{.+}', (c) => {
  const provider = getProvider(c);
  const metadata = provider.getProtectedResourceMetadata();
  const resourcePath = c.req.param('path');
  const origin = getBaseUrl(c);
  metadata.resource = `${origin}/${resourcePath}`;
  return c.json(metadata);
});

oauthRoutes.get('/.well-known/oauth-protected-resource', (c) => {
  const provider = getProvider(c);
  return c.json(provider.getProtectedResourceMetadata());
});

/**
 * GET /.well-known/openid-configuration
 * RFC 8414 - OAuth Authorization Server Metadata
 *
 * MCP clients fetch this to discover OAuth endpoints.
 */
oauthRoutes.get('/.well-known/openid-configuration', (c) => {
  const provider = getProvider(c);
  return c.json(provider.getAuthorizationServerMetadata());
});

// Also serve at /oauth-authorization-server for strict RFC 8414 compliance
oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const provider = getProvider(c);
  return c.json(provider.getAuthorizationServerMetadata());
});

// ============================================
// Dynamic Client Registration (RFC 7591)
// ============================================

/**
 * POST /oauth/register
 * Dynamic Client Registration
 *
 * MCP clients register themselves to get client_id and client_secret.
 * Rate limited to prevent abuse.
 */
oauthRoutes.post('/oauth/register', async (c) => {
  const provider = getProvider(c);

  // Rate limit client registrations
  if (c.env.RATE_LIMIT_ENABLED === 'true') {
    try {
      const rateLimiter = getRateLimiter();
      const clientIP = getClientIP(c.req.raw);
      const rateLimit = await rateLimiter.checkLimit(
        `rate:oauth:register:${clientIP}`,
        RateLimitPresets.OAUTH_REGISTER_PER_IP_HOUR
      );

      if (!rateLimit.allowed) {
        return c.json(createOAuthError('invalid_request', rateLimit.errorMessage), 429);
      }
    } catch (err) {
      console.warn('[OAuth] Rate limit check failed:', err);
      // Fail open - allow request if rate limiting fails
    }
  }

  let metadata: OAuthClientMetadata;
  try {
    metadata = await c.req.json();
  } catch {
    return c.json(createOAuthError('invalid_request', 'Invalid JSON body'), 400);
  }

  // Device flow clients don't require redirect_uris
  const hasDeviceGrant = metadata.grant_types?.includes(
    'urn:ietf:params:oauth:grant-type:device_code'
  );

  // Validate required fields (device flow clients can skip redirect_uris)
  if (!hasDeviceGrant && (!metadata.redirect_uris || metadata.redirect_uris.length === 0)) {
    return c.json(createOAuthError('invalid_request', 'redirect_uris is required'), 400);
  }

  // Default redirect_uris to empty array for device-only clients
  if (!metadata.redirect_uris) {
    metadata.redirect_uris = [];
  }

  // Ensure device_code grant type is in grant_types if registering for device flow
  if (hasDeviceGrant && metadata.grant_types) {
    if (!metadata.grant_types.includes('refresh_token')) {
      metadata.grant_types.push('refresh_token');
    }
  }

  // Validate redirect URIs
  for (const uri of metadata.redirect_uris) {
    if (!validateRedirectUri(uri)) {
      return c.json(
        createOAuthError(
          'invalid_request',
          `Invalid redirect_uri: ${uri}. Must be HTTPS (or http://localhost for development)`
        ),
        400
      );
    }
  }

  try {
    const client = await provider.clientsStore.registerClient(metadata);
    return c.json(client, 201);
  } catch (error) {
    console.error('[OAuth] Client registration failed:', error);
    return c.json(createOAuthError('server_error', 'Registration failed'), 500);
  }
});

// ============================================
// Authorization Endpoint
// ============================================

/**
 * GET /oauth/authorize
 * Authorization Endpoint
 *
 * Initiates the authorization flow. Redirects to consent page.
 * User must be authenticated (via better-auth session).
 */
oauthRoutes.get('/oauth/authorize', async (c) => {
  const provider = getProvider(c);

  // Extract OAuth parameters
  const params: AuthorizationParams = {
    client_id: c.req.query('client_id') || '',
    redirect_uri: c.req.query('redirect_uri') || '',
    response_type: c.req.query('response_type') as 'code',
    scope: c.req.query('scope'),
    state: c.req.query('state'),
    code_challenge: c.req.query('code_challenge') || '',
    code_challenge_method: c.req.query('code_challenge_method') as 'S256',
    resource: c.req.query('resource'),
  };

  // Validate required parameters
  if (!params.client_id) {
    return c.json(createOAuthError('invalid_request', 'client_id is required'), 400);
  }

  if (!params.redirect_uri) {
    return c.json(createOAuthError('invalid_request', 'redirect_uri is required'), 400);
  }

  if (params.response_type !== 'code') {
    return c.json(
      createOAuthError('unsupported_response_type', 'Only code response_type is supported'),
      400
    );
  }

  if (!params.code_challenge) {
    return c.json(createOAuthError('invalid_request', 'code_challenge is required (PKCE)'), 400);
  }

  if (params.code_challenge_method !== 'S256') {
    return c.json(
      createOAuthError('invalid_request', 'Only S256 code_challenge_method is supported'),
      400
    );
  }

  const requestedScopes = getRequestedScopes(params.scope);
  const requestedHasMcpScopes = requestedScopes.some((s) => s.startsWith('mcp:'));

  // Validate client
  const clientResult = await provider.getClientForAuthorization(
    params.client_id,
    params.redirect_uri
  );

  if ('error' in clientResult) {
    return c.json(clientResult, 400);
  }

  const client = clientResult;

  // Auto-approve for profile:read-only requests (no MCP scopes)
  // This skips the consent page for trusted first-party identity flows
  const isProfileOnly =
    !requestedHasMcpScopes && requestedScopes.every((s) => s === 'profile:read');

  if (isProfileOnly) {
    // Check if user has an active session
    const auth = await createAuth(c.env);
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        // User is logged in — auto-approve and redirect with code
        const code = await provider.createAuthorizationCode(params, session.user.id, null);
        const redirectUrl = new URL(params.redirect_uri);
        redirectUrl.searchParams.set('code', code);
        if (params.state) {
          redirectUrl.searchParams.set('state', params.state);
        }
        return c.redirect(redirectUrl.toString());
      }
    } catch {
      // No session — fall through to login redirect
    }

    // Not logged in — redirect to login page with callback to auto-approve
    const webUrl = getBaseUrl(c);
    const autoApproveUrl = new URL('/oauth/authorize', getBaseUrl(c));
    // Preserve all original params so the callback re-enters this handler
    autoApproveUrl.searchParams.set('client_id', params.client_id);
    autoApproveUrl.searchParams.set('redirect_uri', params.redirect_uri);
    autoApproveUrl.searchParams.set('response_type', 'code');
    autoApproveUrl.searchParams.set('scope', params.scope || 'profile:read');
    autoApproveUrl.searchParams.set('state', params.state || '');
    autoApproveUrl.searchParams.set('code_challenge', params.code_challenge);
    autoApproveUrl.searchParams.set('code_challenge_method', params.code_challenge_method);

    const loginUrl = new URL('/auth/login', webUrl);
    loginUrl.searchParams.set('callbackUrl', autoApproveUrl.toString());
    return c.redirect(loginUrl.toString());
  }

  // MCP scopes or other scopes — show consent page as before
  const webUrl = getBaseUrl(c);
  const consentUrl = new URL('/oauth/consent', webUrl);

  // Pass params to consent page via query string
  consentUrl.searchParams.set('client_id', params.client_id);
  consentUrl.searchParams.set('redirect_uri', params.redirect_uri);
  consentUrl.searchParams.set('scope', params.scope || DEFAULT_SCOPES_STRING);
  consentUrl.searchParams.set('state', params.state || '');
  consentUrl.searchParams.set('code_challenge', params.code_challenge);
  consentUrl.searchParams.set('code_challenge_method', params.code_challenge_method);
  if (params.resource) {
    consentUrl.searchParams.set('resource', params.resource);
  }
  consentUrl.searchParams.set('client_name', client.client_name || client.client_id);

  return c.redirect(consentUrl.toString());
});

/**
 * POST /oauth/authorize/consent
 * Consent submission endpoint
 *
 * Called by the consent page after user approves.
 * Requires authenticated session.
 */
oauthRoutes.post('/oauth/authorize/consent', requireAuth, async (c) => {
  const provider = getProvider(c);
  const user = c.get('user');
  const session = c.get('session');

  if (!user || !session) {
    return c.json(createOAuthError('access_denied', 'Authentication required'), 401);
  }

  if (!isAllowedConsentOrigin(c)) {
    return c.json(createOAuthError('access_denied', 'Invalid request origin'), 403);
  }

  let body: {
    client_id: string;
    redirect_uri: string;
    scope: string;
    state?: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    resource?: string;
    organization_id?: string;
    approved: boolean;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json(createOAuthError('invalid_request', 'Invalid JSON body'), 400);
  }

  const consentHasMcpScopes = hasMcpScopes(body.scope);

  // User denied consent
  if (!body.approved) {
    const redirectUrl = new URL(body.redirect_uri);
    redirectUrl.searchParams.set('error', 'access_denied');
    redirectUrl.searchParams.set('error_description', 'User denied consent');
    if (body.state) {
      redirectUrl.searchParams.set('state', body.state);
    }
    // Return JSON with redirect URL (frontend will do the redirect)
    // This is needed because fetch() doesn't handle cross-origin redirects well
    return c.json({ redirect_url: redirectUrl.toString() });
  }

  // Validate client again
  const clientResult = await provider.getClientForAuthorization(body.client_id, body.redirect_uri);

  if ('error' in clientResult) {
    return c.json(clientResult, 400);
  }

  // Create authorization code
  const params: AuthorizationParams = {
    client_id: body.client_id,
    redirect_uri: body.redirect_uri,
    response_type: 'code',
    scope: body.scope,
    state: body.state,
    code_challenge: body.code_challenge,
    code_challenge_method: body.code_challenge_method,
    resource: body.resource,
  };

  try {
    let organizationId: string | null = null;

    if (consentHasMcpScopes) {
      const sql = createDbClientFromEnv(c.env);
      const orgResult = await resolveOrganizationForGrant({
        sql,
        userId: user.id,
        resourceOrgSlug: getOrgSlugFromResource(body.resource),
        explicitOrgId: body.organization_id,
      });
      if ('error' in orgResult) {
        return c.json(orgResult.error, orgResult.status as 400);
      }
      if ('orgSelectionRequired' in orgResult) {
        return c.json(
          {
            error: 'org_selection_required',
            error_description: 'Please select an organization for this session',
            organizations: orgResult.organizations,
          },
          400
        );
      }
      organizationId = orgResult.organizationId;
      // Drop `mcp:admin` from the granted scope when the user is not an
      // owner/admin of the resolved org. Without this, a token can be issued
      // with admin scope that the runtime role check immediately rejects,
      // confusing the caller with a "reconnect with admin access" error.
      const filtered = filterScopeByRole(body.scope, orgResult.memberRole);
      if (filtered === null) {
        return c.json(
          createOAuthError(
            'invalid_scope',
            'Your role is not authorized for any of the requested scopes'
          ),
          400
        );
      }
      params.scope = filtered;
    }

    const code = await provider.createAuthorizationCode(params, user.id, organizationId);

    // Build redirect URL with authorization code
    const redirectUrl = new URL(body.redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (body.state) {
      redirectUrl.searchParams.set('state', body.state);
    }

    // Return JSON with redirect URL (frontend will do the redirect)
    // This is needed because fetch() doesn't handle cross-origin redirects well
    return c.json({ redirect_url: redirectUrl.toString() });
  } catch (error) {
    console.error('[OAuth] Failed to create authorization code:', error);
    return c.json(createOAuthError('server_error', 'Failed to create authorization code'), 500);
  }
});

// ============================================
// Device Authorization (RFC 8628)
// ============================================

/**
 * POST /oauth/device_authorization
 * Device Authorization Endpoint (RFC 8628 Section 3.1)
 *
 * Used by devices/CLI tools that cannot open a browser directly.
 * Returns a user_code and verification URL.
 */
oauthRoutes.post('/oauth/device_authorization', async (c) => {
  const provider = getProvider(c);

  const parsed = await parseRequestBody(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { client_id: string; scope?: string; resource?: string };

  if (!body.client_id) {
    return c.json(createOAuthError('invalid_request', 'client_id is required'), 400);
  }

  const result = await provider.createDeviceAuthorization(
    body.client_id,
    body.scope || null,
    body.resource || null
  );

  if ('error' in result) {
    return c.json(result, 400);
  }

  return c.json(result);
});

// GET /oauth/device is served by the SPA fallback (packages/web/src/app/oauth/device.tsx).
// No API route needed — the web app and API share the same origin.

/**
 * POST /oauth/device/approve
 * Device Code Approval Endpoint
 *
 * Called by the web app after user authenticates and approves the device code.
 */
oauthRoutes.post('/oauth/device/approve', requireAuth, async (c) => {
  const provider = getProvider(c);
  const user = c.get('user');
  const session = c.get('session');

  if (!user || !session) {
    return c.json(createOAuthError('access_denied', 'Authentication required'), 401);
  }

  if (!isAllowedConsentOrigin(c)) {
    return c.json(createOAuthError('access_denied', 'Invalid request origin'), 403);
  }

  let body: { user_code: string; approved: boolean; organization_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json(createOAuthError('invalid_request', 'Invalid JSON body'), 400);
  }

  if (!body.user_code) {
    return c.json(createOAuthError('invalid_request', 'user_code is required'), 400);
  }

  if (!body.approved) {
    await provider.denyDeviceCode(body.user_code);
    return c.json({ status: 'denied' });
  }

  // Look up the device code to check scope/resource
  const deviceCode = await provider.getDeviceCodeByUserCode(body.user_code);
  if (!deviceCode) {
    return c.json(createOAuthError('invalid_grant', 'Invalid or expired user code'), 400);
  }

  const deviceHasMcpScopes = hasMcpScopes(deviceCode.scope);
  let organizationId: string | null = null;
  let scopeOverride: string | null | undefined;

  if (deviceHasMcpScopes) {
    const sql = createDbClientFromEnv(c.env);
    const orgResult = await resolveOrganizationForGrant({
      sql,
      userId: user.id,
      resourceOrgSlug: getOrgSlugFromResource(deviceCode.resource),
      explicitOrgId: body.organization_id,
    });
    if ('error' in orgResult) {
      return c.json(orgResult.error, orgResult.status as 400);
    }
    if ('orgSelectionRequired' in orgResult) {
      return c.json(
        {
          error: 'org_selection_required',
          error_description: 'Please select an organization for this session',
          organizations: orgResult.organizations,
        },
        400
      );
    }
    organizationId = orgResult.organizationId;
    // Drop `mcp:admin` from the granted scope when the user is not an
    // owner/admin of the resolved org. See the consent submit handler for
    // the full rationale.
    scopeOverride = filterScopeByRole(deviceCode.scope, orgResult.memberRole);
    if (scopeOverride === null) {
      return c.json(
        createOAuthError(
          'invalid_scope',
          'Your role is not authorized for any of the requested scopes'
        ),
        400
      );
    }
  }

  const approved = await provider.approveDeviceCode(
    body.user_code,
    user.id,
    organizationId,
    scopeOverride
  );
  if (!approved) {
    return c.json(createOAuthError('invalid_grant', 'Failed to approve device code'), 400);
  }

  return c.json({ status: 'approved' });
});

// ============================================
// Token Endpoint
// ============================================

/**
 * POST /oauth/token
 * Token Endpoint
 *
 * Exchange authorization code for tokens, or refresh tokens.
 */
oauthRoutes.post('/oauth/token', async (c) => {
  const provider = getProvider(c);

  // Parse body (application/x-www-form-urlencoded or JSON)
  const parsed = await parseRequestBody(c);
  if (parsed instanceof Response) return parsed;
  const params = parsed as unknown as TokenRequestParams;

  // Check for Basic auth header
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [clientId, clientSecret] = decoded.split(':');
    if (clientId && !params.client_id) {
      params.client_id = clientId;
    }
    if (clientSecret && !params.client_secret) {
      params.client_secret = clientSecret;
    }
  }

  // Validate required params
  if (!params.grant_type) {
    return c.json(createOAuthError('invalid_request', 'grant_type is required'), 400);
  }

  if (!params.client_id) {
    return c.json(createOAuthError('invalid_request', 'client_id is required'), 400);
  }

  // Handle different grant types
  let result;

  switch (params.grant_type) {
    case 'authorization_code':
      result = await provider.exchangeAuthorizationCode(params);
      break;

    case 'refresh_token':
      result = await provider.refreshAccessToken(params);
      break;

    case 'urn:ietf:params:oauth:grant-type:device_code':
      result = await provider.exchangeDeviceCode(params);
      break;

    default:
      return c.json(
        createOAuthError('unsupported_grant_type', `Unsupported grant_type: ${params.grant_type}`),
        400
      );
  }

  if ('error' in result) {
    return c.json(result, 400);
  }

  return c.json(result);
});

// ============================================
// UserInfo Endpoint
// ============================================

/**
 * GET /oauth/userinfo
 * Returns user profile for the authenticated access token.
 * Requires `profile:read` scope.
 */
oauthRoutes.get('/oauth/userinfo', async (c) => {
  const provider = getProvider(c);

  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(createOAuthError('invalid_request', 'Missing Bearer token'), 401);
  }

  const token = authHeader.slice(7);
  const userInfo = await provider.getUserInfo(token);

  if (!userInfo) {
    return c.json(createOAuthError('access_denied', 'Invalid token or insufficient scope'), 403);
  }

  return c.json(userInfo);
});

// ============================================
// Token Revocation (RFC 7009)
// ============================================

/**
 * POST /oauth/revoke
 * Token Revocation Endpoint
 */
oauthRoutes.post('/oauth/revoke', async (c) => {
  const provider = getProvider(c);

  const parsed = await parseRequestBody(c);
  if (parsed instanceof Response) return parsed;
  const params = parsed as { token: string; client_id: string; client_secret?: string };

  if (!params.token || !params.client_id) {
    return c.json(createOAuthError('invalid_request', 'token and client_id are required'), 400);
  }

  // Look up the client to determine authentication requirements
  const client = await provider.clientsStore.getClient(params.client_id);
  if (!client) {
    return c.json(createOAuthError('invalid_client', 'Unknown client'), 401);
  }

  // Confidential clients must authenticate with client_secret
  const isConfidential = client.token_endpoint_auth_method !== 'none';
  if (isConfidential) {
    if (!params.client_secret) {
      return c.json(
        createOAuthError('invalid_client', 'client_secret is required for confidential clients'),
        401
      );
    }
    const isValid = await provider.clientsStore.verifyClientCredentials(
      params.client_id,
      params.client_secret
    );
    if (!isValid) {
      return c.json(createOAuthError('invalid_client', 'Invalid client credentials'), 401);
    }
  }

  await provider.revokeToken(params.token, params.client_id);

  // RFC 7009: Always return 200 OK, even if token was already revoked
  return c.json({ revoked: true });
});

export { oauthRoutes };
