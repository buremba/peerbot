/**
 * UserContent MCP Server - Main Entry Point
 *
 * This is the main MCP server that exposes tools to LLM agents via the
 * Model Context Protocol over Streamable HTTP transport.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '@lobu/connector-sdk';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { pinoLogger } from 'hono-pino';
import { createAuth } from './auth';
import { getAuthConfig as getAuthConfigFromEnv } from './auth/config';
import { mcpAuth } from './auth/middleware';
import { oauthRoutes } from './auth/oauth/routes';
import { findExistingPersonalOrg } from './auth/personal-org-provisioning';
import { credentialRoutes } from './auth/routes';
import { connectRoutes } from './connect/routes';
import { getDb } from './db/client';
import * as invalidationEmitter from './events/emitter';
import { isExcludedSpaPath } from './http/spa-route-filter';
import { agentRoutes } from './lobu/agent-routes';
import { clientRoutes, platformSchemaRoutes } from './lobu/client-routes';
import { isLobuGatewayRunning } from './lobu/gateway';
import { handleMcp } from './mcp-handler';
import {
  restDeleteNotification,
  restGetUnreadCount,
  restListNotifications,
  restMarkAllAsRead,
  restMarkAsRead,
} from './notifications/routes';
import {
  buildPublicPageModel,
  buildRobotsTxt,
  buildSitemapEntries,
  buildSitemapXml,
  PUBLIC_XML_CACHE,
  renderPublicPageTemplate,
} from './public-pages';
import {
  publicRestEventsStream,
  publicRestGetConnector,
  publicRestGetOrganization,
  publicRestGetWatchers,
  publicRestListAgents,
  publicRestListClassifiers,
  publicRestListConnectors,
  publicRestSearchKnowledge,
  restGetWatchers,
  restHealth,
  restSearchKnowledge,
  restToolProxy,
  restUpdateContentClassification,
} from './rest-api';
import { entityLinkMatchSql } from './utils/content-search';
import { isValidFrameAncestor } from './utils/csp';
import { errorMessage } from './utils/errors';
import logger from './utils/logger';
import { generateOpenAPISpec } from './utils/openapi-generator';
import {
  extractSubdomainOrg,
  getCanonicalRedirectUrl,
  getConfiguredPublicOrigin,
  getSubdomainZone,
} from './utils/public-origin';
import { getClientIP, getRateLimiter, RateLimitPresets } from './utils/rate-limiter';
import { getRuntimeInfo } from './utils/runtime-info';
import { getWorkspaceProvider } from './workspace';
import { joinPublicOrganization } from './workspace/join-public';
import { invalidateOrgSlugCache } from './workspace/multi-tenant';

export type { Env };

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isAllowedCorsOrigin(origin: string, _env: Env, requestUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (LOCALHOST_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    return true;
  }

  // Behind a TLS-terminating proxy, c.req.url is http://, so the configured
  // public origin is the source of truth for the canonical (https) origin.
  const canonicalOrigin = getConfiguredPublicOrigin() ?? new URL(requestUrl).origin;

  if (parsed.origin === canonicalOrigin) return true;

  // Allow wildcard subdomains of the canonical origin (e.g. acme.lobu.com)
  // and — when AUTH_COOKIE_DOMAIN is configured — sibling subdomains under the
  // cookie zone so browsers on `acme.lobu.ai` can call `app.lobu.ai`.
  const parsedHost = parsed.hostname.toLowerCase();
  const baseDomain = new URL(canonicalOrigin).hostname.toLowerCase();
  if (parsedHost.endsWith(`.${baseDomain}`)) return true;

  const subdomainZone = getSubdomainZone(canonicalOrigin);
  if (subdomainZone && (parsedHost === subdomainZone || parsedHost.endsWith(`.${subdomainZone}`))) {
    return true;
  }

  return false;
}

const STATIC_TEXT_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const STATIC_BINARY_CONTENT_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

const LOBU_LOGO_PNG_BASE64 = [
  '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',
  'li7/B31fx7NwQB5PAAAAAElFTkSuQmCC',
].join('');

let webDistDirectoryCache: string | null | undefined;

async function resolveWebDistDirectory(): Promise<string | null> {
  if (webDistDirectoryCache !== undefined) {
    return webDistDirectoryCache;
  }

  const candidates = [
    process.env.WEB_DIST_DIR?.trim(),
    path.resolve(APP_ROOT, 'packages/web/dist'),
    path.resolve(APP_ROOT, '../web/dist'),
    path.resolve(process.cwd(), 'packages/web/dist'),
    path.resolve(process.cwd(), '../packages/web/dist'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'index.html'));
      if (stat.isFile()) {
        webDistDirectoryCache = candidate;
        return webDistDirectoryCache;
      }
    } catch {
      // Try next candidate.
    }
  }

  webDistDirectoryCache = null;
  return webDistDirectoryCache;
}

async function loadSpaHtmlTemplate(): Promise<string | null> {
  if (viteDev) {
    return fs.readFile(path.resolve(viteDev.config.root, 'index.html'), 'utf-8');
  }

  const webDistDirectory = await resolveWebDistDirectory();
  if (!webDistDirectory) return null;

  const spaEntry = resolveStaticFilePath(webDistDirectory, '/index.html');
  if (!spaEntry) return null;

  return fs.readFile(spaEntry, 'utf-8');
}

async function loadFallbackSpaHtmlTemplate(): Promise<string | null> {
  const candidates = [
    path.resolve(APP_ROOT, 'packages/web/index.html'),
    path.resolve(APP_ROOT, '../web/index.html'),
    path.resolve(process.cwd(), 'packages/web/index.html'),
    path.resolve(process.cwd(), '../packages/web/index.html'),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf-8');
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

async function loadAnySpaHtmlTemplate(): Promise<string | null> {
  return (await loadSpaHtmlTemplate()) ?? (await loadFallbackSpaHtmlTemplate());
}

function getContentTypeForStaticFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return (
    STATIC_TEXT_CONTENT_TYPES[extension] ||
    STATIC_BINARY_CONTENT_TYPES[extension] ||
    'application/octet-stream'
  );
}

function hasBetterAuthSessionCookie(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? '').includes('better-auth.session_token=');
}

function resolveStaticFilePath(distDir: string, requestPath: string): string | null {
  const normalizedPath = path.posix.normalize(requestPath || '/');
  if (normalizedPath.includes('..')) {
    return null;
  }

  const relativePath = normalizedPath === '/' ? 'index.html' : normalizedPath.replace(/^\/+/, '');
  const resolved = path.resolve(distDir, relativePath);
  const relativeToDist = path.relative(distDir, resolved);
  if (relativeToDist.startsWith('..') || path.isAbsolute(relativeToDist)) {
    return null;
  }
  return resolved;
}

async function serveStaticFile(c: Context<{ Bindings: Env }>, filePath: string) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return null;
  }

  const body = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const isHtml = extension === '.html';

  c.header('Content-Type', getContentTypeForStaticFile(filePath));
  c.header(
    'Cache-Control',
    isHtml ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable'
  );
  // Hono's Data type expects Uint8Array<ArrayBuffer>; copy into a fresh
  // ArrayBuffer since fs.readFile returns Buffer<ArrayBufferLike>.
  const ab = new ArrayBuffer(body.byteLength);
  new Uint8Array(ab).set(body);
  return c.body(new Uint8Array(ab));
}

const app = new Hono<{ Bindings: Env }>();
app.use('/*', compress({ threshold: 1024 }));

// Enable CORS for MCP clients and frontend
app.use(
  '/*',
  cors({
    origin: (origin, c) => {
      if (!origin) return getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
      return isAllowedCorsOrigin(origin, c.env, c.req.url) ? origin : undefined;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-MCP-Format'],
    exposeHeaders: ['Content-Type'],
    credentials: true, // Required for better-auth cookies
  })
);

// Add Pino logger middleware
app.use(
  '*',
  pinoLogger({
    pino: logger,
  })
);

// Add security headers for ChatGPT connector safety
app.use('/*', async (c, next) => {
  await next();

  // Security headers required for safe API access
  c.header('X-Content-Type-Options', 'nosniff');
  // Changed from DENY to SAMEORIGIN to allow ChatGPT connector validation
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // For HTML responses (SPA entrypoints), add a CSP frame-ancestors directive
  // that allows the lobu.ai landing page to embed the app. Modern browsers
  // prefer frame-ancestors over X-Frame-Options when both are present, so this
  // effectively loosens the SAMEORIGIN restriction for our own properties while
  // still blocking third-party clickjacking. JSON/API responses keep the
  // stricter header and no CSP, preserving ChatGPT connector validation.
  const contentType = c.res.headers.get('content-type') ?? '';
  if (contentType.startsWith('text/html')) {
    const rawFrameAncestors = c.env.FRAME_ANCESTORS?.trim();
    const frameAncestors = rawFrameAncestors
      ? rawFrameAncestors
          .split(/[\s,]+/)
          .map((entry) => entry.trim())
          .filter((entry) => isValidFrameAncestor(entry))
          .join(' ')
      : 'https://lobu.ai https://*.lobu.ai';
    c.header(
      'Content-Security-Policy',
      `frame-ancestors 'self' ${frameAncestors}`
    );
  }

  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Minimal permissions policy to prevent FLoC without blocking ChatGPT validation
  c.header('Permissions-Policy', 'interest-cohort=()');
});

/**
 * Subdomain org extraction middleware
 * Parses Host header for {org}.{zone} pattern and sets subdomainOrg.
 * The zone is AUTH_COOKIE_DOMAIN when set (so per-org hosts like `acme.lobu.ai`
 * resolve even though PUBLIC_WEB_URL is `app.lobu.ai`), otherwise the
 * PUBLIC_WEB_URL hostname. Reserved subdomains (www, api, app, admin, etc.)
 * are not treated as orgs.
 */
const RESERVED_SUBDOMAINS = new Set([
  'www',
  'api',
  'app',
  'admin',
  'auth',
  'mcp',
  'static',
  'assets',
  'cdn',
  'docs',
  'mail',
]);

app.use('/*', async (c, next) => {
  const zone = getSubdomainZone();
  const sub = extractSubdomainOrg(c.req.header('host'), zone, RESERVED_SUBDOMAINS);
  c.set('subdomainOrg', sub);

  // On a subdomain host, redirect HTML GETs that carry a redundant `/{sub}`
  // prefix to the stripped path so direct/bookmarked links normalize to the
  // SPA's expected URL. Scoped to HTML so API clients are unaffected.
  if (sub && c.req.method === 'GET' && c.req.header('accept')?.includes('text/html')) {
    const prefix = `/${sub}`;
    const path = c.req.path;
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      const stripped = path.slice(prefix.length) || '/';
      const url = new URL(c.req.url);
      return c.redirect(`${stripped}${url.search}`, 301);
    }
  }

  return next();
});

app.use('/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return next();
  }

  const pathname = new URL(c.req.url).pathname;
  const shouldSkipRedirect = isExcludedSpaPath(pathname);

  if (shouldSkipRedirect) {
    return next();
  }

  const redirectUrl = getCanonicalRedirectUrl(c.req.url);
  if (redirectUrl) {
    return c.redirect(redirectUrl, 302);
  }

  return next();
});

/**
 * Health check endpoint
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'lobu-api',
    timestamp: new Date().toISOString(),
    ...getRuntimeInfo(c.env),
  });
});

/**
 * Scheduler health check endpoint
 * Returns detailed metrics about the feed scheduling system
 */
app.get('/health/scheduler', async (c) => {
  try {
    const { getSchedulerHealth } = await import('./scheduled/scheduler-health');
    const health = await getSchedulerHealth(c.env);
    return c.json(health, health.healthy ? 200 : 503);
  } catch (error) {
    return c.json(
      {
        healthy: false,
        issues: ['Failed to check scheduler health'],
        error: errorMessage(error),
      },
      500
    );
  }
});

/**
 * Better-Auth routes
 * Handles all authentication requests: OAuth, magic link, phone OTP, sessions
 */
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const auth = await createAuth(c.env, c.req.raw);
  // better-call crashes with "Unexpected end of JSON input" when a POST has
  // Content-Type: application/json but an empty body. Ensure a valid body.
  let request = c.req.raw;
  if (c.req.method === 'POST') {
    const ct = c.req.header('content-type') || '';
    if (ct.includes('application/json') && c.req.header('content-length') === '0') {
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: '{}',
      });
    }
  }
  return auth.handler(request);
});

/**
 * Credential management routes
 * Handles linking OAuth accounts to connections
 */
app.route('/api', credentialRoutes);

/**
 * OAuth 2.1 Authorization Server routes
 * Provides MCP authentication for HTTP clients (Claude.ai, ChatGPT)
 * Endpoints: /.well-known/*, /oauth/*
 */
app.route('/', oauthRoutes);
// Serve OAuth discovery relative to MCP path (Gemini CLI fetches /.well-known/* relative to transport URL)
app.route('/mcp', oauthRoutes);

/**
 * Connect Link routes (unauthenticated, token-gated)
 * Used by MCP clients to complete OAuth/env_keys auth for connections
 */
app.route('/connect', connectRoutes);

/**
 * Logo endpoint for MCP/OAuth client metadata.
 */
app.get('/logo.png', (c) => {
  const body = Buffer.from(LOBU_LOGO_PNG_BASE64, 'base64');

  c.header('Content-Type', 'image/png');
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(body);
});

/**
 * Legal/Terms endpoint for ChatGPT connector validation
 */
app.get('/legal', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Legal Information - Lobu</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>Lobu</h1>
  <p>Legal Information and Terms of Service</p>

  <h2>Service Description</h2>
  <p>This is an AI-powered MCP server for collecting customer content and building searchable workspace knowledge across multiple platforms including Reddit, Trustpilot, App Stores, Google Maps, GitHub, Hacker News, and more.</p>

  <h2>Data Collection</h2>
  <p>This service collects publicly available user events erom various platforms. All data is collected in accordance with each platform's terms of service and API usage policies.</p>

  <h2>Privacy</h2>
  <p>We process publicly available content data. No personal information is collected beyond what is publicly visible on the source platforms.</p>

  <h2>Usage Terms</h2>
  <p>This service is provided as-is for research and intelligence purposes. Users are responsible for ensuring their use of insights complies with applicable laws and regulations.</p>

  <h2>Contact</h2>
  <p>For questions or concerns, please contact: support@example.com</p>

  <p style="margin-top: 40px; font-size: 0.9em; color: #999;">Last updated: ${new Date().toISOString().split('T')[0]}</p>
</body>
</html>`);
});

/**
 * REST API endpoints for ChatGPT Custom Actions and lightweight wrappers.
 * MCP tools are exposed through the generic /api/:orgSlug/:toolName proxy.
 */
// Health check and worker endpoints must be before mcpAuth middleware
app.get('/api/health', restHealth);

import {
  completeActionRun,
  completeAuthRun,
  completeEmbeddings,
  completeWorkerJob,
  emitAuthArtifact,
  fetchEventsForEmbedding,
  getActiveAuthRun,
  getAuthRun,
  heartbeat,
  listDeviceWorkers,
  pollAuthSignal,
  pollWorkerJob,
  postAuthSignal,
  streamContent,
} from './worker-api';

// Worker API authentication.
//
// Two ways to authenticate a request to /api/workers/*:
//
//   1. **Trusted worker** — `Authorization: Bearer ${WORKER_API_TOKEN}`. Shared
//      secret in the server env; used by server-side connector-worker fleets.
//      Full access to all orgs (existing model).
//
//   2. **User-scoped worker** — user OAuth bearer or PAT (Lobu for Mac
//      uses an OAuth bearer from the device-code flow). `/api/workers/*` carries
//      no org slug, so the token must resolve to an org on its own (PAT/OAuth
//      carry a bound org — a bare session cookie won't work here). The worker is
//      scoped to that bound org plus the user's personal org (where device
//      connectors auto-wire); poll filters on that set, and heartbeat/stream/
//      complete additionally re-check the run is theirs. It does NOT get the
//      user's other org memberships, so a token narrowly scoped to org A can't
//      reach into org B.
//
// In dev (no WORKER_API_TOKEN configured) and with no user auth, requests pass
// through unauthenticated — the existing local-dev behavior.
app.use('/api/workers/*', async (c, next) => {
  const expected = c.env.WORKER_API_TOKEN;
  const provided = c.req.header('Authorization')?.replace('Bearer ', '');

  if (expected && provided === expected) {
    c.set('workerAuthMode', 'trusted');
    c.set('workerUserId', null);
    c.set('workerOrgIds', null);
    return next();
  }

  return mcpAuth(c, async () => {
    if (c.var.mcpIsAuthenticated && c.var.user?.id) {
      // User-scoped workers can only hit the endpoints needed to run a job
      // end-to-end. Auth-artifact / embeddings / repair-thread endpoints are
      // for server-side fleets and would leak across orgs without per-handler
      // scoping (which we haven't added). Block them at the door.
      const allowedPathsForUserWorker = new Set([
        '/api/workers/poll',
        '/api/workers/heartbeat',
        '/api/workers/stream',
        '/api/workers/complete',
      ]);
      const requestPath = new URL(c.req.url).pathname;
      if (!allowedPathsForUserWorker.has(requestPath)) {
        return c.json({ error: 'Endpoint not available to user-scoped workers' }, 403);
      }
      const scopes = c.var.mcpAuthInfo?.scopes ?? [];
      if (
        !scopes.includes('device_worker:run') &&
        !scopes.includes('mcp:write') &&
        !scopes.includes('mcp:admin')
      ) {
        return c.json({ error: 'Worker token missing device_worker:run scope' }, 403);
      }
      const userId = c.var.user.id;
      // mcpAuth already verified the token resolves to (and the user is a
      // member of) `c.var.organizationId`. A device worker is scoped to that
      // org plus the user's personal org (the auto-wire target), and nothing
      // else.
      const boundOrgId = c.var.organizationId;
      if (!boundOrgId) {
        return c.json({ error: 'Worker token must be bound to an organization' }, 403);
      }
      const personalOrg = await findExistingPersonalOrg(userId, getDb());
      const orgIds = personalOrg
        ? Array.from(new Set([boundOrgId, personalOrg.id]))
        : [boundOrgId];
      c.set('workerAuthMode', 'user');
      c.set('workerUserId', userId);
      c.set('workerOrgIds', orgIds);
      return next();
    }

    if (expected) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    c.set('workerAuthMode', 'anonymous');
    c.set('workerUserId', null);
    c.set('workerOrgIds', null);
    return next();
  });
});

app.post('/api/workers/poll', pollWorkerJob);
app.post('/api/workers/heartbeat', heartbeat);
app.post('/api/workers/stream', streamContent);
app.post('/api/workers/complete', completeWorkerJob);
app.post('/api/workers/complete-action', completeActionRun);
app.post('/api/workers/complete-embeddings', completeEmbeddings);
app.post('/api/workers/fetch-events', fetchEventsForEmbedding);
app.post('/api/workers/emit-auth-artifact', emitAuthArtifact);
app.post('/api/workers/poll-auth-signal', pollAuthSignal);
app.post('/api/workers/complete-auth', completeAuthRun);
// Device worker registry. Authenticated (mcpAuth); returns the calling user's
// devices. Lives under /api/me/ so the workspace resolver treats it as
// user-scoped (no org slug in the URL).
app.get('/api/me/devices', mcpAuth, listDeviceWorkers);
// UI → worker signal channel. Separate path prefix so the worker API auth
// middleware above doesn't cover it (this one is hit from the web session).
app.get('/api/auth-runs/active', getActiveAuthRun);
app.get('/api/auth-runs/:id', getAuthRun);
app.post('/api/auth-runs/:id/signal', postAuthSignal);

/**
 * Auth configuration endpoint
 * Returns enabled authentication methods based on server env and connector_definitions
 */
app.get('/api/auth-config', async (c) => {
  return c.json(await getAuthConfigFromEnv(c.env, { request: c.req.raw }));
});

/**
 * Invitation preview endpoint (unauthenticated, rate-limited).
 *
 * Given an invitation ID, returns the minimum info needed to prefill the
 * login page: { email, organizationName }. Responds 404 for any non-pending
 * or expired invitation so we don't leak invitation state.
 *
 * Safe because invitation IDs are UUIDs (unguessable). Note: anyone holding
 * the emailed invite URL can learn the org name and invited email — no
 * additional disclosure beyond the URL itself.
 */
app.get('/api/invitation-preview', async (c) => {
  const rateLimiter = getRateLimiter();
  const clientIP = getClientIP(c.req.raw);
  const rateLimit = rateLimiter.checkLimit(
    `rate:invitation-preview:${clientIP}`,
    RateLimitPresets.INVITATION_PREVIEW_PER_IP_MINUTE
  );
  if (!rateLimit.allowed) {
    return c.json({ error: rateLimit.errorMessage }, 429);
  }

  const invitationId = c.req.query('id');
  if (!invitationId) {
    return c.json({ error: 'not_found' }, 404);
  }

  const sql = getDb();
  const rows = await sql<{ email: string; organization_name: string }>`
    SELECT i.email, o.name AS organization_name
    FROM invitation i
    JOIN "organization" o ON o.id = i."organizationId"
    WHERE i.id = ${invitationId}
      AND i.status = 'pending'
      AND i."expiresAt" > NOW()
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) {
    return c.json({ error: 'not_found' }, 404);
  }

  return c.json({
    email: row.email,
    organizationName: row.organization_name,
  });
});

app.get('/robots.txt', async (c) => {
  const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Cache-Control', PUBLIC_XML_CACHE);
  return c.body(buildRobotsTxt(origin));
});

app.get('/sitemap.xml', async (c) => {
  const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
  const entries = await buildSitemapEntries(origin);
  c.header('Content-Type', 'application/xml; charset=utf-8');
  c.header('Cache-Control', PUBLIC_XML_CACHE);
  return c.body(buildSitemapXml(entries));
});

// Organizations endpoint — returns orgs the authenticated user belongs to
app.get('/api/organizations', async (c) => {
  const provider = getWorkspaceProvider();
  const search = c.req.query('search')?.toLowerCase().trim();

  let userId: string | null = null;
  try {
    const auth = await createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    userId = session?.session?.userId || null;
  } catch {
    // No session
  }

  const orgs = await provider.listOrganizations(search, userId);
  return c.json({ organizations: orgs });
});

// Notifications
app.get('/api/:orgSlug/notifications', mcpAuth, restListNotifications);
app.get('/api/:orgSlug/notifications/unread-count', mcpAuth, restGetUnreadCount);
app.patch('/api/:orgSlug/notifications/:id/read', mcpAuth, restMarkAsRead);
app.post('/api/:orgSlug/notifications/mark-all-read', mcpAuth, restMarkAllAsRead);
app.delete('/api/:orgSlug/notifications/:id', mcpAuth, restDeleteNotification);

app.get('/api/:orgSlug/knowledge/search', mcpAuth, restSearchKnowledge);
app.get('/api/:orgSlug/public/knowledge/search', publicRestSearchKnowledge);
app.get('/api/:orgSlug/public/classifiers', publicRestListClassifiers);
app.get('/api/:orgSlug/public/connectors', publicRestListConnectors);
app.get('/api/:orgSlug/public/connectors/:connectorKey', publicRestGetConnector);
app.get('/api/:orgSlug/public/organization', publicRestGetOrganization);
app.get('/api/:orgSlug/public/agents', publicRestListAgents);
app.get('/api/:orgSlug/public/events', publicRestEventsStream);
app.patch(
  '/api/:orgSlug/content/:id/classifications/:classifier_slug',
  mcpAuth,
  restUpdateContentClassification
);
app.get('/api/:orgSlug/watchers', mcpAuth, restGetWatchers);
app.get('/api/:orgSlug/public/watchers', publicRestGetWatchers);
app.get('/api/:orgSlug/watchers/windows/:windowId', mcpAuth, async (c) => {
  const sql = getDb();
  const windowId = c.req.param('windowId');
  const organizationId = c.var.organizationId;

  try {
    // Get window details with watcher info
    const windowResult = await sql`
      SELECT
        iw.*,
        i.entity_ids,
        i.slug as watcher_slug,
        i.name as watcher_name,
        e.name as entity_name,
        et.slug AS entity_type,
        parent.name as parent_name,
        CAST(COUNT(iwf.event_id) AS INTEGER) as content_count
      FROM watcher_windows iw
      JOIN watchers i ON iw.watcher_id = i.id
      JOIN entities e ON e.id = ANY(i.entity_ids)
      JOIN entity_types et ON et.id = e.entity_type_id
      LEFT JOIN entities parent ON e.parent_id = parent.id
      LEFT JOIN watcher_window_events iwf ON iwf.window_id = iw.id
      WHERE iw.id = ${windowId}
        AND e.organization_id = ${organizationId}
        AND i.status = 'active'
      GROUP BY iw.id, i.entity_ids, i.slug, i.name, e.name, et.slug, parent.name
    `;

    if (windowResult.length === 0) {
      return c.json({ error: 'Window not found' }, 404);
    }

    return c.json(windowResult[0]);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

async function handleContentDistribution(c: Context<{ Bindings: Env }>) {
  const sql = getDb();
  const entityId = Number(c.req.param('entityId'));
  const organizationId = c.var.organizationId;

  try {
    // Parse query parameters
    const connectionIdsParam = c.req.query('connection_ids');
    const connectionIds = connectionIdsParam
      ? connectionIdsParam
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const groupByPlatform = c.req.query('group_by_platform') === 'true';

    const connectionFilter =
      connectionIds.length > 0
        ? `AND f.connection_id IN (${connectionIds.map((_, i) => `$${i + 3}`).join(', ')})`
        : '';
    const params: unknown[] = [entityId, organizationId, ...connectionIds];

    const platformSelect = groupByPlatform ? ', f.connector_key as platform' : '';
    const platformGroupBy = groupByPlatform ? ', f.connector_key' : '';

    const distribution = await sql.unsafe(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD') as date
        ${platformSelect},
        CAST(COUNT(*) AS INTEGER) as count
      FROM current_event_records f
      WHERE ${entityLinkMatchSql('$1::bigint', 'f')}
        AND EXISTS (SELECT 1 FROM entities e WHERE e.id = $1 AND e.organization_id = $2)
        ${connectionFilter}
      GROUP BY TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD')${platformGroupBy}
      ORDER BY date ASC
    `,
      params
    );
    return c.json({ distribution });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
}

app.get(
  '/api/:orgSlug/entities/:entityId/content-distribution',
  mcpAuth,
  handleContentDistribution
);

// ============================================
// V1 Integration Platform REST Routes
// ============================================

// Connections
app.get('/api/:orgSlug/connections', mcpAuth, async (c) => {
  return restToolProxy(c, 'manage_connections', { action: 'list', ...c.req.query() });
});
app.post('/api/:orgSlug/connections', mcpAuth, async (c) => {
  const body = await c.req.json();
  return restToolProxy(c, 'manage_connections', { action: 'create', ...body });
});
app.get('/api/:orgSlug/connections/:id', mcpAuth, async (c) => {
  return restToolProxy(c, 'manage_connections', {
    action: 'get',
    connection_id: Number(c.req.param('id')),
  });
});
app.delete('/api/:orgSlug/connections/:id', mcpAuth, async (c) => {
  return restToolProxy(c, 'manage_connections', {
    action: 'delete',
    connection_id: Number(c.req.param('id')),
  });
});

// Runs
app.get('/api/:orgSlug/runs', mcpAuth, async (c) => {
  return restToolProxy(c, 'manage_operations', {
    action: 'list_runs',
    ...c.req.query(),
  });
});

// Actions
app.get('/api/:orgSlug/actions/available', mcpAuth, async (c) => {
  return restToolProxy(c, 'manage_operations', {
    action: 'list_available',
    ...c.req.query(),
  });
});
app.post('/api/:orgSlug/actions/execute', mcpAuth, async (c) => {
  const body = await c.req.json();
  return restToolProxy(c, 'manage_operations', { action: 'execute', ...body });
});

app.patch('/api/:orgSlug/organization/visibility', mcpAuth, async (c) => {
  const organizationId = c.get('organizationId');
  const memberRole = c.get('memberRole');

  if (!organizationId) {
    return c.json({ error: 'Organization context required' }, 401);
  }

  if (memberRole !== 'owner' && memberRole !== 'admin') {
    return c.json(
      {
        error: 'forbidden',
        message: 'Workspace visibility requires owner or admin access.',
      },
      403
    );
  }

  const authSource = c.get('authSource');
  if (authSource === 'pat') {
    return c.json(
      { error: 'forbidden', message: 'Use OAuth or a web session to change workspace visibility.' },
      403
    );
  }

  const scopes = c.get('mcpAuthInfo')?.scopes ?? [];
  if (authSource === 'oauth' && !scopes.includes('mcp:admin')) {
    return c.json(
      { error: 'forbidden', message: 'Workspace visibility changes require mcp:admin scope.' },
      403
    );
  }

  let body: { visibility?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', message: 'Request body must be JSON.' }, 400);
  }

  const visibility = body.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    return c.json(
      { error: 'invalid_request', message: 'Visibility must be "public" or "private".' },
      400
    );
  }

  const sql = getDb();
  const rows = await sql<{
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    description: string | null;
    created_at: string;
    visibility: 'public' | 'private';
  }>`
    UPDATE "organization"
    SET visibility = ${visibility}
    WHERE id = ${organizationId}
    RETURNING id, name, slug, logo, description, "createdAt" AS created_at, visibility
  `;

  const org = rows[0];
  if (!org) {
    return c.json({ error: 'not_found', message: 'Workspace not found.' }, 404);
  }

  invalidateOrgSlugCache(c.req.param('orgSlug'));
  invalidateOrgSlugCache(org.slug);
  invalidationEmitter.emit(org.id, {
    keys: ['organizations', 'resolve-path'],
    resource: { type: 'organization', id: org.id },
  });

  return c.json({ organization: { ...org, is_member: true } });
});

app.route('/api/:orgSlug/agents', agentRoutes);
app.route('/api/:orgSlug/clients', clientRoutes);
app.route('/api/agents/platforms', platformSchemaRoutes);

// ============================================
// SSE Invalidation Events (for frontend cache sync)
// ============================================
app.get('/api/:orgSlug/events', mcpAuth, async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'Organization context required' }, 401);

  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'));

      const unsubscribe = invalidationEmitter.subscribe(String(orgId), (event) => {
        try {
          const data = JSON.stringify(event);
          controller.enqueue(encoder.encode(`event: invalidate\ndata: ${data}\n\n`));
        } catch {
          // Connection closed
        }
      });

      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepAlive);
        }
      }, 30000);

      cleanup = () => {
        unsubscribe();
        clearInterval(keepAlive);
      };
    },
    cancel() {
      cleanup?.();
    },
  });

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  return c.body(stream);
});

/**
 * Features endpoint — lets the frontend discover which capabilities are available.
 * Agents page is always shown (MCP setup works without Lobu runtime features).
 */
app.get('/api/features', (c) => {
  return c.json({
    agents: true,
    lobuEmbedded: isLobuGatewayRunning(),
  });
});

/**
 * Self-serve join a public organization. Authenticated session required.
 * Inserts a member row with role='member' and mirrors Better Auth's
 * afterAddMember side effects (see workspace/join-public.ts).
 */
app.post('/api/:orgSlug/join', async (c) => {
  const rateLimiter = getRateLimiter();
  const clientIP = getClientIP(c.req.raw);
  const rateLimit = rateLimiter.checkLimit(
    `rate:join-public-org:${clientIP}`,
    RateLimitPresets.JOIN_PUBLIC_ORG_PER_IP_HOUR
  );
  if (!rateLimit.allowed) {
    return c.json({ error: rateLimit.errorMessage }, 429);
  }

  const auth = await createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const userId = session?.session?.userId;
  if (!userId) {
    return c.json(
      { error: 'unauthorized', error_description: 'Sign in to join a workspace.' },
      401
    );
  }

  const orgSlug = c.req.param('orgSlug');
  if (!orgSlug) return c.json({ error: 'invalid_request' }, 400);

  const result = await joinPublicOrganization({ userId, orgSlug });
  if (result.status === 'not_found') {
    return c.json({ error: 'not_found', error_description: 'Workspace not found.' }, 404);
  }
  if (result.status === 'not_public') {
    return c.json(
      {
        error: 'forbidden',
        error_description: 'This workspace is private. Ask an owner for an invitation.',
      },
      403
    );
  }

  return c.json({
    status: result.status,
    organizationId: result.organizationId,
    role: result.role,
  });
});

/**
 * Generic tool proxy - forwards to any MCP tool
 * POST /api/:orgSlug/:toolName with JSON body
 */
app.post('/api/:orgSlug/:toolName', mcpAuth, async (c) => {
  return restToolProxy(c);
});

/**
 * OpenAPI spec endpoint for ChatGPT
 * Dynamically generated from tool registry schemas
 */
app.get('/openapi.json', (c) => {
  const serverUrl = new URL(c.req.url).origin;
  const spec = generateOpenAPISpec(serverUrl);
  return c.json(spec);
});

/**
 * ChatGPT plugin manifest
 */
app.get('/.well-known/ai-plugin.json', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  const openApiUrl = new URL('/openapi.json', baseUrl).toString();
  const logoUrl = c.env.PUBLIC_LOGO_URL ?? new URL('/logo.png', baseUrl).toString();
  const legalInfoUrl = c.env.PUBLIC_LEGAL_URL ?? new URL('/legal', baseUrl).toString();
  return c.json({
    schema_version: 'v1',
    name_for_human: 'Lobu',
    name_for_model: 'lobu',
    description_for_human:
      'Build searchable workspace knowledge from customer content across platforms',
    description_for_model:
      'Access workspace knowledge and customer content from Reddit, Trustpilot, App Stores, and other platforms. Search knowledge, retrieve saved knowledge, and get watchers and analytics.',
    auth: {
      type: 'none',
    },
    api: {
      type: 'openapi',
      url: openApiUrl,
    },
    logo_url: logoUrl,
    contact_email: 'support@example.com',
    legal_info_url: legalInfoUrl,
  });
});

/**
 * Apply MCP authentication middleware and Streamable HTTP transport handler.
 * Supports GET (SSE stream), POST (JSON-RPC), and DELETE (session teardown).
 */
app.use('/mcp', mcpAuth);
app.use('/mcp/', mcpAuth);
app.use('/mcp/:orgSlug', mcpAuth);
app.use('/mcp/:orgSlug/', mcpAuth);
app.all('/mcp', handleMcp);
app.all('/mcp/', handleMcp);
app.all('/mcp/:orgSlug', handleMcp);
app.all('/mcp/:orgSlug/', handleMcp);

/**
 * Catch-all route
 * Dev: Vite middleware handles source files/HMR before reaching here.
 *      This catch-all serves SPA index.html via Vite's transformIndexHtml.
 * Prod: Serves static files from packages/web/dist with SPA fallback.
 */
app.get('*', async (c) => {
  const requestPath = c.req.path;
  const acceptHeader = c.req.header('accept') ?? '';
  const acceptsHtml = acceptHeader.includes('text/html');
  const acceptsGenericResponse = !acceptHeader || acceptHeader.includes('*/*');
  const hasSessionCookie = hasBetterAuthSessionCookie(c.req.header('cookie'));
  const hasFileExtension =
    /\.(?:js|css|html|json|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|txt|xml)$/i.test(
      requestPath
    );
  const isSpaRoute = !hasFileExtension && !isExcludedSpaPath(requestPath);
  // Generic signed-in requests still need the SPA shell; otherwise they would fall through to the
  // JSON status response after skipping anonymous public SSR.
  const shouldServeSpaFallback =
    (acceptsHtml || (acceptsGenericResponse && hasSessionCookie)) && isSpaRoute;
  if ((acceptsHtml || acceptsGenericResponse) && !hasSessionCookie && isSpaRoute) {
    const publicPageModel = await buildPublicPageModel(
      requestPath,
      c.env,
      c.req.url,
      c.get('subdomainOrg')
    );
    if (publicPageModel) {
      const template = await loadAnySpaHtmlTemplate();
      if (template) {
        const rendered = renderPublicPageTemplate(template, publicPageModel);
        const html = viteDev ? await viteDev.transformIndexHtml(c.req.path, rendered) : rendered;
        c.header('Cache-Control', publicPageModel.cacheControl);
        c.header('Vary', 'Accept, Cookie');
        return c.html(html, publicPageModel.status as 200 | 404);
      }
    }
  }

  // Dev: serve Vite-transformed index.html for SPA routes
  if (viteDev) {
    if (shouldServeSpaFallback) {
      const raw = await fs.readFile(path.resolve(viteDev.config.root, 'index.html'), 'utf-8');
      const html = await viteDev.transformIndexHtml(c.req.path, raw);
      return c.html(html);
    }
    return c.notFound();
  }

  // Prod: serve static files
  const webDistDirectory = await resolveWebDistDirectory();
  if (webDistDirectory) {
    const filePath = resolveStaticFilePath(webDistDirectory, requestPath);
    if (filePath) {
      try {
        const staticResponse = await serveStaticFile(c, filePath);
        if (staticResponse) {
          return staticResponse;
        }
      } catch {
        // Fall through to SPA fallback and default response.
      }
    }

    if (shouldServeSpaFallback) {
      try {
        const spaEntry = resolveStaticFilePath(webDistDirectory, '/index.html');
        if (spaEntry) {
          const spaResponse = await serveStaticFile(c, spaEntry);
          if (spaResponse) {
            return spaResponse;
          }
        }
      } catch {
        // Fall through to default response.
      }
    }
  }

  const baseUrl = new URL(c.req.url).origin;
  // Unknown paths fall through to this discovery blob. Browsers hit it for
  // `/favicon.ico`, `/apple-touch-icon.png`, etc. before those assets exist —
  // without `no-store` a CDN caches the JSON for that path and keeps serving it
  // even after a deploy ships the real file. Don't let that happen.
  c.header('Cache-Control', 'no-store');
  return c.json({
    status: 'ok',
    mcp_endpoint: new URL('/mcp', baseUrl).toString(),
    health: '/health',
    openapi: '/openapi.json',
  });
});

// Vite dev server instance — set by server.ts in development for SPA index.html transforms
let viteDev: any = null;
export function setViteDev(v: any) {
  viteDev = v;
}

export { app };
