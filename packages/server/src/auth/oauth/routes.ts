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
import { findExistingPersonalOrg } from '../personal-org-provisioning';
import { buildAuthMd } from './auth-md';
import { OAuthProvider } from './provider';
import { canonicalizeMcpResource, publicMcpRequestUrl } from './resource-indicator';
import {
  DEFAULT_SCOPES_STRING,
  filterScopeByRole,
  stripNonPublicOAuthScopes,
} from './scopes';
import type { AuthorizationParams, OAuthClientMetadata, TokenRequestParams } from './types';
import { createOAuthError, validateRedirectUri } from './utils';
import {
  canonicalizeGrantedOrganizationIds,
  type GrantedMemberWorkspace,
  isMultiWorkspaceGrantIssuanceEnabled,
  listLiveGrantedMemberWorkspaces,
  MAX_GRANTED_ORGANIZATIONS,
} from './workspace-grants';
import { getConfiguredPublicOrigin } from '../../utils/public-origin';
import { resolveSession } from '../resolve-session';

const oauthRoutes = new Hono<{ Bindings: Env }>();
const INVALID_DEVICE_CODE_MESSAGE = 'Invalid or expired user code';

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
 * Skips PUBLIC_GATEWAY_URL so OAuth discovery and endpoints always
 * reflect the domain that actually serves them (e.g. lobu.com), not a
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

function isBareMcpResource(resource: string | undefined | null): boolean {
  const parsed = safeParseUrl(resource);
  return parsed?.pathname === '/mcp';
}

type WorkspaceAccessMode = 'all_current' | 'selected';

async function resolveSubmittedWorkspaceGrant(params: {
  sql: ReturnType<typeof createDbClientFromEnv>;
  userId: string;
  organizationIds: unknown;
  anchorOrganizationId: unknown;
  workspaceAccess: unknown;
  multiWorkspaceGrantsEnabled: boolean;
}): Promise<
  | {
      organizationId: string;
      memberRole: string;
      grantedOrganizationIds: string[];
      liveGrantedWorkspaces: GrantedMemberWorkspace[];
    }
  | { error: ReturnType<typeof createOAuthError>; status: number }
> {
  if (params.workspaceAccess !== 'all_current' && params.workspaceAccess !== 'selected') {
    return {
      error: createOAuthError('invalid_request', 'A valid workspace access selection is required'),
      status: 400,
    };
  }
  if (
    !Array.isArray(params.organizationIds) ||
    !params.organizationIds.every((id): id is string => typeof id === 'string')
  ) {
    return {
      error: createOAuthError(
        'invalid_request',
        'organization_ids must be an array of workspace IDs'
      ),
      status: 400,
    };
  }

  const grantedOrganizationIds = canonicalizeGrantedOrganizationIds(params.organizationIds);
  if (
    grantedOrganizationIds.length === 0 ||
    grantedOrganizationIds.length > MAX_GRANTED_ORGANIZATIONS
  ) {
    return {
      error: createOAuthError('invalid_request', 'The workspace selection is empty or too large'),
      status: 400,
    };
  }
  if (grantedOrganizationIds.length > 1 && !params.multiWorkspaceGrantsEnabled) {
    return {
      error: createOAuthError(
        'invalid_request',
        'Multiple-workspace authorization is not enabled'
      ),
      status: 400,
    };
  }

  const organizationId =
    typeof params.anchorOrganizationId === 'string' ? params.anchorOrganizationId.trim() : '';
  if (!organizationId || !grantedOrganizationIds.includes(organizationId)) {
    return {
      error: createOAuthError('invalid_request', 'The primary workspace must be selected'),
      status: 400,
    };
  }

  const workspaces = await listLiveGrantedMemberWorkspaces({
    sql: params.sql,
    userId: params.userId,
    grantedOrganizationIds,
  });
  if (workspaces.length !== grantedOrganizationIds.length) {
    return {
      // Unknown, ungranted, and removed memberships deliberately collapse to
      // one answer so consent cannot be used as an organization oracle.
      error: createOAuthError('access_denied', 'The workspace selection is no longer available'),
      status: 403,
    };
  }
  const anchor = workspaces.find((workspace) => workspace.id === organizationId);
  if (!anchor) {
    return {
      error: createOAuthError('access_denied', 'The workspace selection is no longer available'),
      status: 403,
    };
  }

  return {
    organizationId,
    memberRole: anchor.role,
    grantedOrganizationIds,
    liveGrantedWorkspaces: workspaces,
  };
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
  // When true, a user who belongs to more than one org and didn't pass an
  // explicit org (or resource slug) must pick one — we do NOT silently bind to
  // their personal org. Used by the explicitly approved device-worker flow, where a
  // silent personal-org default landed the device in the wrong workspace.
  forceSelectionForMultiOrg?: boolean;
}): Promise<OrgResolutionResult> {
  const { sql, userId, resourceOrgSlug, explicitOrgId, forceSelectionForMultiOrg } = params;

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
    SELECT m."organizationId" as organization_id, m.role, o.name, o.slug
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

  // Device pairing: a multi-org user MUST choose explicitly. Skip
  // the personal-org default below so the device can't be silently bound to the
  // wrong workspace. Single-org users (length === 1) have no ambiguity and fall
  // through to the normal resolution.
  if (forceSelectionForMultiOrg && memberships.length > 1) {
    return {
      orgSelectionRequired: true,
      organizations: memberships.map((m) => ({
        id: m.organization_id,
        name: m.name,
        slug: m.slug,
      })),
    };
  }

  // If the user has a personal-org marker (`organization.metadata.personal_org_for_user_id`),
  // bind device tokens to it without prompting. This matches what the
  // device-worker auth middleware in `index.ts:602-607` resolves to anyway —
  // skipping the consent picker just avoids a step the user almost always
  // answers the same way. They can still bind to a different org by passing
  // an explicit `organization_id` (UI path) or a `resource` slug (API path).
  const personalOrg = await findExistingPersonalOrg(userId, sql);
  if (personalOrg) {
    const personalMember = memberships.find(
      (m) => m.organization_id === personalOrg.id
    );
    if (personalMember) {
      return {
        organizationId: personalOrg.id,
        memberRole: (personalMember.role as string | null) ?? null,
      };
    }
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
  return new OAuthProvider(sql, baseUrl, isMultiWorkspaceGrantIssuanceEnabled(c.env));
}

// ============================================
// Metadata Endpoints
// ============================================

/**
 * OAuth discovery metadata must never be CDN-cached. Cloudflare's public-HTML
 * rule respects origin Cache-Control for `/.well-known/*`; without an explicit
 * no-store, a deploy that changes scopes_supported can stay invisible for
 * hours — third-party MCP clients (Slack) then request stale scopes, we grant
 * a subset, and the client reports "must accept all required permissions".
 */
function setOAuthDiscoveryNoCache(c: { header: (name: string, value: string) => void }) {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function getMetadataMcpResource(request: Request, resourcePath = 'mcp'): string | null {
  const publicRequestUrl = publicMcpRequestUrl(request);
  const publicOrigin = new URL(publicRequestUrl).origin;
  return canonicalizeMcpResource(`${publicOrigin}/${resourcePath}`, publicRequestUrl);
}

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
  const resource = getMetadataMcpResource(c.req.raw, resourcePath);
  setOAuthDiscoveryNoCache(c);
  if (!resource) return c.json({ error: 'Not Found' }, 404);
  metadata.resource = resource;
  // The protected resource and OAuth authorization server are intentionally
  // separate in Lobu Cloud: MCP is canonical on lobu.ai, while OAuth is issued
  // by app.lobu.ai. RFC 9728 permits this and clients discover the issuer from
  // authorization_servers. PUBLIC_GATEWAY_URL is the stable OAuth/web origin.
  const authorizationServer = getConfiguredPublicOrigin();
  if (authorizationServer) metadata.authorization_servers = [authorizationServer];
  return c.json(metadata);
});

oauthRoutes.get('/.well-known/oauth-protected-resource', (c) => {
  const provider = getProvider(c);
  const metadata = provider.getProtectedResourceMetadata();
  const resource = getMetadataMcpResource(c.req.raw);
  setOAuthDiscoveryNoCache(c);
  if (!resource) return c.json({ error: 'Not Found' }, 404);
  metadata.resource = resource;
  const authorizationServer = getConfiguredPublicOrigin();
  if (authorizationServer) metadata.authorization_servers = [authorizationServer];
  return c.json(metadata);
});

/**
 * GET /.well-known/openid-configuration
 * RFC 8414 - OAuth Authorization Server Metadata
 *
 * MCP clients fetch this to discover OAuth endpoints.
 */
oauthRoutes.get('/.well-known/openid-configuration', (c) => {
  const provider = getProvider(c);
  setOAuthDiscoveryNoCache(c);
  return c.json(provider.getAuthorizationServerMetadata());
});

// Also serve at /oauth-authorization-server for strict RFC 8414 compliance
oauthRoutes.get('/.well-known/oauth-authorization-server', (c) => {
  const provider = getProvider(c);
  setOAuthDiscoveryNoCache(c);
  return c.json(provider.getAuthorizationServerMetadata());
});

/**
 * GET /auth.md
 * The auth.md agent-registration walkthrough (https://auth.md style), as
 * Markdown. Discovered via the `agent_auth.auth_md` pointer in the AS metadata.
 * Generated from the deployment base URL so examples are correct for
 * self-hosted installs too.
 */
oauthRoutes.get('/auth.md', (c) => {
  return c.body(buildAuthMd(getBaseUrl(c)), 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'no-store',
  });
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

  // Rate limit client registrations. DCR is an unauthenticated, abuse-prone
  // endpoint (each registration persists a scrypt'd secret row), so the limiter
  // is ON by default — opt out only with RATE_LIMIT_ENABLED='false'. The check
  // is pure in-memory and synchronous; if it somehow throws we fail CLOSED here.
  if (c.env.RATE_LIMIT_ENABLED !== 'false') {
    try {
      const rateLimiter = getRateLimiter();
      const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
      const rateLimit = await rateLimiter.checkLimit(
        `rate:oauth:register:${clientIP}`,
        RateLimitPresets.OAUTH_REGISTER_PER_IP_HOUR
      );

      if (!rateLimit.allowed) {
        return c.json(createOAuthError('invalid_request', rateLimit.errorMessage), 429);
      }
    } catch (err) {
      console.warn('[OAuth] Rate limit check failed:', err);
      return c.json(createOAuthError('server_error', 'Registration temporarily unavailable'), 503);
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

  params.scope = stripNonPublicOAuthScopes(params.scope || DEFAULT_SCOPES_STRING);
  if (!params.scope) {
    return c.json(
      createOAuthError('invalid_scope', 'No requested scopes are available to OAuth clients'),
      400
    );
  }
  const requestedScopes = getRequestedScopes(params.scope);
  const requestedHasMcpScopes = requestedScopes.some((s) => s.startsWith('mcp:'));
  if (requestedHasMcpScopes) {
    const resource = canonicalizeMcpResource(params.resource, publicMcpRequestUrl(c.req.raw));
    if (!resource) {
      return c.json(
        createOAuthError('invalid_request', 'A valid trusted MCP resource is required'),
        400
      );
    }
    params.resource = resource;
  }

  // Validate client
  const clientResult = await provider.getClientForAuthorization(
    params.client_id,
    params.redirect_uri
  );

  if ('error' in clientResult) {
    return c.json(clientResult, 400);
  }

  const client = clientResult;

  // Auto-approve for profile:read-only requests (no MCP scopes), but ONLY when
  // the redirect target is on our own canonical origin. Dynamic client
  // registration lets anyone register a client with an arbitrary HTTPS
  // redirect_uri; silently auto-approving profile:read for such a client would
  // hand a logged-in user's email/name/org list to an attacker-controlled
  // callback with no consent prompt. So: first-party origin → skip consent;
  // anything else → fall through to the consent page.
  const canonicalOrigin = getConfiguredPublicOrigin();
  const redirectOrigin = safeOrigin(params.redirect_uri);
  const isFirstPartyRedirect =
    !!canonicalOrigin && !!redirectOrigin && redirectOrigin === canonicalOrigin;
  const isProfileOnly =
    !requestedHasMcpScopes &&
    requestedScopes.every((s) => s === 'profile:read') &&
    isFirstPartyRedirect;

  if (isProfileOnly) {
    // Check if user has an active session
    const auth = await createAuth(c.env);
    try {
      const session = await resolveSession(auth, c.req.raw.headers);
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

  // MCP scopes or other scopes — show consent page as before. Device-flow-only
  // device/managed-credential scopes were stripped above and must never reach
  // authorization-code consent.
  const webUrl = getBaseUrl(c);
  const consentUrl = new URL('/oauth/consent', webUrl);

  consentUrl.searchParams.set('client_id', params.client_id);
  consentUrl.searchParams.set('redirect_uri', params.redirect_uri);
  consentUrl.searchParams.set('scope', params.scope);
  consentUrl.searchParams.set('state', params.state || '');
  consentUrl.searchParams.set('code_challenge', params.code_challenge);
  consentUrl.searchParams.set('code_challenge_method', params.code_challenge_method);
  if (params.resource) {
    consentUrl.searchParams.set('resource', params.resource);
  }
  if (
    isBareMcpResource(params.resource) &&
    isMultiWorkspaceGrantIssuanceEnabled(c.env)
  ) {
    // Capability is delivered by the backend that will enforce the grant. New
    // consent UIs fall back to the legacy singleton picker when this marker is
    // absent, which keeps new UI safe against old or not-yet-enabled pods.
    consentUrl.searchParams.set('workspace_grants', '1');
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
    organization_ids?: string[];
    workspace_access?: WorkspaceAccessMode;
    approved: boolean;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json(createOAuthError('invalid_request', 'Invalid JSON body'), 400);
  }

  // A denial remains possible even when the client supplied malformed grant
  // details. Approval, however, must never let the scope parser turn an
  // explicit empty value into the server defaults.
  if (body.approved && (typeof body.scope !== 'string' || body.scope.trim().length === 0)) {
    return c.json(createOAuthError('invalid_scope', 'A non-empty scope is required'), 400);
  }

  if (body.approved) {
    body.scope = stripNonPublicOAuthScopes(body.scope);
    if (!body.scope) {
      return c.json(
        createOAuthError('invalid_scope', 'No requested scopes are available to OAuth clients'),
        400
      );
    }
  }

  // Keep the remaining client-requested public scopes after the device-only
  // values above are stripped. Unknown values are filtered later via
  // parseScopes / AVAILABLE_SCOPES at token use. Device-specific automation
  // (personal-org force-bind, mint-child-token) stays gated on the device flow
  // and resource binding, not solely on the scope string.
  const consentHasMcpScopes = hasMcpScopes(body.scope);
  if (consentHasMcpScopes) {
    const resource = canonicalizeMcpResource(body.resource, publicMcpRequestUrl(c.req.raw));
    if (!resource) {
      return c.json(
        createOAuthError('invalid_request', 'A valid trusted MCP resource is required'),
        400
      );
    }
    body.resource = resource;
  }

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

  if (
    consentHasMcpScopes &&
    getOrgSlugFromResource(body.resource) !== null &&
    (body.workspace_access !== undefined || body.organization_ids !== undefined)
  ) {
    return c.json(
      createOAuthError(
        'invalid_request',
        'Workspace selection is not allowed for a scoped MCP resource'
      ),
      400
    );
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
    let grantedOrganizationIds: string[] = [];

    if (consentHasMcpScopes) {
      const sql = createDbClientFromEnv(c.env);
      const resourceOrgSlug = getOrgSlugFromResource(body.resource);
      const submittedGrant =
        isBareMcpResource(body.resource) &&
        (body.workspace_access !== undefined || body.organization_ids !== undefined)
          ? await resolveSubmittedWorkspaceGrant({
              sql,
              userId: user.id,
              organizationIds: body.organization_ids,
              anchorOrganizationId: body.organization_id,
              workspaceAccess: body.workspace_access,
              multiWorkspaceGrantsEnabled: isMultiWorkspaceGrantIssuanceEnabled(c.env),
            })
          : null;
      if (submittedGrant && 'error' in submittedGrant) {
        return c.json(submittedGrant.error, submittedGrant.status as 400);
      }
      const validSubmittedGrant =
        submittedGrant && !('error' in submittedGrant) ? submittedGrant : null;
      const orgResult =
        validSubmittedGrant ??
        (await resolveOrganizationForGrant({
          sql,
          userId: user.id,
          resourceOrgSlug,
          explicitOrgId: body.organization_id,
          forceSelectionForMultiOrg: isBareMcpResource(body.resource),
        }));
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
      grantedOrganizationIds = validSubmittedGrant?.grantedOrganizationIds ?? [
        orgResult.organizationId,
      ];
      const liveGrantedWorkspaces =
        validSubmittedGrant?.liveGrantedWorkspaces ??
        (resourceOrgSlug === null
          ? await listLiveGrantedMemberWorkspaces({
              sql,
              userId: user.id,
              grantedOrganizationIds,
            })
          : []);
      // A scoped resource is governed by its one bound workspace. For /mcp,
      // the resolved org is only the session default; target workspace role
      // checks remain authoritative at runtime.
      const grantRole =
        resourceOrgSlug !== null
          ? orgResult.memberRole
          : liveGrantedWorkspaces.some(
                (workspace) => workspace.role === 'owner' || workspace.role === 'admin'
              )
            ? 'admin'
            : 'member';
      const filtered = filterScopeByRole(body.scope, grantRole);
      if (filtered === null) {
        return c.json(
          createOAuthError(
            'invalid_scope',
            'Your role is not authorized for any of the requested scopes'
          ),
          400
        );
      }
      // Grant exactly the resource-aware filtered request. Runtime target-role
      // gates stay separate from the token's transport capability.
      params.scope = filtered;
    }

    const code = await provider.createAuthorizationCode(
      params,
      user.id,
      organizationId,
      grantedOrganizationIds
    );

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

  if (
    body.scope !== undefined &&
    (typeof body.scope !== 'string' || body.scope.trim().length === 0)
  ) {
    return c.json(createOAuthError('invalid_scope', 'Requested scope must not be empty'), 400);
  }

  const deviceScopes = getRequestedScopes(body.scope);
  const isDeviceWorkerGrant = deviceScopes.includes('device_worker:run');
  const deviceHasMcpScopes = deviceScopes.some((scope) => scope.startsWith('mcp:'));
  if (isDeviceWorkerGrant) {
    // Device-worker pairing selects and force-binds the personal org at
    // human approval time. Keeping an earlier caller-supplied team resource
    // would create a token whose OAuth audience disagrees with its org claim.
    // Leave this compatibility grant unbound; normal MCP device grants may
    // still opt into an exact RFC 8707 resource below.
    body.resource = undefined;
  } else if (deviceHasMcpScopes && !body.resource) {
    return c.json(
      createOAuthError('invalid_request', 'resource is required for MCP device authorization'),
      400
    );
  } else if (body.resource) {
    const resource = canonicalizeMcpResource(body.resource, publicMcpRequestUrl(c.req.raw));
    if (!resource) {
      return c.json(
        createOAuthError('invalid_request', 'The MCP resource must be a valid trusted URI'),
        400
      );
    }
    body.resource = resource;
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

/**
 * POST /oauth/device/email
 * Agent-initiated account claim (delivers a device authorization by email).
 *
 * The agent starts a normal device_authorization (RFC 8628), then calls this
 * with the resulting `user_code` and the `email` it wants to act on behalf of.
 * We trigger a Better Auth magic link whose callbackURL is the device consent
 * page for that user_code — one click both authenticates the user (creating
 * the account + personal org on first sign-in, via databaseHooks.user.create)
 * and lands them on the existing consent screen, where Approve runs the
 * standard POST /oauth/device/approve path. The agent meanwhile polls
 * /oauth/token and collects the credential once approved.
 *
 * This is intentionally a thin delivery shim over the existing device-code
 * engine — no new credential type, no new pending-state table.
 *
 * Security:
 *   - The magic link signs the recipient in AS the claimed email, so only the
 *     inbox owner can land on the consent page — no separate identity check.
 *   - Approval still requires an explicit authenticated POST, so a prefetched
 *     link cannot silently approve.
 *   - The response is opaque: it never reveals whether the email has an
 *     account (no enumeration). A bad/expired user_code is the agent's own
 *     error, so 400 there leaks nothing about any user.
 *   - Rate limited per IP because it sends mail to a caller-supplied address.
 */
oauthRoutes.post('/oauth/device/email', async (c) => {
  // Same abuse posture as /oauth/register: an unauthenticated endpoint that
  // sends email to an arbitrary address. ON by default; fail CLOSED.
  if (c.env.RATE_LIMIT_ENABLED !== 'false') {
    try {
      const rateLimiter = getRateLimiter();
      const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
      const rateLimit = await rateLimiter.checkLimit(
        `rate:oauth:device-email:${clientIP}`,
        RateLimitPresets.DEVICE_EMAIL_PER_IP_HOUR
      );
      if (!rateLimit.allowed) {
        return c.json(createOAuthError('invalid_request', rateLimit.errorMessage), 429);
      }
    } catch (err) {
      console.warn('[OAuth] Device-email rate limit check failed:', err);
      return c.json(createOAuthError('server_error', 'Temporarily unavailable'), 503);
    }
  }

  const parsed = await parseRequestBody(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { user_code?: unknown; email?: unknown };

  // Guard on `typeof string` rather than `?.trim()`: a malformed non-string
  // value (e.g. `{"user_code": 123}`) would otherwise throw an uncaught 500.
  const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : undefined;
  const email = typeof body.email === 'string' ? body.email.trim() : undefined;
  if (!userCode || !email) {
    return c.json(
      createOAuthError('invalid_request', 'user_code and email are required'),
      400
    );
  }
  // Minimal shape check; Better Auth validates the address downstream.
  if (!email.includes('@')) {
    return c.json(createOAuthError('invalid_request', 'email is invalid'), 400);
  }

  // The user_code is the agent's own pending authorization — a bad one is the
  // agent's error, not account-existence info, so it is safe to 400 here.
  const provider = getProvider(c);
  const codeIsPending = await provider.isUnclaimedDeviceCodePending(userCode);
  if (!codeIsPending) {
    return c.json(createOAuthError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE), 400);
  }

  // Land the magic link on the existing device consent page for this code.
  // Relative + same-origin, so Better Auth resolves it against our base URL.
  const consentPath = `/oauth/device?user_code=${encodeURIComponent(userCode)}`;
  try {
    const auth = await createAuth(c.env, c.req.raw);
    // createAuth() returns a cache-widened betterAuth type (see authCache:
    // TtlCache<ReturnType<typeof betterAuth>>) that erases plugin endpoint
    // signatures, so the magic-link endpoint is present at runtime but not in
    // the static type. Narrowly type just the call we make.
    const magicLinkApi = auth.api as unknown as {
      signInMagicLink: (args: {
        body: { email: string; callbackURL?: string; newUserCallbackURL?: string };
        headers: Headers;
      }) => Promise<unknown>;
    };
    await magicLinkApi.signInMagicLink({
      body: {
        email,
        callbackURL: consentPath,
        newUserCallbackURL: consentPath,
      },
      headers: c.req.raw.headers,
    });
  } catch (err) {
    // Swallow: delivery failures and the install-operator carve-out must not
    // reveal whether the address is deliverable/registered. Logged, opaque 202.
    console.warn('[OAuth] Device-email magic link send failed (opaque):', err);
  }

  return c.json(
    {
      status: 'pending',
      message:
        'If the address is valid, a confirmation email has been sent. Poll the token endpoint to collect the credential once approved.',
    },
    202
  );
});

// GET /oauth/device is served by the SPA fallback (packages/owletto/src/app/oauth/device.tsx).
// No API route needed — the web app and API share the same origin.

/**
 * GET /oauth/device/info?user_code=...
 * Returns the requesting client + scopes for a pending device code so the
 * consent page can show the user WHO is asking and WHAT they will get — rather
 * than approving a blind code. Auth-gated: only the (authenticated) user on the
 * consent page needs this, and it avoids leaking client/scope by user_code.
 */
oauthRoutes.get('/oauth/device/info', requireAuth, async (c) => {
  const userCode = c.req.query('user_code')?.trim();
  if (!userCode) {
    return c.json(createOAuthError('invalid_request', 'user_code is required'), 400);
  }
  const user = c.get('user');
  if (!user) {
    return c.json(createOAuthError('access_denied', 'Authentication required'), 401);
  }
  const provider = getProvider(c);
  const deviceCode = await provider.claimDeviceCodeForUser(userCode, user.id);
  if (!deviceCode) {
    return c.json(createOAuthError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE), 400);
  }
  const client = await provider.clientsStore.getClient(deviceCode.client_id);
  return c.json({
    client_name: client?.client_name ?? null,
    client_id: deviceCode.client_id,
    scopes: (deviceCode.scope ?? '').split(' ').filter(Boolean),
    resource: deviceCode.resource,
    multi_workspace_grants_enabled: isMultiWorkspaceGrantIssuanceEnabled(c.env),
  });
});

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

  let body: {
    user_code: string;
    approved: boolean;
    organization_id?: string;
    organization_ids?: string[];
    workspace_access?: WorkspaceAccessMode;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json(createOAuthError('invalid_request', 'Invalid JSON body'), 400);
  }

  if (!body.user_code) {
    return c.json(createOAuthError('invalid_request', 'user_code is required'), 400);
  }

  if (!body.approved) {
    const denied = await provider.denyDeviceCode(body.user_code, user.id);
    if (!denied) {
      return c.json(createOAuthError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE), 400);
    }
    return c.json({ status: 'denied' });
  }

  // Read scope/resource only after the verifier endpoint bound the code to
  // this user. Consent decisions never create or overwrite ownership.
  const deviceCode = await provider.getDeviceCodeForUser(body.user_code, user.id);
  if (!deviceCode) {
    return c.json(createOAuthError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE), 400);
  }

  const deviceHasMcpScopes = hasMcpScopes(deviceCode.scope);
  const requestedScopes = (deviceCode.scope ?? '').split(/\s+/).filter(Boolean);
  // `device_worker:run` tokens drive personal devices — the Owletto Mac app,
  // the Chrome extension, and the local `lobu run` worker. Device data
  // (WhatsApp, Photos, browser context, …) always belongs in the user's
  // personal org; team orgs reach a device by pinning an automation/connection
  // (see resolveDeviceClaimableOrgs), not by re-binding the device token.
  // So a device-worker grant is FORCE-bound to the personal org, ignoring
  // the resource slug, the active org, and the consent picker.
  const isDeviceWorkerGrant = requestedScopes.includes('device_worker:run');
  if (
    deviceHasMcpScopes &&
    getOrgSlugFromResource(deviceCode.resource) !== null &&
    (body.workspace_access !== undefined || body.organization_ids !== undefined)
  ) {
    return c.json(
      createOAuthError(
        'invalid_request',
        'Workspace selection is not allowed for a scoped MCP resource'
      ),
      400
    );
  }
  let organizationId: string | null = null;
  let grantedOrganizationIds: string[] = [];
  let scopeOverride: string | null | undefined;

  if (isDeviceWorkerGrant) {
    const sql = createDbClientFromEnv(c.env);
    const personalOrg = await findExistingPersonalOrg(user.id, sql);
    if (!personalOrg) {
      return c.json(
        createOAuthError(
          'access_denied',
          'No personal organization is provisioned for this account; cannot bind a device token.'
        ),
        403
      );
    }
    const memberRow = (await sql`
      SELECT role FROM "member"
      WHERE "organizationId" = ${personalOrg.id} AND "userId" = ${user.id}
      LIMIT 1
    `) as unknown as Array<{ role: string | null }>;
    if (memberRow.length === 0) {
      // The personal-org marker exists but the user isn't a member (legacy /
      // partially-migrated data). Mirrors resolveOrganizationForGrant's
      // membership gate so we never bind a token to an org the user can't act
      // on.
      return c.json(
        createOAuthError('access_denied', 'Not a member of the personal organization'),
        403
      );
    }
    const memberRole = memberRow[0]?.role ?? null;
    organizationId = personalOrg.id;
    grantedOrganizationIds = [personalOrg.id];
    let submittedGrantWorkspaces: GrantedMemberWorkspace[] | null = null;
    if (
      deviceHasMcpScopes &&
      (isBareMcpResource(deviceCode.resource) || deviceCode.resource === null) &&
      (body.workspace_access !== undefined || body.organization_ids !== undefined)
    ) {
      const submittedGrant = await resolveSubmittedWorkspaceGrant({
        sql,
        userId: user.id,
        organizationIds: body.organization_ids,
        anchorOrganizationId: body.organization_id,
        workspaceAccess: body.workspace_access,
        multiWorkspaceGrantsEnabled: isMultiWorkspaceGrantIssuanceEnabled(c.env),
      });
      if ('error' in submittedGrant) {
        return c.json(submittedGrant.error, submittedGrant.status as 400);
      }
      if (
        submittedGrant.organizationId !== personalOrg.id ||
        !submittedGrant.grantedOrganizationIds.includes(personalOrg.id)
      ) {
        return c.json(
          createOAuthError('access_denied', 'The workspace selection is no longer available'),
          403
        );
      }
      // Device placement remains anchored to personal. The additional IDs are
      // an explicit bare-MCP read grant, not a device-data destination.
      grantedOrganizationIds = submittedGrant.grantedOrganizationIds;
      submittedGrantWorkspaces = submittedGrant.liveGrantedWorkspaces;
    }
    const grantRole = submittedGrantWorkspaces?.some(
      (workspace) => workspace.role === 'owner' || workspace.role === 'admin'
    )
      ? 'admin'
      : memberRole;
    scopeOverride = filterScopeByRole(deviceCode.scope, grantRole);
    if (scopeOverride === null) {
      return c.json(
        createOAuthError(
          'invalid_scope',
          'Your role is not authorized for any of the requested scopes'
        ),
        400
      );
    }
  } else if (deviceHasMcpScopes) {
    const sql = createDbClientFromEnv(c.env);
    const resourceOrgSlug = getOrgSlugFromResource(deviceCode.resource);
    const submittedGrant =
      isBareMcpResource(deviceCode.resource) &&
      (body.workspace_access !== undefined || body.organization_ids !== undefined)
        ? await resolveSubmittedWorkspaceGrant({
            sql,
            userId: user.id,
            organizationIds: body.organization_ids,
            anchorOrganizationId: body.organization_id,
            workspaceAccess: body.workspace_access,
            multiWorkspaceGrantsEnabled: isMultiWorkspaceGrantIssuanceEnabled(c.env),
          })
        : null;
    if (submittedGrant && 'error' in submittedGrant) {
      return c.json(submittedGrant.error, submittedGrant.status as 400);
    }
    const validSubmittedGrant =
      submittedGrant && !('error' in submittedGrant) ? submittedGrant : null;
    const orgResult =
      validSubmittedGrant ??
      (await resolveOrganizationForGrant({
        sql,
        userId: user.id,
        resourceOrgSlug,
        explicitOrgId: body.organization_id,
        // Device pairing must not silently default a multi-org user's device to
        // their personal org — require an explicit pick.
        forceSelectionForMultiOrg: true,
      }));
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
    grantedOrganizationIds = validSubmittedGrant?.grantedOrganizationIds ?? [
      orgResult.organizationId,
    ];
    const liveGrantedWorkspaces =
      validSubmittedGrant?.liveGrantedWorkspaces ??
      (resourceOrgSlug === null
        ? await listLiveGrantedMemberWorkspaces({
            sql,
            userId: user.id,
            grantedOrganizationIds,
          })
        : []);
    const grantRole =
      resourceOrgSlug !== null
        ? orgResult.memberRole
        : liveGrantedWorkspaces.some(
              (workspace) => workspace.role === 'owner' || workspace.role === 'admin'
            )
          ? 'admin'
          : 'member';
    scopeOverride = filterScopeByRole(deviceCode.scope, grantRole);
    if (scopeOverride === null) {
      return c.json(
        createOAuthError(
          'invalid_scope',
          'Your role is not authorized for any of the requested scopes'
        ),
        400
      );
    }
    // NOTE: `connections:token` is NOT auto-appended here. Device-code
    // registration is open (DCR), so auto-granting it to any device client
    // would silently widen its token beyond what it requested — the same
    // scope-creep we removed from the authorization-code path. `lobu login`
    // requests `connections:token` explicitly in its device_authorization
    // scope (see `packages/cli/src/internal/oauth.ts`). Open DCR does not prove
    // that client is first-party; the enforceable boundary is device flow plus
    // the user's explicit consent, never client-supplied identity metadata.
    // The grant filter never strips `connections:token`, so an explicitly
    // requested value survives in `deviceCode.scope`. A device client that did
    // NOT request it simply doesn't get it.
  }

  const approved = await provider.approveDeviceCode(
    body.user_code,
    user.id,
    organizationId,
    scopeOverride,
    grantedOrganizationIds
  );
  if (!approved) {
    return c.json(createOAuthError('invalid_grant', INVALID_DEVICE_CODE_MESSAGE), 400);
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

  if (params.resource) {
    const resource = canonicalizeMcpResource(params.resource, publicMcpRequestUrl(c.req.raw));
    if (!resource) {
      return c.json(
        createOAuthError('invalid_request', 'The MCP resource must be a valid trusted URI'),
        400
      );
    }
    params.resource = resource;
  }

  // Handle different grant types
  let result: Awaited<ReturnType<OAuthProvider['exchangeAuthorizationCode']>>;

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
