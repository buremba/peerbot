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
import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
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
import { decodeJwtClaims } from "./auth/subject-identities";
import { compareWorkerToken } from "./auth/worker-token";
import {
	deleteEntityApprovalPolicy,
	type EntityApprovalPolicy,
	type EntityMutationMode,
	getGlobalEntityApprovalPolicy,
	isEntityApprovalUiMode,
	isEntityMutationMode,
	listEntityApprovalPolicies,
	upsertEntityApprovalPolicy,
	upsertGlobalEntityApprovalPolicy,
} from "./authz/entity-policy";
import { listOperations } from "./operations/connector-operations";
import { qualifiedOperationKey } from "./tools/admin/manage_operations";
import {
	isLegalActionEffect,
	type WriteAction,
} from "./authz/write-action-manifest";
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
	resolveBoundChannelRows,
	stripPlatformPrefix,
} from "./gateway/channels/bound-channels";
import {
	type ClaimEligibleOrg,
	type ClaimEngineDeps,
	type ClaimProvider,
	claimHttpStatus,
	claimPendingConnection,
	resolveClaimContext,
} from "./gateway/connections/connection-claim";
import { slackClaimProvider } from "./gateway/connections/slack-claim";
import { autoLinkBuilderAndWelcome } from "./gateway/connections/slack-claim-onboarding";
import { createSlackWebApi } from "./gateway/connections/slack-web";
import {
	getMaxReservedLocks,
	getReservedLockCount,
} from "./gateway/orchestration/deployment-manager";
import { isExcludedSpaPath } from "./http/spa-route-filter";
import { isShuttingDown } from "./lifecycle-state";
import { agentRoutes } from "./lobu/agent-routes";
import { clientRoutes } from "./lobu/client-routes";
import { deploymentRoutes } from "./lobu/deployment-routes";
import { environmentRoutes } from "./lobu/environment-routes";
import {
	getLobuCoreServices,
	isLobuGatewayRunning,
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
			? "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
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

import { createRuntimeRoutes } from "./gateway/routes/internal/runtime";
// Internal smoke-test dispatch. Authentication is a shared bearer
// (`SMOKE_TEST_TOKEN`) loaded into the pod via the deployment Secret —
// not exposed to public ingress consumers. Mounted before mcpAuth so the
// route handles its own auth without falling into the OAuth-bearer path.
import { createSmokeRoutes } from "./gateway/routes/internal/smoke";

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
		// Canvas-on-events: windowId is the canvas ROOT event id; canvas_windows
		// resolves the chain (head payload + run provenance). Content links are
		// counted off watcher_window_events.window_id (re-keyed to the root id).
		const windowResult = await sql`
      SELECT
        iw.id,
        iw.watcher_id,
        iw.granularity,
        iw.window_start,
        iw.window_end,
        iw.version_id,
        iw.created_at,
        iw.extracted_data,
        iw.content_analyzed,
        iw.client_id,
        iw.model_used,
        iw.run_metadata,
        i.entity_ids,
        i.slug as watcher_slug,
        i.name as watcher_name,
        e.name as entity_name,
        et.slug AS entity_type,
        parent.name as parent_name,
        CAST(COUNT(iwf.event_id) AS INTEGER) as content_count
      FROM canvas_windows iw
      JOIN watchers i ON i.id = iw.watcher_id
      JOIN entities e ON e.id = ANY(i.entity_ids)
      JOIN entity_types et ON et.id = e.entity_type_id
      LEFT JOIN entities parent ON e.parent_id = parent.id
      LEFT JOIN watcher_window_events iwf ON iwf.window_id = iw.id
      WHERE iw.id = ${windowId}
        AND e.organization_id = ${organizationId}
        AND i.status = 'active'
      GROUP BY iw.id, iw.watcher_id, iw.granularity, iw.window_start, iw.window_end,
               iw.version_id, iw.created_at, iw.extracted_data, iw.content_analyzed,
               iw.client_id, iw.model_used, iw.run_metadata,
               i.entity_ids, i.slug, i.name, e.name, et.slug, parent.name
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

function serializeEntityApprovalPolicy(policy: EntityApprovalPolicy) {
	return {
		id: policy.id,
		organization_id: policy.organizationId,
		resource_class: policy.resourceClass,
		principal_kind: policy.principalKind,
		principal_id: policy.principalId,
		principal_mode: policy.principalMode,
		operation_key: policy.operationKey,
		entity_type_slug: policy.entityTypeSlug,
		field_path: policy.fieldPath,
		entity_id: policy.entityId,
		create_mode: policy.createMode,
		update_mode: policy.updateMode,
		delete_mode: policy.deleteMode,
		// The full per-action effect map (incl. deny/disabled/execute), for the
		// agent Permissions UI which the create/update/delete triple can't express.
		effects: policy.effects,
		approval_connection_id: policy.deliveryTarget.connectionId,
		approval_channel_id: policy.deliveryTarget.channelId,
		approval_team_id: policy.deliveryTarget.teamId,
		approval_channel_name: policy.deliveryTarget.channelName,
	};
}

async function requireOrganizationSettingsAdmin(c: Context) {
	const organizationId = c.get("organizationId");
	const memberRole = c.get("memberRole");

	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	if (memberRole !== "owner" && memberRole !== "admin") {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings require owner or admin access.",
			},
			403,
		);
	}

	const authSource = c.get("authSource");
	if (authSource === "pat") {
		return c.json(
			{
				error: "forbidden",
				message: "Use OAuth or a web session to change workspace settings.",
			},
			403,
		);
	}

	const scopes = c.get("mcpAuthInfo")?.scopes ?? [];
	if (authSource === "oauth" && !scopes.includes("mcp:admin")) {
		return c.json(
			{
				error: "forbidden",
				message: "Workspace settings changes require mcp:admin scope.",
			},
			403,
		);
	}

	return null;
}

app.get("/api/:orgSlug/entity-approval-policy", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const policy = await getGlobalEntityApprovalPolicy(organizationId);
	// This legacy org-settings surface is MODE-BLIND: its PATCH/DELETE key a row by
	// scope+principal WITHOUT principal_mode, so it can only address the both-mode
	// (principal_mode NULL) rows. Autonomous-only rows are created and managed solely
	// by the agent Permissions UI; surfacing them here would let a delete of the
	// displayed autonomous row hit the same-scope attended row instead. Filter them
	// out so this endpoint neither shows nor mutates them.
	const policies = (
		await listEntityApprovalPolicies(organizationId, "entity")
	).filter((p) => p.principalMode === null);
	const channelRows = await resolveBoundChannelRows(getDb(), {
		organizationId,
	});
	const availableChannels = channelRows.map((row) => {
		const nativeChannelId = stripPlatformPrefix(row.platform, row.channel_id);
		return {
			connection_id: row.id,
			platform: row.platform,
			channel_id: row.channel_id,
			team_id: row.team_id,
			label: `${row.platform} ${nativeChannelId}`,
		};
	});

	return c.json({
		policy: serializeEntityApprovalPolicy(policy),
		policies: policies.map(serializeEntityApprovalPolicy),
		available_channels: availableChannels,
	});
});

app.patch("/api/:orgSlug/entity-approval-policy", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}

	const createMode = body.create_mode;
	const updateMode = body.update_mode;
	const deleteMode = body.delete_mode;
	if (
		!isEntityApprovalUiMode(createMode) ||
		!isEntityApprovalUiMode(updateMode) ||
		!isEntityApprovalUiMode(deleteMode)
	) {
		return c.json(
			{
				error: "invalid_request",
				message:
					'create_mode, update_mode, and delete_mode must be "auto" or "approval".',
			},
			400,
		);
	}

	// Optional per-principal targeting: an admin can pin one agent/watcher to a
	// stricter mode. principal_id is only meaningful with a kind. Class is fixed to
	// 'entity' on this endpoint — connector_action policy rows are ENFORCED by the
	// gate (manage_operations.execute) but set via SDK/SQL until their own UI
	// surface lands; this endpoint stays entity-only so its auto/approval mode
	// validation doesn't have to fork for the deny/disabled connector modes.
	const principalKind: "agent" | "watcher" | null =
		body.principal_kind === "agent" || body.principal_kind === "watcher"
			? body.principal_kind
			: null;
	const principalId =
		principalKind &&
		typeof body.principal_id === "string" &&
		body.principal_id.trim()
			? body.principal_id.trim()
			: null;

	const approvalConnectionId =
		typeof body.approval_connection_id === "string" &&
		body.approval_connection_id.trim()
			? body.approval_connection_id.trim()
			: null;
	const approvalChannelId =
		typeof body.approval_channel_id === "string" &&
		body.approval_channel_id.trim()
			? body.approval_channel_id.trim()
			: null;
	const approvalTeamId =
		typeof body.approval_team_id === "string" && body.approval_team_id.trim()
			? body.approval_team_id.trim()
			: null;

	let approvalChannelName =
		typeof body.approval_channel_name === "string" &&
		body.approval_channel_name.trim()
			? body.approval_channel_name.trim()
			: null;

	if (approvalConnectionId || approvalChannelId || approvalTeamId) {
		if (!approvalConnectionId || !approvalChannelId) {
			return c.json(
				{
					error: "invalid_request",
					message:
						"Approval channel selection requires a connection and channel.",
				},
				400,
			);
		}
		const rows = await resolveBoundChannelRows(getDb(), { organizationId });
		const selected = rows.find((row) => {
			const rowChannelKey = row.channel_id.includes(":")
				? row.channel_id
				: `${row.platform}:${row.channel_id}`;
			const requestedChannelKey = approvalChannelId.includes(":")
				? approvalChannelId
				: `${row.platform}:${approvalChannelId}`;
			return (
				row.id === approvalConnectionId &&
				rowChannelKey === requestedChannelKey &&
				(!approvalTeamId || row.team_id === approvalTeamId)
			);
		});
		if (!selected) {
			return c.json(
				{
					error: "invalid_request",
					message: "Approval channel is not available to this workspace.",
				},
				400,
			);
		}
		approvalChannelName =
			approvalChannelName ??
			`${selected.platform} ${stripPlatformPrefix(selected.platform, selected.channel_id)}`;
	}

	const entityTypeSlug =
		typeof body.entity_type_slug === "string" && body.entity_type_slug.trim()
			? body.entity_type_slug.trim()
			: null;
	const fieldPath =
		typeof body.field_path === "string" && body.field_path.trim()
			? body.field_path.trim()
			: null;
	const entityId =
		typeof body.entity_id === "number" && Number.isInteger(body.entity_id)
			? body.entity_id
			: null;

	if (fieldPath && !entityTypeSlug) {
		return c.json(
			{
				error: "invalid_request",
				message: "A field-path approval policy requires an entity type.",
			},
			400,
		);
	}
	if (entityId !== null) {
		const entityRows = await getDb()<{ id: number }>`
      SELECT id FROM entities
      WHERE id = ${entityId}
        AND organization_id = ${organizationId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
		if (!entityRows[0]) {
			return c.json(
				{
					error: "invalid_request",
					message: "Entity not found in this workspace.",
				},
				400,
			);
		}
	}

	const policyInput = {
		resourceClass: "entity" as const,
		principalKind,
		principalId,
		entityTypeSlug,
		fieldPath,
		entityId,
		createMode,
		updateMode,
		deleteMode,
		approvalConnectionId,
		approvalChannelId,
		approvalTeamId,
		approvalChannelName,
	};
	// Only the unscoped, any-principal entity row is the workspace default; a
	// principal-targeted or scoped row is a specific override.
	const isWorkspaceDefault =
		!principalKind && !entityTypeSlug && !fieldPath && entityId === null;
	const policy = isWorkspaceDefault
		? await upsertGlobalEntityApprovalPolicy(organizationId, policyInput)
		: await upsertEntityApprovalPolicy(organizationId, policyInput);

	invalidationEmitter.emit(organizationId, {
		keys: ["entity-approval-policy"],
	});

	return c.json({ policy: serializeEntityApprovalPolicy(policy) });
});

app.delete("/api/:orgSlug/entity-approval-policy", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const principalKindRaw = c.req.query("principal_kind")?.trim();
	const principalKind =
		principalKindRaw === "agent" || principalKindRaw === "watcher"
			? principalKindRaw
			: null;
	const principalId = principalKind
		? c.req.query("principal_id")?.trim() || null
		: null;
	const entityTypeSlug = c.req.query("entity_type_slug")?.trim() || null;
	const fieldPath = c.req.query("field_path")?.trim() || null;
	const entityIdRaw = c.req.query("entity_id")?.trim();
	const entityId =
		entityIdRaw && /^\d+$/.test(entityIdRaw) ? Number(entityIdRaw) : null;
	// A principal-targeted row is deletable even with no scope; only the unscoped,
	// any-principal default is protected.
	if (!principalKind && !entityTypeSlug && !fieldPath && entityId === null) {
		return c.json(
			{
				error: "invalid_request",
				message: "The workspace default policy cannot be deleted.",
			},
			400,
		);
	}
	if (fieldPath && !entityTypeSlug) {
		return c.json(
			{
				error: "invalid_request",
				message: "A field-path approval policy requires an entity type.",
			},
			400,
		);
	}
	const deleted = await deleteEntityApprovalPolicy({
		organizationId,
		resourceClass: "entity",
		principalKind,
		principalId,
		entityTypeSlug,
		fieldPath,
		entityId,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["entity-approval-policy"],
	});
	return c.json({ deleted });
});

// ---------------------------------------------------------------------------
// Agent permissions ("Guardrails" is the separate LLM-judge surface; this is the
// deterministic write-gate envelope). Returns the ORG FLOOR rows (principal_kind
// NULL) and THIS AGENT's rows across all three write classes, so the UI can show
// the floor as a non-loosenable baseline and the agent's overrides on top.
app.get("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");
	const all = await listEntityApprovalPolicies(organizationId);
	// The matrix models ONLY blanket (null entity_type) and entity-type scopes.
	// Field-scoped (fieldPath) and single-entity (entityId) rows are finer than the
	// matrix can express: the client keys agent rows by (class, mode, type) alone,
	// so a field/entity row would be misrendered as type-wide and editing it would
	// silently widen it into a type policy. Exclude them from BOTH lists — they are
	// managed on the entity/field surfaces, not this agent matrix.
	const typeScoped = (p: EntityApprovalPolicy) =>
		p.fieldPath === null && p.entityId === null;
	// Floor = the non-loosenable baseline this agent inherits. TWO kinds of row bind
	// it (both fold into the write-gate for this agent via loadCandidatePolicies, and
	// neither is editable on THIS per-agent surface):
	//  - any-principal rows (principal_kind NULL) — the org-wide floor, and
	//  - KIND-WIDE agent rows (principal_kind 'agent', principal_id NULL) — an
	//    "all agents" policy that applies to every agent. Omitting these made the
	//    matrix show/permit values LOOSER than the resolver enforces.
	// Agent = rows pinned to THIS agent id (the editable overrides). A watcher-kind
	// row is NOT the agent's envelope (watchers inherit the agent envelope in
	// autonomous mode; they have no separate principal here).
	const floor = all.filter(
		(p) =>
			typeScoped(p) &&
			(p.principalKind === null ||
				(p.principalKind === "agent" && p.principalId === null)),
	);
	const agent = all.filter(
		(p) =>
			p.principalKind === "agent" &&
			p.principalId === agentId &&
			typeScoped(p),
	);
	// Types the org can create/update entities for: its own PLUS any public-catalog
	// org's (visibility='public') — the same local-or-public resolution entity
	// creation uses. The write gate keys on the slug, so a catalog-backed type
	// (e.g. `company`) must be offerable as a per-type exception. Dedupe by slug,
	// preferring the org-owned row, and drop `$member` (per-tenant, never a public
	// catalog type) to mirror the entity-write resolver.
	const typeRows = await getDb()<{ slug: string; name: string }>`
    SELECT slug, name FROM (
      SELECT DISTINCT ON (et.slug) et.slug, et.name
      FROM entity_types et
      LEFT JOIN organization o ON o.id = et.organization_id
      WHERE et.deleted_at IS NULL
        AND et.slug <> '$member'
        AND (et.organization_id = ${organizationId} OR o.visibility = 'public')
      ORDER BY et.slug, (et.organization_id = ${organizationId}) DESC, et.id ASC
    ) t
    ORDER BY name ASC
  `;
	// The org's WRITE connector operations, so the matrix can render one row per
	// operation under connector_action (always-expanded). Only write ops are gated —
	// reads never mutate, so they carry no per-op rule. The row's `operation_key` is
	// the CONNECTOR-QUALIFIED key (`connector_key::op`) — the exact value the policy
	// row and the execute gate bind to — so Linear's and GitHub's `create_issue`
	// stay distinct rows. Deduped by that qualified key (the same op can surface from
	// multiple connections OF THE SAME connector).
	const opList = await listOperations({
		organizationId,
		kind: "write",
		includeInputSchema: false,
		includeOutputSchema: false,
		limit: Number.MAX_SAFE_INTEGER,
	});
	const seenOps = new Set<string>();
	const operations: Array<{
		operation_key: string;
		name: string;
		connector_key: string;
		connector_name: string;
	}> = [];
	for (const op of opList.operations) {
		const key = qualifiedOperationKey(op.connector_key, op.operation_key);
		if (seenOps.has(key)) continue;
		seenOps.add(key);
		operations.push({
			operation_key: key,
			name: op.name,
			connector_key: op.connector_key,
			connector_name: op.connector_name,
		});
	}
	return c.json({
		floor: floor.map(serializeEntityApprovalPolicy),
		agent: agent.map(serializeEntityApprovalPolicy),
		entity_types: typeRows.map((r) => ({ slug: r.slug, name: r.name })),
		connector_operations: operations,
	});
});

// Upsert one agent policy row: a (class, entity_type?, mode?) scope with a full
// per-action effect map. Effects may be auto/approval/deny/disabled — the UI, not
// the create/update/delete triple, is the source of truth here.
app.put("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");

	let body: Record<string, unknown>;
	try {
		body = await c.req.json();
	} catch {
		return c.json(
			{ error: "invalid_request", message: "Request body must be JSON." },
			400,
		);
	}
	// Valid JSON `null` / an array / a primitive parses without throwing but isn't a
	// policy body — dereferencing body.resource_class below would 500. Require a plain
	// object so we return the intended 400.
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return c.json(
			{ error: "invalid_request", message: "Request body must be a JSON object." },
			400,
		);
	}

	const resourceClass =
		body.resource_class === "entity" ||
		body.resource_class === "agent_config" ||
		body.resource_class === "connector_action"
			? body.resource_class
			: null;
	if (!resourceClass) {
		return c.json(
			{
				error: "invalid_request",
				message:
					"resource_class must be entity, agent_config, or connector_action.",
			},
			400,
		);
	}

	// The per-action effect map. This PUT REPLACES the row's whole child-effect set,
	// so a silently-dropped bad entry would ERASE an existing effect (e.g. a stale
	// client sending an entity `execute` could wipe a stored `delete=deny` back to
	// the auto default). REJECT the request on any invalid entry instead of filtering
	// or clamping — an unknown action, a non-effect value, or an (action,effect) pair
	// illegal for this class all 400.
	// Must be a plain OBJECT map. An ARRAY passes `typeof === "object"` but yields no
	// Object.entries → the replace-all upsert would wipe the row's stored effects
	// (erasing deny/approval). Reject arrays explicitly.
	const rawEffects =
		typeof body.effects === "object" &&
		body.effects !== null &&
		!Array.isArray(body.effects)
			? (body.effects as Record<string, unknown>)
			: null;
	if (!rawEffects) {
		return c.json(
			{ error: "invalid_request", message: "effects must be a JSON object." },
			400,
		);
	}
	const effects: Partial<Record<WriteAction, EntityMutationMode>> = {};
	for (const [action, effect] of Object.entries(rawEffects)) {
		if (
			!isEntityMutationMode(effect) ||
			!isLegalActionEffect(resourceClass, action as WriteAction, effect)
		) {
			return c.json(
				{
					error: "invalid_request",
					message: `Illegal effect for ${resourceClass}: '${action}' = '${String(effect)}'.`,
				},
				400,
			);
		}
		effects[action as WriteAction] = effect;
	}

	// principal_mode selects WHICH row this write targets: omitted/null = the
	// both-mode row, 'autonomous' = the autonomous-only override. Silently coercing
	// any other value to null would make a typo'd/unsupported mode clobber the
	// ATTENDED row instead of the intended autonomous one — so reject it.
	if (
		body.principal_mode !== undefined &&
		body.principal_mode !== null &&
		body.principal_mode !== "autonomous"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "principal_mode must be omitted, null, or 'autonomous'.",
			},
			400,
		);
	}
	const principalMode = body.principal_mode === "autonomous" ? "autonomous" : null;
	// entity_type_slug selects the per-type row (null = the blanket all-types row).
	// Only the `entity` class is type-scoped. A present-but-invalid slug (number,
	// whitespace) OR a slug on a NON-entity class must not silently coerce to null and
	// overwrite the broad blanket policy — 400, same as principal_mode.
	const slugPresent =
		body.entity_type_slug !== undefined && body.entity_type_slug !== null;
	if (slugPresent && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		slugPresent &&
		(typeof body.entity_type_slug !== "string" ||
			body.entity_type_slug.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" &&
		typeof body.entity_type_slug === "string" &&
		body.entity_type_slug.trim()
			? body.entity_type_slug.trim()
			: null;

	// operation_key selects the per-operation connector row (null = the blanket
	// execute row). Only `connector_action` is op-scoped. Same rules as
	// entity_type_slug: a present-but-invalid key, or a key on a non-connector class,
	// must 400 rather than silently coerce to null and overwrite the blanket rule.
	const opKeyPresent =
		body.operation_key !== undefined && body.operation_key !== null;
	if (opKeyPresent && resourceClass !== "connector_action") {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (
		opKeyPresent &&
		(typeof body.operation_key !== "string" ||
			body.operation_key.trim() === "")
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" &&
		typeof body.operation_key === "string" &&
		body.operation_key.trim()
			? body.operation_key.trim()
			: null;
	// A per-op rule must name an operation the org actually exposes — else a typo
	// would create a dead row that gates nothing and clutters the matrix. The client
	// sends the CONNECTOR-QUALIFIED key (`connector_key::op`); validate against the
	// same qualified catalog the matrix renders.
	if (operationKey) {
		const known = await listOperations({
			organizationId,
			kind: "write",
			includeInputSchema: false,
			includeOutputSchema: false,
			limit: Number.MAX_SAFE_INTEGER,
		});
		const knownQualified = new Set(
			known.operations.map((op) =>
				qualifiedOperationKey(op.connector_key, op.operation_key),
			),
		);
		if (!knownQualified.has(operationKey)) {
			return c.json(
				{
					error: "invalid_request",
					message: `Unknown connector operation '${operationKey}' for this workspace.`,
				},
				400,
			);
		}
	}

	// The policy row targets this agent by id (a reusable slug). Confirm the agent
	// EXISTS in this org before persisting — else a stale/typo'd URL would leave an
	// orphan row that a future agent recreated with the same id silently inherits.
	const agentExists = await getDb()<{ id: string }>`
    SELECT id FROM agents
    WHERE id = ${agentId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
	if (!agentExists[0]) {
		return c.json(
			{ error: "not_found", message: `Agent '${agentId}' not found in this workspace.` },
			404,
		);
	}

	const policy = await upsertEntityApprovalPolicy(organizationId, {
		resourceClass,
		principalKind: "agent",
		principalId: agentId,
		principalMode,
		operationKey,
		entityTypeSlug,
		effects,
		// Effect-only endpoint: keep any approval delivery target already on the row.
		preserveDelivery: true,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["entity-approval-policy"],
	});
	return c.json({ policy: serializeEntityApprovalPolicy(policy) });
});

// Delete one agent override row (falls back to the floor / class default).
app.delete("/api/:orgSlug/agent/:agentId/permissions", mcpAuth, async (c) => {
	const authError = await requireOrganizationSettingsAdmin(c);
	if (authError) return authError;
	const organizationId = c.get("organizationId");
	if (!organizationId) {
		return c.json({ error: "Organization context required" }, 401);
	}
	const agentId = c.req.param("agentId");
	const resourceClassRaw = c.req.query("resource_class")?.trim();
	const resourceClass =
		resourceClassRaw === "entity" ||
		resourceClassRaw === "agent_config" ||
		resourceClassRaw === "connector_action"
			? resourceClassRaw
			: null;
	if (!resourceClass) {
		return c.json(
			{ error: "invalid_request", message: "resource_class is required." },
			400,
		);
	}
	// Same rule as the PUT: principal_mode picks the target row (null = the both-mode
	// row). ONLY a truly-ABSENT param maps to null — a PRESENT value that isn't exactly
	// 'autonomous' (a typo, whitespace, or empty `?principal_mode=`) must 400, else the
	// DELETE would fall through to null and destroy the attended/both-mode row.
	const principalModeParam = c.req.query("principal_mode");
	if (
		principalModeParam !== undefined &&
		principalModeParam.trim() !== "autonomous"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: "principal_mode must be omitted or 'autonomous'.",
			},
			400,
		);
	}
	const principalMode =
		principalModeParam?.trim() === "autonomous" ? "autonomous" : null;
	// entity_type_slug picks WHICH row to delete (null = the blanket all-types row).
	// A present-but-empty slug, or a slug on a non-entity class, must NOT coerce to
	// null and delete the blanket policy instead of the intended per-type override.
	const slugRaw = c.req.query("entity_type_slug");
	if (slugRaw !== undefined && slugRaw !== "" && resourceClass !== "entity") {
		return c.json(
			{
				error: "invalid_request",
				message: `entity_type_slug is only valid for resource_class 'entity', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (slugRaw !== undefined && slugRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "entity_type_slug must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const entityTypeSlug =
		resourceClass === "entity" ? (slugRaw?.trim() ?? null) || null : null;
	// operation_key picks WHICH connector row to delete (null = the blanket execute
	// row). Same guard as entity_type_slug: a present-but-empty value, or a key on a
	// non-connector class, must NOT coerce to null and delete the blanket rule.
	const opKeyRaw = c.req.query("operation_key");
	if (
		opKeyRaw !== undefined &&
		opKeyRaw !== "" &&
		resourceClass !== "connector_action"
	) {
		return c.json(
			{
				error: "invalid_request",
				message: `operation_key is only valid for resource_class 'connector_action', not '${resourceClass}'.`,
			},
			400,
		);
	}
	if (opKeyRaw !== undefined && opKeyRaw.trim() === "") {
		return c.json(
			{
				error: "invalid_request",
				message: "operation_key must be a non-empty string or omitted.",
			},
			400,
		);
	}
	const operationKey =
		resourceClass === "connector_action" ? (opKeyRaw?.trim() ?? null) || null : null;
	const deleted = await deleteEntityApprovalPolicy({
		organizationId,
		resourceClass,
		principalKind: "agent",
		principalId: agentId,
		principalMode,
		operationKey,
		entityTypeSlug,
	});
	invalidationEmitter.emit(organizationId, {
		keys: ["entity-approval-policy"],
	});
	return c.json({ deleted });
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
app.route("/api/:orgSlug/deployments", deploymentRoutes);
app.route("/api/:orgSlug/environments", environmentRoutes);
app.route("/api/:orgSlug/clients", clientRoutes);

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
 * Resolve ALL of the signed-in user's `slack_user_id` identities as
 * `{teamId, slackUserId}` pairs — every workspace they've signed in with Slack
 * for. Reuses the canonical `entity_identities` shape the authz layer writes on
 * Slack sign-in (namespace `slack_user_id`, identifier stored uppercased as
 * `T…:U…` on the user's `$member`), joined to the user's memberships via the
 * guarded `auth_user_id`/`auth:signup` claim so a user-supplied identity row
 * can't hijack the lookup. Org-agnostic (the identity may live in any org the
 * user belongs to), so it runs BEFORE we resolve the org to bind into. The claim
 * guard filters by team (workspace membership) or matches the bare `U…` against
 * a Grid pending install's `installerUserId`.
 */
async function resolveClaimingUserSlackIdentities(
	userId: string,
): Promise<Array<{ teamId: string; slackUserId: string }>> {
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
		 AND ei.namespace = ${SLACK_IDENTITY.USER_ID}
		 AND ei.deleted_at IS NULL
		WHERE m."userId" = ${userId}
	`) as Array<{ identifier: string }>;
	// The identity is stored as `T…:U…` (team-scoped). Split into a team id and a
	// bare `U…` id; the claim guard filters by team (membership) or matches the
	// bare id against the pending install's installerUserId (Grid).
	const fromGraph = rows
		.map((r) => String(r.identifier))
		.map((id) => {
			const sep = id.indexOf(":");
			return sep === -1
				? null
				: { teamId: id.slice(0, sep), slackUserId: id.slice(sep + 1) };
		})
		.filter((x): x is { teamId: string; slackUserId: string } => x !== null);

	// FALLBACK: the entity-graph `slack_user_id` above is only written once the
	// user's private-org `$member` provisioning has completed AND their signup
	// identity landed in a private org (see `persistLoginSlackIdentity` /
	// `resolveTenantMember`). A brand-new user whose signup org is public — or
	// whose provisioning hasn't finished — has NO such row, so the graph join is
	// empty and the claim dead-ends in a "Sign in with Slack" loop even though
	// they just did. Their linked Better-Auth Slack `account` row is an
	// independent, always-present proof of the same `U…` (the OIDC subject stored
	// as `accountId`), captured directly by "Sign in with Slack". Union it in so
	// claim authority never depends on the identity-graph timing.
	//
	// The team is read from the stored `id_token` (`https://slack.com/team_id`)
	// when present, giving a team-scoped entry for Path 1 (workspace membership);
	// absent, we still emit the bare `U…` with an empty team, which satisfies the
	// Grid installer-match (Path 2, `slackUserId === installerUserId`). `U…` ids
	// are enterprise-global, so the bare match is sound on a Grid.
	const accountRows = (await sql`
		SELECT "accountId", "idToken"
		FROM account
		WHERE "providerId" = 'slack' AND "userId" = ${userId}
	`) as Array<{ accountId: string | null; idToken: string | null }>;
	const fromAccounts = accountRows
		.map((a) => {
			const slackUserId = a.accountId?.toUpperCase();
			if (!slackUserId) return null;
			const teamId = a.idToken
				? ((decodeJwtClaims(a.idToken)?.["https://slack.com/team_id"] as
						| string
						| undefined) ?? "")
				: "";
			return { teamId: teamId.toUpperCase(), slackUserId };
		})
		.filter((x): x is { teamId: string; slackUserId: string } => x !== null);

	// De-dup by `team:user` so a user present in both sources isn't doubled.
	const seen = new Set<string>();
	return [...fromGraph, ...fromAccounts].filter((x) => {
		const key = `${x.teamId}:${x.slackUserId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The provider-agnostic connection "claim" routes bind a parked (pending)
 * provider install to the signed-in user's org after the provider's authority
 * check passes. Slack is the first consumer; other chat/data providers register
 * a `ClaimProvider` in `claimProviders` and get the same two routes for free. No
 * secret link token — authority is the provider's `authorize` verdict.
 *
 * Registered before the `/api/:orgSlug/:toolName` proxy so `connector`/`…`
 * doesn't get swallowed as an org tool call.
 */
// The main app doesn't run the Lobu auth bridge, so resolve the session here
// (same pattern as /api/:orgSlug/join). Cookie or Better-Auth bearer.
async function resolveClaimSessionUser(
	env: Env,
	req: Request,
): Promise<string | null> {
	try {
		const auth = await createAuth(env);
		const session = await auth.api.getSession({ headers: req.headers });
		return session?.user?.id ?? null;
	} catch {
		return null;
	}
}

// Wire the real org-resolution stores behind the injectable ClaimEngineDeps —
// provider-agnostic, shared by every claim provider.
function claimEngineDeps(): ClaimEngineDeps {
	return {
		resolveMemberOrgs: async (userId) =>
			(await getDb()`
				SELECT o.id, o.slug, o.name,
					(o.metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL
						AS "isPersonal"
				FROM "member" m JOIN "organization" o ON o.id = m."organizationId"
				WHERE m."userId" = ${userId}
				ORDER BY "isPersonal", o.name
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
		resolveOrgSlug: async (organizationId) => {
			const orgRows = (await getDb()`
				SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
			`) as Array<{ slug: string }>;
			return orgRows[0]?.slug ?? null;
		},
	};
}

// Wire the Slack authority half (workspace-admin identity + usersInfo + bind)
// behind the ClaimProvider the engine consumes.
function buildSlackClaimProvider(): ClaimProvider {
	return slackClaimProvider({
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
		resolveClaimerSlackIdentities: resolveClaimingUserSlackIdentities,
		usersInfo: (botToken, uid) => createSlackWebApi().usersInfo(botToken, uid),
		claim: async (pending, organizationId) => {
			const core = getLobuCoreServices();
			if (!core) throw new Error("Lobu core services unavailable");
			const result = await claimSlackPendingInstall(
				core.getAppInstallationStore(),
				core.getSecretStore(),
				pending,
				organizationId,
			);
			// Post-claim, best-effort: auto-link the org's Builder agent to the
			// installer's DM and fire the welcome DM. Never throws — a failure here
			// must not fail the claim the user is waiting on (the workspace is
			// already bound). This is the DM half of onboarding; named channels stay
			// explicit (bot posts a bind link when added to a channel).
			await autoLinkBuilderAndWelcome({
				teamId: pending.teamId,
				organizationId,
				installerUserId: pending.installerUserId ?? null,
				secretStore: core.getSecretStore(),
			});
			return result;
		},
	}) as ClaimProvider;
}

// Provider registry for the generic claim routes. Adding a claim provider is one
// entry here — the two routes below dispatch through it; unknown → 404.
const claimProviders = new Map<string, () => ClaimProvider>([
	["slack", buildSlackClaimProvider],
]);

// GET /api/connector/:connector/connection/claim-context?ref=… — the confirm
// step's data. Runs the provider's authority guards with NO write and returns
// the subject name + the claimer's orgs, so the SPA claim page can render
// "Connect <subject> to <org>" before binding. Surfaces `already_connected` for
// a subject already bound, so the UI links to it instead of erroring on a
// re-visited/spent link. Registered before the `/api/:orgSlug/:toolName` proxy.
app.get("/api/connector/:connector/connection/claim-context", async (c) => {
	const buildProvider = claimProviders.get(c.req.param("connector"));
	if (!buildProvider) return c.json({ error: "unknown_provider" }, 404);
	const provider = buildProvider();
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);
	const ref = (c.req.query("ref") ?? "").trim();
	const ctx = await resolveClaimContext(provider, claimEngineDeps(), {
		userId,
		ref,
	});
	if (ctx.status === "ready") {
		return c.json({
			ok: true,
			subjectKind: provider.subjectKind,
			subjectName: ctx.subjectName,
			orgs: ctx.orgs,
		});
	}
	if (ctx.status === "already_connected") {
		return c.json({ ok: true, alreadyConnected: true, orgSlug: ctx.orgSlug });
	}
	if (ctx.status === "signin_required") {
		return c.json(
			{ error: ctx.status, signinProvider: ctx.signinProvider },
			claimHttpStatus(ctx.status),
		);
	}
	if (ctx.status === "not_authorized") {
		return c.json(
			{ error: ctx.status, code: ctx.code },
			claimHttpStatus(ctx.status),
		);
	}
	return c.json({ error: ctx.status }, claimHttpStatus(ctx.status));
});

app.post("/api/connector/:connector/connection/claim", async (c) => {
	const buildProvider = claimProviders.get(c.req.param("connector"));
	if (!buildProvider) return c.json({ error: "unknown_provider" }, 404);
	const provider = buildProvider();
	const userId = await resolveClaimSessionUser(c.env, c.req.raw);

	let body: { ref?: unknown; org?: unknown };
	try {
		body = (await c.req.json()) as { ref?: unknown; org?: unknown };
	} catch {
		body = {};
	}
	const ref = typeof body.ref === "string" ? body.ref.trim() : "";
	// The org the user CONFIRMED on the claim page (slug or id). REQUIRED — an
	// org-less claim is rejected by the engine (`invalid_request`), never routed
	// to a default org. This flow creates a connection under an org from an
	// external OAuth request, so the destination must be an explicit human choice.
	const organizationId =
		typeof body.org === "string" && body.org.trim()
			? body.org.trim()
			: undefined;

	// All branching lives in the injectable engine so it stays unit-testable;
	// the route only wires real deps + maps outcomes to HTTP.
	const result = await claimPendingConnection(provider, claimEngineDeps(), {
		userId,
		ref,
		organizationId,
	});

	if (result.status === "ok") {
		return c.json({
			ok: true,
			orgSlug: result.orgSlug,
			provider: provider.provider,
			alreadyConnected: result.alreadyConnected ?? false,
		});
	}
	if (result.status === "claim_failed") {
		logger.error(
			{ connector: provider.provider, ref, err: result.message },
			"Connection claim failed",
		);
		return c.json({ error: "claim_failed", message: result.message }, 500);
	}
	if (result.status === "signin_required") {
		return c.json(
			{ error: result.status, signinProvider: result.signinProvider },
			claimHttpStatus(result.status),
		);
	}
	if (result.status === "not_authorized") {
		return c.json(
			{ error: result.status, code: result.code },
			claimHttpStatus(result.status),
		);
	}
	return c.json({ error: result.status }, claimHttpStatus(result.status));
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
