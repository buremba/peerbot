/**
 * UserContent MCP Server - Main Entry Point
 *
 * This is the main MCP server that exposes tools to LLM agents via the
 * Model Context Protocol over Streamable HTTP transport.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '@lobu/owletto-sdk';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { pinoLogger } from 'hono-pino';
import { createAuth } from './auth';
import { getAuthConfig as getAuthConfigFromEnv } from './auth/config';
import { mcpAuth } from './auth/middleware';
import { oauthRoutes } from './auth/oauth/routes';
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
  publicRestGetConnector,
  publicRestGetWatchers,
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

  // Allow wildcard subdomains of the canonical origin (e.g. acme.owletto.com)
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

let webDistDirectoryCache: string | null | undefined;

async function resolveWebDistDirectory(): Promise<string | null> {
  if (webDistDirectoryCache !== undefined) {
    return webDistDirectoryCache;
  }

  const candidates = [
    process.env.WEB_DIST_DIR?.trim(),
    path.resolve(APP_ROOT, 'packages/owletto-web/dist'),
    path.resolve(APP_ROOT, '../owletto-web/dist'),
    path.resolve(process.cwd(), 'packages/owletto-web/dist'),
    path.resolve(process.cwd(), '../packages/owletto-web/dist'),
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
    path.resolve(APP_ROOT, 'packages/owletto-web/index.html'),
    path.resolve(APP_ROOT, '../owletto-web/index.html'),
    path.resolve(process.cwd(), 'packages/owletto-web/index.html'),
    path.resolve(process.cwd(), '../packages/owletto-web/index.html'),
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

  // No CSP header for JSON APIs - CSP is designed to protect HTML events erom XSS
  // MCP/API endpoints only return JSON, so CSP restrictions aren't necessary
  // and can interfere with ChatGPT's connector validation
  // Removed: Content-Security-Policy header

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
    service: 'owletto-api',
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
 * Logo endpoint - 1x1 transparent PNG for ChatGPT connector validation
 */
app.get('/logo.png', (c) => {
  // 1x1 transparent PNG (67 bytes)
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  c.header('Content-Type', 'image/png');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(png.buffer);
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
  <title>Legal Information - Owletto</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    p { color: #666; }
  </style>
</head>
<body>
  <h1>Owletto</h1>
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
  pollAuthSignal,
  pollWorkerJob,
  postAuthSignal,
  streamContent,
} from './worker-api';

// Worker API authentication middleware — validates WORKER_API_TOKEN when configured
app.use('/api/workers/*', async (c, next) => {
  const expected = c.env.WORKER_API_TOKEN;
  if (expected) {
    const provided = c.req.header('Authorization')?.replace('Bearer ', '');
    if (provided !== expected) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }
  return next();
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
        e.entity_type,
        parent.name as parent_name,
        CAST(COUNT(iwf.event_id) AS INTEGER) as content_count
      FROM watcher_windows iw
      JOIN watchers i ON iw.watcher_id = i.id
      JOIN entities e ON e.id = ANY(i.entity_ids)
      LEFT JOIN entities parent ON e.parent_id = parent.id
      LEFT JOIN watcher_window_events iwf ON iwf.window_id = iw.id
      WHERE iw.id = ${windowId}
        AND e.organization_id = ${organizationId}
        AND i.status = 'active'
      GROUP BY iw.id, i.entity_ids, i.slug, i.name, e.name, e.entity_type, parent.name
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
    name_for_human: 'Owletto',
    name_for_model: 'owletto',
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
 * Prod: Serves static files from packages/owletto-web/dist with SPA fallback.
 */
app.get('*', async (c) => {
  const requestPath = c.req.path;
  const acceptsHtml = c.req.header('accept')?.includes('text/html') ?? false;
  const hasFileExtension =
    /\.(?:js|css|html|json|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|txt|xml)$/i.test(
      requestPath
    );
  if (acceptsHtml && !hasFileExtension && !isExcludedSpaPath(requestPath)) {
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
        return c.html(html, publicPageModel.status as 200 | 404);
      }
    }
  }

  // Dev: serve Vite-transformed index.html for SPA routes
  if (viteDev) {
    if (acceptsHtml && !hasFileExtension) {
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

    if (acceptsHtml && !hasFileExtension && !isExcludedSpaPath(requestPath)) {
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
