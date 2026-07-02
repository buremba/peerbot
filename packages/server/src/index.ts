/**
 * UserContent MCP Server - Main Entry Point
 *
 * This is the main MCP server that exposes tools to LLM agents via the
 * Model Context Protocol over Streamable HTTP transport.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@lobu/connector-sdk";
import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { pinoLogger } from "hono-pino";
import { LOBU_LOGO_PNG_BASE64 } from "./assets/logo";
import { createAuth } from "./auth";
import { getAuthConfig as getAuthConfigFromEnv } from "./auth/config";
import { mcpAuth } from "./auth/middleware";
import { oauthRoutes } from "./auth/oauth/routes";
import { findExistingPersonalOrg } from "./auth/personal-org-provisioning";
import { credentialRoutes } from "./auth/routes";
import { compareWorkerToken } from "./auth/worker-token";
import { globalCatalogRoutes, orgInstalledRoutes } from "./catalog/routes";
import { connectionTokenRoutes } from "./connect/connection-token-route";
import { connectRoutes } from "./connect/routes";
import {
	restGetAuthProfileForRun,
	restGetFeedForRun,
} from "./connector-run/routes";
import { getDb } from "./db/client";
import * as invalidationEmitter from "./events/emitter";
import { streamInvalidationEvents } from "./events/sse";
import { invalidationSseAuth } from "./events/sse-invalidation-auth";
import {
	type ClaimEligibleOrg,
	type SlackClaimDeps,
	claimSlackWorkspace,
	resolveSlackClaimContext,
} from "./gateway/connections/slack-claim";
import { createSlackWebApi } from "./gateway/connections/slack-web";
import {
	getMaxReservedLocks,
	getReservedLockCount,
} from "./gateway/orchestration/deployment-manager";
import { isExcludedSpaPath } from "./http/spa-route-filter";
import { isShuttingDown } from "./lifecycle-state";
import { agentRoutes } from "./lobu/agent-routes";
import { environmentRoutes } from "./lobu/environment-routes";
import { clientRoutes, platformSchemaRoutes } from "./lobu/client-routes";
import {
	getLobuCoreServices,
	isLobuGatewayRunning,
	resolveDefaultOrgId,
} from "./lobu/gateway";
import {
	claimSlackPendingInstall,
	resolveSlackPendingByTenant,
} from "./lobu/stores/slack-installations";
import { handleMcp, MCP_APP_DIRS } from "./mcp-handler";
import {
	restDeleteNotification,
	restGetUnreadCount,
	restListNotifications,
	restMarkAllAsRead,
	restMarkAsRead,
} from "./notifications/routes";
import { createPreviewClaim } from "./preview/slack";
import {
	buildPublicPageModel,
	buildRobotsTxt,
	buildSitemapEntries,
	buildSitemapXml,
	PUBLIC_XML_CACHE,
	renderPublicPageTemplate,
} from "./public-pages";
import {
	publicRestEventsStream,
	publicRestGetConnector,
	publicRestGetOrganization,
	publicRestGetWatchers,
	publicRestListClassifiers,
	publicRestListConnectors,
	publicRestSearchKnowledge,
	restGetWatchers,
	restHealth,
	restListTools,
	restSearchKnowledge,
	restToolProxy,
	restUpdateContentClassification,
} from "./rest-api";
import { getSchedulerHealth } from "./scheduled/scheduler-health";
import { isCloudMode } from "./utils/cloud-mode";
import { entityLinkMatchSql } from "./utils/content-search";
import { isValidFrameAncestor } from "./utils/csp";
import { errorMessage } from "./utils/errors";
import logger from "./utils/logger";
import { readMcpAppBundle } from "./utils/mcp-app-bundle";
import { generateOpenAPISpec } from "./utils/openapi-generator";
import {
	extractSubdomainOrg,
	getCanonicalRedirectUrl,
	getConfiguredPublicOrigin,
	getSubdomainZone,
} from "./utils/public-origin";
import {
	getClientIP,
	getRateLimiter,
	RateLimitPresets,
} from "./utils/rate-limiter";
import { getRuntimeInfo } from "./utils/runtime-info";
import { getWorkspaceProvider } from "./workspace";
import { joinPublicOrganization } from "./workspace/join-public";
import { invalidateOrgSlugCache } from "./workspace/multi-tenant";

export type { Env };

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Owned Owletto for Chrome extension IDs. Identity for CSP frame-ancestors
// AND CORS — both have to agree that an extension is "us", otherwise either
// iframe embedding or fetch-from-SW breaks. There are two distinct IDs and
// both are production facts, so both are pinned here:
//   - DEV/UNPACKED: derived from the manifest `key` field (see
//     lobu-ai/owletto:apps/chrome/manifest.json). This is the ID our local
//     harness and any unpacked build loads as.
//   - PUBLISHED: assigned by the Chrome Web Store, which overrides the
//     manifest `key` with its own signing key, so the store build runs under
//     a different ID (see lobu-ai/owletto:store-assets/STORE-LISTING.md and
//     apps/mac/Owletto/OwlettoApp.swift). The store ID was previously missing
//     from this list, so app.lobu.ai's frame-ancestors blocked the published
//     sidepanel iframe even though local dev worked.
const OWLETTO_EXTENSION_IDS = [
	"amnnhclgmbldmfcfamonoggjhfidemmm", // dev/unpacked (manifest `key`)
	"jhgcecbdpnoehfnhpdfihlchjddapepi", // Chrome Web Store (published)
] as const;

const CHROME_EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * Owned Owletto extension IDs (the pinned dev + published IDs, plus anything
 * pinned via the LOBU_OWLETTO_EXTENSION_IDS env so an ad-hoc build with a
 * different manifest key can be allowed alongside them). Same source for both
 * the CSP frame-ancestors directive on HTML responses and the CORS
 * allowlist that lets the service worker fetch /api/workers/poll.
 */
export function getOwnedOwlettoExtensionIds(env: Env): string[] {
	const extra = (env.LOBU_OWLETTO_EXTENSION_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => CHROME_EXTENSION_ID_RE.test(s));
	return [...OWLETTO_EXTENSION_IDS, ...extra];
}

export function isAllowedCorsOrigin(
	origin: string,
	env: Env,
	requestUrl: string,
): boolean {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}

	// The Owletto extension's service worker fetches /api/workers/poll as
	// origin chrome-extension://<id>. Match against the same owned-IDs list
	// the CSP block uses so the two trust boundaries can't drift.
	if (parsed.protocol === "chrome-extension:") {
		const owned = new Set(getOwnedOwlettoExtensionIds(env));
		return owned.has(parsed.hostname);
	}

	if (LOCALHOST_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
		return true;
	}

	// Behind a TLS-terminating proxy, c.req.url is http://, so the configured
	// public origin is the source of truth for the canonical (https) origin.
	const canonicalOrigin =
		getConfiguredPublicOrigin() ?? new URL(requestUrl).origin;

	if (parsed.origin === canonicalOrigin) return true;

	// Allow wildcard subdomains of the canonical origin (e.g. acme.lobu.com)
	// and — when AUTH_COOKIE_DOMAIN is configured — sibling subdomains under the
	// cookie zone so browsers on `acme.lobu.ai` can call `app.lobu.ai`.
	const parsedHost = parsed.hostname.toLowerCase();
	const baseDomain = new URL(canonicalOrigin).hostname.toLowerCase();
	if (parsedHost.endsWith(`.${baseDomain}`)) return true;

	const subdomainZone = getSubdomainZone(canonicalOrigin);
	if (
		subdomainZone &&
		(parsedHost === subdomainZone || parsedHost.endsWith(`.${subdomainZone}`))
	) {
		return true;
	}

	return false;
}

const STATIC_TEXT_CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
};

const STATIC_BINARY_CONTENT_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

const APP_ROOT = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
);

let webDistDirectoryCache: string | null | undefined;

async function resolveWebDistDirectory(): Promise<string | null> {
	if (webDistDirectoryCache !== undefined) {
		return webDistDirectoryCache;
	}

	const candidates = [
		process.env.WEB_DIST_DIR?.trim(),
		path.resolve(APP_ROOT, "packages/owletto/dist"),
		path.resolve(APP_ROOT, "../owletto/dist"),
		path.resolve(process.cwd(), "packages/owletto/dist"),
		path.resolve(process.cwd(), "../owletto/dist"),
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(path.join(candidate, "index.html"));
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
		return fs.readFile(
			path.resolve(viteDev.config.root, "index.html"),
			"utf-8",
		);
	}

	const webDistDirectory = await resolveWebDistDirectory();
	if (!webDistDirectory) return null;

	const spaEntry = resolveStaticFilePath(webDistDirectory, "/index.html");
	if (!spaEntry) return null;

	return fs.readFile(spaEntry, "utf-8");
}

async function loadFallbackSpaHtmlTemplate(): Promise<string | null> {
	// APP_ROOT is the server package dir (packages/server). The sibling
	// candidate must walk one level up first to land in `packages/`, then
	// into `owletto/`. The previous `../packages/owletto/...` form here and
	// in resolveWebDistDirectory was a copy-paste from when this file was
	// working from a different anchor — it resolves to
	// `packages/packages/owletto/...` and silently misses every time.
	// Same story for `../web/...` which was left over from the
	// packages/web → packages/owletto rename (#817).
	const candidates = [
		path.resolve(APP_ROOT, "packages/owletto/index.html"),
		path.resolve(APP_ROOT, "../owletto/index.html"),
		path.resolve(process.cwd(), "packages/owletto/index.html"),
		path.resolve(process.cwd(), "../owletto/index.html"),
	];

	for (const candidate of candidates) {
		try {
			return await fs.readFile(candidate, "utf-8");
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
		"application/octet-stream"
	);
}

function hasBetterAuthSessionCookie(
	cookieHeader: string | null | undefined,
): boolean {
	return (cookieHeader ?? "").includes("better-auth.session_token=");
}

function resolveStaticFilePath(
	distDir: string,
	requestPath: string,
): string | null {
	const normalizedPath = path.posix.normalize(requestPath || "/");
	if (normalizedPath.includes("..")) {
		return null;
	}

	const relativePath =
		normalizedPath === "/" ? "index.html" : normalizedPath.replace(/^\/+/, "");
	const resolved = path.resolve(distDir, relativePath);
	const relativeToDist = path.relative(distDir, resolved);
	if (relativeToDist.startsWith("..") || path.isAbsolute(relativeToDist)) {
		return null;
	}
	return resolved;
}

async function serveStaticFile(
	c: Context<{ Bindings: Env }>,
	filePath: string,
) {
	const stat = await fs.stat(filePath);
	if (!stat.isFile()) {
		return null;
	}

	const body = await fs.readFile(filePath);
	const extension = path.extname(filePath).toLowerCase();
	const isHtml = extension === ".html";

	c.header("Content-Type", getContentTypeForStaticFile(filePath));
	c.header(
		"Cache-Control",
		isHtml
			? "no-cache, no-store, must-revalidate"
			: "public, max-age=31536000, immutable",
	);
	// Hono's Data type expects Uint8Array<ArrayBuffer>; copy into a fresh
	// ArrayBuffer since fs.readFile returns Buffer<ArrayBufferLike>.
	const ab = new ArrayBuffer(body.byteLength);
	new Uint8Array(ab).set(body);
	return c.body(new Uint8Array(ab));
}

const app = new Hono<{ Bindings: Env }>();
app.use("/*", compress({ threshold: 1024 }));

// Enable CORS for MCP clients and frontend
app.use(
	"/*",
	cors({
		origin: (origin, c) => {
			if (!origin)
				return getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
			return isAllowedCorsOrigin(origin, c.env, c.req.url) ? origin : undefined;
		},
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		// X-Lobu-Client is the CSRF gate on /api/local-init; the SPA's local-install
		// auto-sign-in sends it, so it must survive a cross-origin preflight (Vite
		// dev origin → gateway, or the extension iframe).
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"X-MCP-Format",
			"X-Lobu-Client",
		],
		exposeHeaders: ["Content-Type"],
		credentials: true, // Required for better-auth cookies
	}),
);

// Add Pino logger middleware
app.use(
	"*",
	pinoLogger({
		pino: logger,
	}),
);

// Add security headers for ChatGPT connector safety
app.use("/*", async (c, next) => {
	await next();

	// Security headers required for safe API access
	c.header("X-Content-Type-Options", "nosniff");
	// Changed from DENY to SAMEORIGIN to allow ChatGPT connector validation
	c.header("X-Frame-Options", "SAMEORIGIN");
	c.header("X-XSS-Protection", "1; mode=block");
	c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

	// For HTML responses (SPA entrypoints), add a CSP frame-ancestors directive
	// that allows the lobu.ai landing page to embed the app. Modern browsers
	// prefer frame-ancestors over X-Frame-Options when both are present, so this
	// effectively loosens the SAMEORIGIN restriction for our own properties while
	// still blocking third-party clickjacking. JSON/API responses keep the
	// stricter header and no CSP, preserving ChatGPT connector validation.
	const contentType = c.res.headers.get("content-type") ?? "";
	if (contentType.startsWith("text/html")) {
		const rawFrameAncestors = c.env.FRAME_ANCESTORS?.trim();
		const frameAncestors = rawFrameAncestors
			? rawFrameAncestors
					.split(/[\s,]+/)
					.map((entry) => entry.trim())
					.filter((entry) => isValidFrameAncestor(entry))
					.join(" ")
			: "https://lobu.ai https://*.lobu.ai";
		// Owletto for Chrome embeds the whole app in its sidepanel iframe —
		// not just a stub route, the same UI users get in a regular tab. To
		// allow that without opening clickjacking risk to every extension on
		// the user's machine, we narrow the allow to OUR extension IDs (see
		// getOwnedOwlettoExtensionIds — same list the CORS allowlist uses).
		const extensionAllowed = getOwnedOwlettoExtensionIds(c.env)
			.map((id) => ` chrome-extension://${id}`)
			.join("");
		c.header(
			"Content-Security-Policy",
			`frame-ancestors 'self' ${frameAncestors}${extensionAllowed}`,
		);
	}

	c.header("Referrer-Policy", "strict-origin-when-cross-origin");
	// Minimal permissions policy to prevent FLoC without blocking ChatGPT validation
	c.header("Permissions-Policy", "interest-cohort=()");
});

/**
 * Subdomain org extraction middleware
 * Parses Host header for {org}.{zone} pattern and sets subdomainOrg.
 * The zone is AUTH_COOKIE_DOMAIN when set (so per-org hosts like `acme.lobu.ai`
 * resolve even though PUBLIC_GATEWAY_URL is `app.lobu.ai`), otherwise the
 * PUBLIC_GATEWAY_URL hostname. Reserved subdomains (www, api, app, admin, etc.)
 * are not treated as orgs.
 */
const RESERVED_SUBDOMAINS = new Set([
	"www",
	"api",
	"app",
	"admin",
	"auth",
	"mcp",
	"static",
	"assets",
	"cdn",
	"docs",
	"mail",
]);

app.use("/*", async (c, next) => {
	const zone = getSubdomainZone();
	const sub = extractSubdomainOrg(
		c.req.header("host"),
		zone,
		RESERVED_SUBDOMAINS,
	);
	c.set("subdomainOrg", sub);

	// On a subdomain host, redirect HTML GETs that carry a redundant `/{sub}`
	// prefix to the stripped path so direct/bookmarked links normalize to the
	// SPA's expected URL. Scoped to HTML so API clients are unaffected.
	if (
		sub &&
		c.req.method === "GET" &&
		c.req.header("accept")?.includes("text/html")
	) {
		const prefix = `/${sub}`;
		const path = c.req.path;
		if (path === prefix || path.startsWith(`${prefix}/`)) {
			const stripped = path.slice(prefix.length) || "/";
			const url = new URL(c.req.url);
			return c.redirect(`${stripped}${url.search}`, 301);
		}
	}

	return next();
});

app.use("/*", async (c, next) => {
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
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
 * Liveness probe — process is up. Cheap, dependency-free; failing this
 * signals "restart the pod." Don't add DB or downstream checks here, or a
 * transient pooler hiccup will cause a CrashLoop.
 */
app.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "lobu-api",
		timestamp: new Date().toISOString(),
		...getRuntimeInfo(c.env),
	});
});

/**
 * Readiness probe — process is up AND can talk to the database. Failing
 * this drops the pod from the Service's endpoint set without restarting
 * it, which is the right semantic for transient DB unavailability.
 */
app.get("/health/ready", async (c) => {
	// Once shutdown has begun, report unready so the LB drains this pod's
	// endpoint before teardown severs in-flight connections (see lifecycle-state.ts).
	if (isShuttingDown()) {
		return c.json({ status: "draining", service: "lobu-api" }, 503);
	}
	try {
		const sql = getDb();
		await sql`SELECT 1`;
		return c.json({ status: "ok", service: "lobu-api" });
	} catch (error) {
		return c.json(
			{ status: "unready", service: "lobu-api", error: errorMessage(error) },
			503,
		);
	}
});

/**
 * Orchestrator health / metric endpoint.
 *
 * Exposes the live count of `sql.reserve()` connections held by
 * `acquireConversationLock` (snapshot-mode per-conversation locks) so an
 * operator can spot pool pressure before it manifests as gateway query
 * starvation. Returns `near_cap: true` once the count crosses 80% of the
 * configured cap. Default cap is derived from DB_POOL_MAX so it can't
 * exceed available pool slots — operators override with
 * LOBU_MAX_RESERVED_LOCKS. The endpoint is cheap and dependency-free;
 * safe to scrape every few seconds.
 */
app.get("/health/orchestrator", (c) => {
	const count = getReservedLockCount();
	const cap = getMaxReservedLocks();
	const nearCap = cap > 0 && count >= Math.ceil(cap * 0.8);
	return c.json({
		status: "ok",
		reserved_conversation_locks: count,
		reserved_conversation_locks_cap: cap,
		near_cap: nearCap,
	});
});

/**
 * Scheduler health check endpoint
 * Returns detailed metrics about the feed scheduling system
 */
app.get("/health/scheduler", async (c) => {
	try {
		const health = await getSchedulerHealth(c.env);
		return c.json(health, health.healthy ? 200 : 503);
	} catch (error) {
		return c.json(
			{
				healthy: false,
				issues: ["Failed to check scheduler health"],
				error: errorMessage(error),
			},
			500,
		);
	}
});

/**
 * Better-Auth routes
 * Handles all authentication requests: OAuth, magic link, phone OTP, sessions.
 *
 * Single-user-mode enforcement (`LOBU_SINGLE_USER=1`) lives at
 * `databaseHooks.user.create.before` (auth/index.tsx), not here. The DB hook
 * sees every account-creation path — sign-up/email, magic-link verify, OAuth
 * callback — and refuses a second user with a structured `APIError`. A prior
 * path-based fast-fail at this layer also blocked the *first* `/sign-up`,
 * which made fresh local-first installs unable to register; that guard has
 * been removed in favour of the always-correct DB-hook chokepoint.
 */
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const auth = await createAuth(c.env, c.req.raw);
	// better-call crashes with "Unexpected end of JSON input" when a POST has
	// Content-Type: application/json but an empty body. Ensure a valid body.
	let request = c.req.raw;
	if (c.req.method === "POST") {
		const ct = c.req.header("content-type") || "";
		if (
			ct.includes("application/json") &&
			c.req.header("content-length") === "0"
		) {
			request = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: "{}",
			});
		}
	}
	return auth.handler(request);
});

/**
 * Credential management routes
 * Handles linking OAuth accounts to connections
 */
app.route("/api", credentialRoutes);

/**
 * OAuth 2.1 Authorization Server routes
 * Provides MCP authentication for HTTP clients (Claude.ai, ChatGPT)
 * Endpoints: /.well-known/*, /oauth/*
 */
app.route("/", oauthRoutes);
// Serve OAuth discovery relative to MCP path (Gemini CLI fetches /.well-known/* relative to transport URL)
app.route("/mcp", oauthRoutes);

/**
 * Connect Link routes (unauthenticated, token-gated)
 * Used by MCP clients to complete OAuth/env_keys auth for connections
 */
app.route("/connect", connectRoutes);

/**
 * Managed-connector connection-token route — PAT-gated. A managed connector
 * lives in a PUBLIC org with a managed `oauth_app`; a user joins it and
 * connects normally (a connection owned by them). Their LOCAL Lobu fetches a
 * fresh access token for its OWN user's connection via POST
 * /oauth/connection-token, authenticating with the user's cloud PAT. The
 * managed client secret + refresh token never leave the cloud.
 */
app.route("/", connectionTokenRoutes);

/**
 * Logo endpoint for MCP/OAuth client metadata.
 */
app.get("/logo.png", (c) => {
	const body = Buffer.from(LOBU_LOGO_PNG_BASE64, "base64");

	c.header("Content-Type", "image/png");
	c.header("Cache-Control", "public, max-age=31536000, immutable");
	return c.body(body);
});

/**
 * Legal/Terms endpoint for ChatGPT connector validation
 */
app.get("/legal", (c) => {
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

  <p style="margin-top: 40px; font-size: 0.9em; color: #999;">Last updated: ${new Date().toISOString().split("T")[0]}</p>
</body>
</html>`);
});

/**
 * REST API endpoints for ChatGPT Custom Actions and lightweight wrappers.
 * MCP tools are exposed through the generic /api/:orgSlug/:toolName proxy.
 */
// Health check and worker endpoints must be before mcpAuth middleware
app.get("/api/health", restHealth);

// Internal smoke-test dispatch. Authentication is a shared bearer
// (`SMOKE_TEST_TOKEN`) loaded into the pod via the deployment Secret —
// not exposed to public ingress consumers. Mounted before mcpAuth so the
// route handles its own auth without falling into the OAuth-bearer path.
import { createSmokeRoutes } from "./gateway/routes/internal/smoke";
import { createRuntimeRoutes } from "./gateway/routes/internal/runtime";

app.route("/api/internal/smoke", createSmokeRoutes());
app.route("", createRuntimeRoutes());

import {
	completeActionRun,
	completeAuthRun,
	completeEmbeddings,
	completeWatcherRun,
	completeWorkerJob,
	createMyDeviceAuthProfile,
	createMyDeviceFeed,
	deleteDeviceWorker,
	deleteMyDeviceAuthProfile,
	deleteMyDeviceFeed,
	emitAuthArtifact,
	fetchEventsForEmbedding,
	getActiveAuthRun,
	getAuthRun,
	heartbeat,
	listDeviceWorkers,
	listMyDeviceAuthProfiles,
	listMyDeviceFeeds,
	mintDeviceChildToken,
	pollAuthSignal,
	pollWorkerJob,
	postAuthSignal,
	streamContent,
	triggerWatcherForDevice,
	updateDeviceWorkerOrg,
} from "./worker-api";

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
app.use("/api/workers/*", async (c, next) => {
	const expected = c.env.WORKER_API_TOKEN;
	const provided = c.req.header("Authorization")?.replace("Bearer ", "");

	if (compareWorkerToken(provided, expected)) {
		c.set("workerAuthMode", "trusted");
		c.set("workerUserId", null);
		c.set("workerOrgIds", null);
		return next();
	}

	return mcpAuth(c, async () => {
		if (c.var.mcpIsAuthenticated && c.var.user?.id) {
			// A browser session is never a worker credential. The Owletto extension's
			// service-worker poll runs from a page Chrome treats as having host
			// permission, so Chrome attaches the gateway's Better Auth session cookie
			// to the request regardless of `credentials: "omit"` (verified: omit does
			// NOT suppress it for host-permission fetches). When the extension's
			// OAuth access token expires, the Bearer fails and mcpAuth falls back to
			// that cookie — authenticating the user but with no worker scopes. That
			// used to return 403 below, which the poller can't recover from (only 401
			// triggers tryRefreshToken). Returning 401 for any session-sourced auth
			// makes the expired token surface as the refreshable 401 it actually is.
			// Safe: real workers authenticate with a scoped PAT/OAuth token
			// (authSource 'pat'/'oauth') or the trusted WORKER_API_TOKEN (handled
			// above, never reaches here); a session has no worker scopes and would
			// have been rejected anyway — this only changes 403 → 401 for it.
			if (c.var.authSource === "session") {
				return c.json(
					{
						error: "invalid_token",
						error_description:
							"Worker endpoints require a worker token, not a browser session",
					},
					401,
				);
			}
			// User-scoped workers can only hit the endpoints needed to run a job
			// end-to-end. Auth-artifact / embeddings / repair-thread endpoints are
			// for server-side fleets and would leak across orgs without per-handler
			// scoping (which we haven't added). Block them at the door.
			const allowedPathsForUserWorker = new Set([
				"/api/workers/poll",
				"/api/workers/heartbeat",
				"/api/workers/stream",
				"/api/workers/complete",
				// Action runs (run_type='action') finalize via /complete-action,
				// which persists action_output. The handler still goes through
				// authorizeRunForWorker so a user worker can only finalize runs
				// it claimed. Required for chrome-extension action tools to
				// return their observation back to the gateway.
				"/api/workers/complete-action",
			]);
			const requestPath = new URL(c.req.url).pathname;
			const isAuthProfileSubpath = requestPath.startsWith(
				"/api/workers/me/auth-profiles",
			);
			const isFeedSubpath = requestPath.startsWith("/api/workers/me/feeds");
			// /api/workers/me/runs/<runId>/complete-watcher — device-side watcher
			// completion endpoint added in #798. The handler does its own
			// `authorizeRunForWorker` claim-ownership check, so an org-scope
			// gate here would just block legitimate posts from the bound device.
			const isWatcherCompleteSubpath =
				/^\/api\/workers\/me\/runs\/\d+\/complete-watcher$/.test(requestPath);
			// /api/workers/me/watchers/<watcher_id>/trigger — device-side manual
			// re-run endpoint. The handler does its own bound-workerId →
			// device_worker_id match, so the org-scope gate here would block
			// legitimate triggers from the pinned device.
			const isWatcherTriggerSubpath =
				/^\/api\/workers\/me\/watchers\/\d+\/trigger$/.test(requestPath);
			if (
				!allowedPathsForUserWorker.has(requestPath) &&
				!isAuthProfileSubpath &&
				!isFeedSubpath &&
				!isWatcherCompleteSubpath &&
				!isWatcherTriggerSubpath
			) {
				return c.json(
					{ error: "Endpoint not available to user-scoped workers" },
					403,
				);
			}
			const scopes = c.var.mcpAuthInfo?.scopes ?? [];
			if (
				!scopes.includes("device_worker:run") &&
				!scopes.includes("mcp:write") &&
				!scopes.includes("mcp:admin")
			) {
				return c.json(
					{ error: "Worker token missing device_worker:run scope" },
					403,
				);
			}
			const userId = c.var.user.id;
			// A device worker is scoped to the org its token is bound to (if any —
			// mcpAuth verified membership) plus the user's personal org, the
			// auto-wire target. Device-code tokens (Lobu for Mac/iPhone) often aren't
			// bound to any org, so the personal org alone is a valid scope.
			const boundOrgId = c.var.organizationId;
			const personalOrg = await findExistingPersonalOrg(userId, getDb());
			const orgIds = Array.from(
				new Set(
					[boundOrgId, personalOrg?.id].filter((id): id is string => !!id),
				),
			);
			if (orgIds.length === 0) {
				return c.json(
					{ error: "No organization in scope for this worker token" },
					403,
				);
			}
			c.set("workerAuthMode", "user");
			c.set("workerUserId", userId);
			c.set("workerOrgIds", orgIds);
			return next();
		}

		if (expected) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		// Anonymous fallback is a local-dev convenience only. In cloud/prod mode
		// (LOBU_CLOUD_MODE=1) an operator who forgets to set WORKER_API_TOKEN must
		// NOT silently expose poll/heartbeat/stream/complete/dispatch to anonymous
		// callers — fail closed instead of opening the worker fleet API.
		if (isCloudMode()) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		c.set("workerAuthMode", "anonymous");
		c.set("workerUserId", null);
		c.set("workerOrgIds", null);
		return next();
	});
});

app.post("/api/workers/poll", pollWorkerJob);
app.post("/api/workers/heartbeat", heartbeat);
app.post("/api/workers/stream", streamContent);
app.post("/api/workers/complete", completeWorkerJob);
app.post("/api/workers/complete-action", completeActionRun);

// Bridge that lets connector-worker fleets dispatch chrome connector actions
// against a paired Owletto extension. See dispatch-chrome-action.ts.
import { dispatchChromeAction } from "./worker-api/dispatch-chrome-action";

app.post("/api/workers/dispatch-chrome-action", dispatchChromeAction);
app.post("/api/workers/complete-embeddings", completeEmbeddings);
app.post("/api/workers/me/runs/:runId/complete-watcher", completeWatcherRun);
app.post(
	"/api/workers/me/watchers/:watcher_id/trigger",
	triggerWatcherForDevice,
);
app.post("/api/workers/fetch-events", fetchEventsForEmbedding);
app.post("/api/workers/emit-auth-artifact", emitAuthArtifact);
app.post("/api/workers/poll-auth-signal", pollAuthSignal);
app.post("/api/workers/complete-auth", completeAuthRun);
app.get("/api/workers/me/auth-profiles", listMyDeviceAuthProfiles);
app.post("/api/workers/me/auth-profiles", createMyDeviceAuthProfile);
app.delete("/api/workers/me/auth-profiles/:id", deleteMyDeviceAuthProfile);
app.get("/api/workers/me/feeds", listMyDeviceFeeds);
app.post("/api/workers/me/feeds", createMyDeviceFeed);
app.delete("/api/workers/me/feeds/:id", deleteMyDeviceFeed);
// Device worker registry. Authenticated (mcpAuth); returns the calling user's
// devices. Lives under /api/me/ so the workspace resolver treats it as
// user-scoped (no org slug in the URL).
app.get("/api/me/devices", mcpAuth, listDeviceWorkers);
app.patch("/api/me/devices/:id", mcpAuth, updateDeviceWorkerOrg);
app.delete("/api/me/devices/:id", mcpAuth, deleteDeviceWorker);
// Mint a child device-worker token for the caller — used by the Owletto Mac
// bridge's native-messaging host to auto-pair Owletto for Chrome.
app.post("/api/me/devices/mint-child-token", mcpAuth, mintDeviceChildToken);
// UI → worker signal channel. Separate path prefix so the worker API auth
// middleware above doesn't cover it (this one is hit from the web session).
app.get("/api/auth-runs/active", getActiveAuthRun);
app.get("/api/auth-runs/:id", getAuthRun);
app.post("/api/auth-runs/:id/signal", postAuthSignal);

/**
 * Auth configuration endpoint
 * Returns enabled authentication methods based on server env and connector_definitions
 */
app.get("/api/auth-config", async (c) => {
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
app.get("/api/invitation-preview", async (c) => {
	const rateLimiter = getRateLimiter();
	const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
	const rateLimit = rateLimiter.checkLimit(
		`rate:invitation-preview:${clientIP}`,
		RateLimitPresets.INVITATION_PREVIEW_PER_IP_MINUTE,
	);
	if (!rateLimit.allowed) {
		return c.json({ error: rateLimit.errorMessage }, 429);
	}

	const invitationId = c.req.query("id");
	if (!invitationId) {
		return c.json({ error: "not_found" }, 404);
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
		return c.json({ error: "not_found" }, 404);
	}

	return c.json({
		email: row.email,
		organizationName: row.organization_name,
	});
});

app.get("/robots.txt", async (c) => {
	const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
	c.header("Content-Type", "text/plain; charset=utf-8");
	c.header("Cache-Control", PUBLIC_XML_CACHE);
	return c.body(buildRobotsTxt(origin));
});

app.get("/sitemap.xml", async (c) => {
	const origin = getConfiguredPublicOrigin() ?? new URL(c.req.url).origin;
	const entries = await buildSitemapEntries(origin);
	c.header("Content-Type", "application/xml; charset=utf-8");
	c.header("Cache-Control", PUBLIC_XML_CACHE);
	return c.body(buildSitemapXml(entries));
});

// Organizations endpoint — returns orgs the authenticated user belongs to
app.get("/api/organizations", async (c) => {
	const provider = getWorkspaceProvider();
	const search = c.req.query("search")?.toLowerCase().trim();

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

// Preview: mint a link code for an agent on a hosted preview bot (Slack,
// Telegram, …). The code is redeemed by DMing that bot — no relay endpoint here.
app.post("/api/:orgSlug/preview/claims", mcpAuth, createPreviewClaim);

// Notifications
app.get(
	"/api/:orgSlug/connector-run/auth-profile/:slug",
	mcpAuth,
	restGetAuthProfileForRun,
);
app.get("/api/:orgSlug/connector-run/feed/:id", mcpAuth, restGetFeedForRun);

app.get("/api/:orgSlug/notifications", mcpAuth, restListNotifications);
app.get(
	"/api/:orgSlug/notifications/unread-count",
	mcpAuth,
	restGetUnreadCount,
);
app.patch("/api/:orgSlug/notifications/:id/read", mcpAuth, restMarkAsRead);
app.post(
	"/api/:orgSlug/notifications/mark-all-read",
	mcpAuth,
	restMarkAllAsRead,
);
app.delete("/api/:orgSlug/notifications/:id", mcpAuth, restDeleteNotification);

app.get("/api/:orgSlug/knowledge/search", mcpAuth, restSearchKnowledge);
app.get("/api/:orgSlug/public/knowledge/search", publicRestSearchKnowledge);
app.get("/api/:orgSlug/public/classifiers", publicRestListClassifiers);
app.get("/api/:orgSlug/public/connectors", publicRestListConnectors);
app.get(
	"/api/:orgSlug/public/connectors/:connectorKey",
	publicRestGetConnector,
);
app.get("/api/:orgSlug/public/organization", publicRestGetOrganization);
app.get("/api/:orgSlug/public/events", publicRestEventsStream);
app.patch(
	"/api/:orgSlug/content/:id/classifications/:classifier_slug",
	mcpAuth,
	restUpdateContentClassification,
);
app.get("/api/:orgSlug/watchers", mcpAuth, restGetWatchers);
app.get("/api/:orgSlug/public/watchers", publicRestGetWatchers);
app.get("/api/:orgSlug/watchers/windows/:windowId", mcpAuth, async (c) => {
	const sql = getDb();
	const windowId = c.req.param("windowId");
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
			return c.json({ error: "Window not found" }, 404);
		}

		return c.json(windowResult[0]);
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 500);
	}
});

async function handleContentDistribution(c: Context<{ Bindings: Env }>) {
	const sql = getDb();
	const entityId = Number(c.req.param("entityId"));
	const organizationId = c.var.organizationId;

	try {
		// Parse query parameters
		const connectionIdsParam = c.req.query("connection_ids");
		const connectionIds = connectionIdsParam
			? connectionIdsParam
					.split(",")
					.map((value) => Number(value.trim()))
					.filter((value) => Number.isInteger(value) && value > 0)
			: [];
		const groupByPlatform = c.req.query("group_by_platform") === "true";

		const connectionFilter =
			connectionIds.length > 0
				? `AND f.connection_id IN (${connectionIds.map((_, i) => `$${i + 3}`).join(", ")})`
				: "";
		const params: unknown[] = [entityId, organizationId, ...connectionIds];

		const platformSelect = groupByPlatform
			? ", f.connector_key as platform"
			: "";
		const platformGroupBy = groupByPlatform ? ", f.connector_key" : "";

		const distribution = await sql.unsafe(
			`
      SELECT
        TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD') as date
        ${platformSelect},
        CAST(COUNT(*) AS INTEGER) as count
      FROM current_event_records f
      WHERE ${entityLinkMatchSql("$1::bigint", "f")}
        AND EXISTS (SELECT 1 FROM entities e WHERE e.id = $1 AND e.organization_id = $2)
        ${connectionFilter}
      GROUP BY TO_CHAR(DATE_TRUNC('day', COALESCE(f.occurred_at, f.created_at)), 'YYYY-MM-DD')${platformGroupBy}
      ORDER BY date ASC
    `,
			params,
		);
		return c.json({ distribution });
	} catch (error) {
		return c.json({ error: errorMessage(error) }, 500);
	}
}

app.get(
	"/api/:orgSlug/entities/:entityId/content-distribution",
	mcpAuth,
	handleContentDistribution,
);

// ============================================
// V1 Integration Platform REST Routes
// ============================================

// Connections
app.get("/api/:orgSlug/connections", mcpAuth, async (c) => {
	return restToolProxy(c, "manage_connections", {
		action: "list",
		...c.req.query(),
	});
});
app.post("/api/:orgSlug/connections", mcpAuth, async (c) => {
	const body = await c.req.json();
	return restToolProxy(c, "manage_connections", { action: "create", ...body });
});
app.get("/api/:orgSlug/connections/:id", mcpAuth, async (c) => {
	return restToolProxy(c, "manage_connections", {
		action: "get",
		connection_id: Number(c.req.param("id")),
	});
});
app.delete("/api/:orgSlug/connections/:id", mcpAuth, async (c) => {
	return restToolProxy(c, "manage_connections", {
		action: "delete",
		connection_id: Number(c.req.param("id")),
	});
});

// Runs
app.get("/api/:orgSlug/runs", mcpAuth, async (c) => {
	return restToolProxy(c, "manage_operations", {
		action: "list_runs",
		...c.req.query(),
	});
});

// Actions
app.get("/api/:orgSlug/actions/available", mcpAuth, async (c) => {
	return restToolProxy(c, "manage_operations", {
		action: "list_available",
		...c.req.query(),
	});
});
app.post("/api/:orgSlug/actions/execute", mcpAuth, async (c) => {
	const body = await c.req.json();
	return restToolProxy(c, "manage_operations", { action: "execute", ...body });
});

app.patch("/api/:orgSlug/organization/visibility", mcpAuth, async (c) => {
	const organizationId = c.get("organizationId");
	const memberRole = c.get("memberRole");

	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace visibility requires owner or admin access.",
			},
			403,
		);
	}

	const authSource = c.get("authSource");
	if (authSource === "pat") {
		return c.json(
			{
				error: "forbidden",
				message: "Use OAuth or a web session to change workspace visibility.",
			},
			403,
		);
	}

	const scopes = c.get("mcpAuthInfo")?.scopes ?? [];
	if (authSource === "oauth" && !scopes.includes("mcp:admin")) {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace visibility changes require mcp:admin scope.",
			},
			403,
		);
	}

	let body: { visibility?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}

	const visibility = body.visibility;
	if (visibility !== "public" && visibility !== "private") {
		return c.json(
			{
				error: "invalid_request",
				message: 'Visibility must be "public" or "private".',
			},
			400,
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
		visibility: "public" | "private";
	}>`
    UPDATE "organization"
    SET visibility = ${visibility}
    WHERE id = ${organizationId}
    RETURNING id, name, slug, logo, description, "createdAt" AS created_at, visibility
  `;

	const org = rows[0];
	if (!org) {
		return c.json({ error: "not_found", message: "Workspace not found." }, 404);
	}

	invalidateOrgSlugCache(c.req.param("orgSlug"));
	invalidateOrgSlugCache(org.slug);
	invalidationEmitter.emit(org.id, {
		keys: ["organizations", "resolve-path"],
	});

	return c.json({ organization: { ...org, is_member: true } });
});

app.route("/catalog", globalCatalogRoutes);
app.route("/api/:orgSlug/installed", orgInstalledRoutes);
app.route("/api/:orgSlug/agents", agentRoutes);
app.route("/api/:orgSlug/environments", environmentRoutes);
app.route("/api/:orgSlug/clients", clientRoutes);
app.route("/api/agents/platforms", platformSchemaRoutes);

// ============================================
// SSE Invalidation Events (for frontend cache sync)
// ============================================
app.get("/api/:orgSlug/events", invalidationSseAuth, async (c) => {
	const orgId = c.get("organizationId");
	if (!orgId) return c.json({ error: "Organization context required" }, 401);

	return streamInvalidationEvents(c, String(orgId));
});

/**
 * Features endpoint — lets the frontend discover which capabilities are available.
 * Agents page is always shown (MCP setup works without Lobu runtime features).
 */
app.get("/api/features", (c) => {
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
app.post("/api/:orgSlug/join", async (c) => {
	const rateLimiter = getRateLimiter();
	const clientIP = getClientIP(c.req.raw, c.var.peerRemoteAddress);
	const rateLimit = rateLimiter.checkLimit(
		`rate:join-public-org:${clientIP}`,
		RateLimitPresets.JOIN_PUBLIC_ORG_PER_IP_HOUR,
	);
	if (!rateLimit.allowed) {
		return c.json({ error: rateLimit.errorMessage }, 429);
	}

	const auth = await createAuth(c.env);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	const userId = session?.session?.userId;
	if (!userId) {
		return c.json(
			{
				error: "unauthorized",
				error_description: "Sign in to join a workspace.",
			},
			401,
		);
	}

	const orgSlug = c.req.param("orgSlug");
	if (!orgSlug) return c.json({ error: "invalid_request" }, 400);

	const result = await joinPublicOrganization({ userId, orgSlug });
	if (result.status === "not_found") {
		return c.json(
			{ error: "not_found", error_description: "Workspace not found." },
			404,
		);
	}
	if (result.status === "not_public") {
		return c.json(
			{
				error: "forbidden",
				error_description:
					"This workspace is private. Ask an owner for an invitation.",
			},
			403,
		);
	}

	return c.json({
		status: result.status,
		organizationId: result.organizationId,
		role: result.role,
	});
});

/**
 * Resolve the signed-in user's team-scoped `slack_user_id` (`T…:U…`) for a Slack
 * workspace, returning the bare `U…` id or null when they never signed in with
 * Slack for that team. Reuses the canonical `entity_identities` shape the authz
 * layer writes on Slack sign-in (namespace `slack_user_id`, identifier stored
 * uppercased as `T…:U…` on the user's `$member`), joined to the user's memberships
 * via the guarded `auth_user_id`/`auth:signup` claim so a user-supplied identity
 * row can't hijack the lookup. Org-agnostic (the identity may live in any org the
 * user belongs to), so it runs BEFORE we resolve the org to bind into.
 */
async function resolveClaimingUserSlackId(
	userId: string,
	teamId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT DISTINCT ei.identifier
		FROM "member" m
		JOIN entity_identities auth_ei
		  ON auth_ei.organization_id = m."organizationId"
		 AND auth_ei.namespace = 'auth_user_id'
		 AND auth_ei.identifier = m."userId"
		 AND auth_ei.source_connector = 'auth:signup'
		 AND auth_ei.deleted_at IS NULL
		JOIN entity_identities ei
		  ON ei.organization_id = auth_ei.organization_id
		 AND ei.entity_id = auth_ei.entity_id
		 AND ei.namespace = 'slack_user_id'
		 AND ei.deleted_at IS NULL
		WHERE m."userId" = ${userId}
	`) as Array<{ identifier: string }>;
	const teamPrefix = `${teamId.toUpperCase()}:`;
	const combined = rows
		.map((r) => String(r.identifier))
		.find((id) => id.startsWith(teamPrefix));
	return combined ? combined.slice(teamPrefix.length) : null;
}

/**
 * POST /api/slack/claim — claim a marketplace / Slack-initiated (pending) Slack
 * workspace into the signed-in user's org.
 *
 * Body: `{ team: string, token: string }` — the workspace id and the single-use
 * claim token from the installer's DM'd link. Binds the parked pending install
 * (see `writeSlackPendingInstall`) to the user's default org after proving the
 * caller (a) holds the single-use token, (b) signed in with Slack for this
 * workspace, and (c) is a workspace admin/owner. Neither the bot token nor the
 * plaintext claim token is ever logged or returned.
 *
 * Registered before the `/api/:orgSlug/:toolName` proxy so `slack`/`claim`
 * doesn't get swallowed as an org tool call.
 */
// The main app doesn't run the Lobu auth bridge, so resolve the session here
// (same pattern as /api/:orgSlug/join). Cookie or Better-Auth bearer.
async function resolveClaimSessionUser(env: Env, req: Request): Promise<string | null> {
	try {
		const auth = await createAuth(env);
		const session = await auth.api.getSession({ headers: req.headers });
		return session?.user?.id ?? null;
	} catch {
		return null;
	}
}

// Wire the real stores/APIs behind the injectable SlackClaimDeps (shared by the
// context + claim routes).
function slackClaimDeps(): SlackClaimDeps {
	return {
		resolvePending: (t) => resolveSlackPendingByTenant(t),
		resolveActiveOrgSlug: async (team) => {
			const rows = (await getDb()`
				SELECT o.slug
				FROM app_installations ai
				JOIN "organization" o ON o.id = ai.organization_id
				WHERE ai.provider = 'slack'
					AND ai.external_tenant_id = ${team}
					AND ai.status = 'active'
				LIMIT 1
			`) as Array<{ slug: string }>;
			return rows[0]?.slug ?? null;
		},
		resolveClaimerSlackId: resolveClaimingUserSlackId,
		usersInfo: (botToken, uid) => createSlackWebApi().usersInfo(botToken, uid),
		resolveMemberOrgs: async (userId) =>
			(await getDb()`
				SELECT o.id, o.slug, o.name
				FROM "member" m JOIN "organization" o ON o.id = m."organizationId"
				WHERE m."userId" = ${userId}
				ORDER BY o.name
			`) as ClaimEligibleOrg[],
		resolveOrgIfMember: async (userId, orgSlugOrId) => {
			const rows = (await getDb()`
				SELECT o.id
				FROM "organization" o
				JOIN "member" m ON m."organizationId" = o.id AND m."userId" = ${userId}
				WHERE o.slug = ${orgSlugOrId} OR o.id = ${orgSlugOrId}
				LIMIT 1
			`) as Array<{ id: string }>;
			return rows[0]?.id ?? null;
		},
		resolveDefaultOrgId: (uid) => resolveDefaultOrgId(uid),
		claim: (pending, organizationId) => {
			const core = getLobuCoreServices();
			if (!core) throw new Error("Lobu core services unavailable");
			return claimSlackPendingInstall(
				core.getAppInstallationStore(),
				core.getSecretStore(),
				pending,
				organizationId,
			);
		},
		resolveOrgSlug: async (organizationId) => {
			const orgRows = (await getDb()`
				SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
			`) as Array<{ slug: string }>;
			return orgRows[0]?.slug ?? null;
		},
	};
}

/** Map a claim/context status to its HTTP code (shared by both routes). */
function slackClaimHttpStatus(status: string): 400 | 401 | 403 | 404 | 409 | 500 {
	switch (status) {
		case "unauthenticated":
			return 401;
		case "invalid_request":
			return 400;
		case "no_pending_install":
			return 404;
		case "slack_signin_required":
		case "not_admin":
		case "not_member_of_org":
			return 403;
		case "no_org":
			return 409;
		default:
			return 500;
	}
}

// GET /api/slack/claim/context — the confirm step's data. Runs the guards
// (Slack workspace-admin) with NO write and returns the workspace name + the
// claimer's orgs, so /slack/claim can render "Connect <workspace> to <org>"
// before binding. Surfaces `already_connected` for a workspace already bound, so
// the UI links to it instead of erroring on a re-visited/spent link.
app.get("/api/slack/claim/context", async (c) => {
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);
	const team = (c.req.query("team") ?? "").trim();
	const ctx = await resolveSlackClaimContext(slackClaimDeps(), {
		userId,
		team,
	});
	if (ctx.status === "ready") {
		return c.json({ ok: true, workspaceName: ctx.workspaceName, orgs: ctx.orgs });
	}
	if (ctx.status === "already_connected") {
		return c.json({ ok: true, alreadyConnected: true, orgSlug: ctx.orgSlug });
	}
	return c.json({ error: ctx.status }, slackClaimHttpStatus(ctx.status));
});

app.post("/api/slack/claim", async (c) => {
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);

	let body: { team?: unknown; org?: unknown };
	try {
		body = (await c.req.json()) as {
			team?: unknown;
			org?: unknown;
		};
	} catch {
		body = {};
	}
	const team = typeof body.team === "string" ? body.team.trim() : "";
	// The org the user CONFIRMED on the /slack/claim page (slug or id). Optional
	// for programmatic callers, who then fall back to the default org.
	const organizationId =
		typeof body.org === "string" && body.org.trim() ? body.org.trim() : undefined;

	// All branching lives in the injectable `claimSlackWorkspace` so it stays
	// unit-testable; the route only wires real deps + maps outcomes to HTTP.
	const result = await claimSlackWorkspace(slackClaimDeps(), {
		userId,
		team,
		organizationId,
	});

	if (result.status === "ok") {
		return c.json({
			ok: true,
			orgSlug: result.orgSlug,
			provider: "slack",
			alreadyConnected: result.alreadyConnected ?? false,
		});
	}
	if (result.status === "claim_failed") {
		logger.error({ team, err: result.message }, "Slack workspace claim failed");
		return c.json(
			{ error: "claim_failed", message: result.message },
			500,
		);
	}
	return c.json({ error: result.status }, slackClaimHttpStatus(result.status));
});

/**
 * GET /api/:orgSlug/tools
 * List admin REST tools available to the caller. Companion to the POST
 * proxy below — gives CLI/web callers a discovery surface without spinning
 * up an MCP session just to call tools/list.
 */
app.get("/api/:orgSlug/tools", mcpAuth, restListTools);

/**
 * Generic tool proxy - forwards to any MCP tool
 * POST /api/:orgSlug/:toolName with JSON body
 */
app.post("/api/:orgSlug/:toolName", mcpAuth, async (c) => {
	return restToolProxy(c);
});

/**
 * OpenAPI spec endpoint for ChatGPT
 * Dynamically generated from tool registry schemas
 */
// The tool registry is static after boot, so the generated spec only depends
// on the request origin (a tiny set in practice). Memoize per origin to turn
// this polled endpoint into a Map lookup instead of an O(tools × schema) walk.
const openApiSpecCache = new Map<string, object>();
app.get("/openapi.json", (c) => {
	const configuredOrigin = getConfiguredPublicOrigin();
	const serverUrl = configuredOrigin ?? new URL(c.req.url).origin;
	if (!configuredOrigin) {
		return c.json(generateOpenAPISpec(serverUrl));
	}
	let spec = openApiSpecCache.get(serverUrl);
	if (!spec) {
		spec = generateOpenAPISpec(serverUrl);
		openApiSpecCache.set(serverUrl, spec);
	}
	return c.json(spec);
});

/**
 * ChatGPT plugin manifest
 */
app.get("/.well-known/ai-plugin.json", (c) => {
	const baseUrl = new URL(c.req.url).origin;
	const openApiUrl = new URL("/openapi.json", baseUrl).toString();
	const logoUrl =
		c.env.PUBLIC_LOGO_URL ?? new URL("/logo.png", baseUrl).toString();
	const legalInfoUrl =
		c.env.PUBLIC_LEGAL_URL ?? new URL("/legal", baseUrl).toString();
	return c.json({
		schema_version: "v1",
		name_for_human: "Lobu",
		name_for_model: "lobu",
		description_for_human:
			"Build searchable workspace knowledge from customer content across platforms",
		description_for_model:
			"Access workspace knowledge and customer content from Reddit, Trustpilot, App Stores, and other platforms. Search knowledge, retrieve saved knowledge, and get watchers and analytics.",
		auth: {
			type: "none",
		},
		api: {
			type: "openapi",
			url: openApiUrl,
		},
		logo_url: logoUrl,
		contact_email: "support@example.com",
		legal_info_url: legalInfoUrl,
	});
});

/**
 * Apply MCP authentication middleware and Streamable HTTP transport handler.
 * Supports GET (SSE stream), POST (JSON-RPC), and DELETE (session teardown).
 */
app.use("/mcp", mcpAuth);
app.use("/mcp/", mcpAuth);
app.use("/mcp/:orgSlug", mcpAuth);
app.use("/mcp/:orgSlug/", mcpAuth);
app.all("/mcp", handleMcp);
app.all("/mcp/", handleMcp);
app.all("/mcp/:orgSlug", handleMcp);
app.all("/mcp/:orgSlug/", handleMcp);

// MCP App bundle — asset-only static delivery (NOT an approval endpoint). Serves
// the self-contained `ui://` iframe payload built by owletto `build:mcp-apps`
// (dist-mcp-apps/interaction/index.html) so our own SPA can host every
// interactive interaction (approval, question, tool grant, link) in a sandboxed
// iframe. There is no action logic here — each action rides an MCP `tools/call`
// brokered by the SPA host bridge. The same `readMcpAppBundle` resolver backs
// the MCP `resources/read` path for external hosts.
app.get("/mcp-apps/:app/index.html", async (c) => {
	const app_ = c.req.param("app");
	// Only serve a bundle the MCP App registry declares — never an arbitrary
	// path param.
	if (!MCP_APP_DIRS.has(app_)) return c.notFound();
	const html = await readMcpAppBundle(app_);
	if (html == null) return c.notFound();
	c.header("Content-Type", "text/html; charset=utf-8");
	c.header("Cache-Control", "no-cache");
	return c.body(html);
});

/**
 * Catch-all route
 * Dev: Vite middleware handles source files/HMR before reaching here.
 *      This catch-all serves SPA index.html via Vite's transformIndexHtml.
 * Prod: Serves static files from packages/owletto/dist with SPA fallback.
 */
app.get("*", async (c) => {
	const requestPath = c.req.path;
	const acceptHeader = c.req.header("accept") ?? "";
	const acceptsHtml = acceptHeader.includes("text/html");
	const acceptsGenericResponse = !acceptHeader || acceptHeader.includes("*/*");
	const hasSessionCookie = hasBetterAuthSessionCookie(c.req.header("cookie"));
	const hasFileExtension =
		/\.(?:js|css|html|json|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|txt|xml)$/i.test(
			requestPath,
		);
	const isSpaRoute = !hasFileExtension && !isExcludedSpaPath(requestPath);
	// Generic signed-in requests still need the SPA shell; otherwise they would fall through to the
	// JSON status response after skipping anonymous public SSR.
	const shouldServeSpaFallback =
		(acceptsHtml || (acceptsGenericResponse && hasSessionCookie)) && isSpaRoute;
	if (
		(acceptsHtml || acceptsGenericResponse) &&
		!hasSessionCookie &&
		isSpaRoute
	) {
		const publicPageModel = await buildPublicPageModel(
			requestPath,
			c.env,
			c.req.url,
			c.get("subdomainOrg"),
		);
		if (publicPageModel) {
			const template = await loadAnySpaHtmlTemplate();
			if (template) {
				const rendered = renderPublicPageTemplate(template, publicPageModel);
				const html = viteDev
					? await viteDev.transformIndexHtml(c.req.path, rendered)
					: rendered;
				c.header("Cache-Control", publicPageModel.cacheControl);
				c.header("Vary", "Accept, Cookie");
				return c.html(html, publicPageModel.status as 200 | 404);
			}
		}
	}

	// Dev: serve Vite-transformed index.html for SPA routes
	if (viteDev) {
		if (shouldServeSpaFallback) {
			const raw = await fs.readFile(
				path.resolve(viteDev.config.root, "index.html"),
				"utf-8",
			);
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
				const spaEntry = resolveStaticFilePath(webDistDirectory, "/index.html");
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
	c.header("Cache-Control", "no-store");
	return c.json({
		status: "ok",
		mcp_endpoint: new URL("/mcp", baseUrl).toString(),
		health: "/health",
		openapi: "/openapi.json",
	});
});

// Vite dev server instance — set by server.ts in development for SPA index.html transforms
let viteDev: any = null;
export function setViteDev(v: any) {
	viteDev = v;
}

export { app };
