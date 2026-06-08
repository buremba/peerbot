import { createLogger, type SecretRef, verifyWorkerToken } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ProviderUpstreamConfig } from "../modules/module-system.js";
import { orgContext } from "../../lobu/stores/org-context.js";
import type { SecretStore } from "../secrets/index.js";
import { getClientIp } from "../utils/rate-limiter.js";

/**
 * Caller-supplied resolver: agentId → orgId of the agent's owning org.
 *
 * The proxy needs an independent source of the caller's org to compare
 * against `SecretMapping.organizationId` — without it the org-scoping
 * guard on `lookupPlaceholderMapping` has nothing to enforce against and
 * collapses to dead code. The deployment manager wires a DB-backed
 * resolver with a small TTL cache at boot.
 */
export type AgentOrgResolver = (agentId: string) => Promise<string | null>;

const logger = createLogger("secret-proxy");

const PLACEHOLDER_PREFIX = "lobu_secret_";

/**
 * Default TTL for orphaned placeholder→secret mappings. Mappings are
 * cascade-deleted on deployment teardown (`deleteSecretMappings`); this TTL
 * only bounds how long a mapping survives if teardown never runs (worker pod
 * crash, agent deleted mid-day). 24h instead of the old ~7 days narrows the
 * window an orphaned `lobu_secret_<uuid>` stays live. Configurable via
 * `SECRET_PLACEHOLDER_TTL_MS`.
 */
function defaultPlaceholderTtlSeconds(): number {
  const raw = process.env.SECRET_PLACEHOLDER_TTL_MS;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  return 24 * 60 * 60;
}

/**
 * Per-source cap on *failed* placeholder resolutions. A compromised worker can
 * probe the proxy with bogus `lobu_secret_<uuid>` tokens; without a cap each
 * miss is logged, so it doubles as a log-spam vector. Once a source exceeds
 * the threshold within the window, further resolutions hard-fail and we log
 * the throttle once instead of per-attempt. Only failures count — legitimate
 * high-throughput valid lookups are never throttled.
 */
const RESOLVE_FAILURE_THRESHOLD = 20;
const RESOLVE_FAILURE_WINDOW_MS = 5 * 60 * 1000;

interface FailureBucket {
  count: number;
  windowStartMs: number;
  throttledLogged: boolean;
}

class ResolutionFailureLimiter {
  private readonly buckets = new Map<string, FailureBucket>();

  /** Returns true if the source is currently throttled (over threshold). */
  isThrottled(source: string): boolean {
    const bucket = this.buckets.get(source);
    if (!bucket) return false;
    if (Date.now() - bucket.windowStartMs >= RESOLVE_FAILURE_WINDOW_MS) {
      this.buckets.delete(source);
      return false;
    }
    return bucket.count >= RESOLVE_FAILURE_THRESHOLD;
  }

  /**
   * Record a failed resolution for a source. Returns whether the caller
   * should log this particular failure (true the first time the threshold is
   * crossed — the "source throttled" line — and for every failure below it;
   * false once we've already logged the throttle for this window).
   */
  recordFailure(source: string): { shouldLog: boolean; nowThrottled: boolean } {
    const now = Date.now();
    let bucket = this.buckets.get(source);
    if (!bucket || now - bucket.windowStartMs >= RESOLVE_FAILURE_WINDOW_MS) {
      bucket = { count: 0, windowStartMs: now, throttledLogged: false };
      this.buckets.set(source, bucket);
    }
    bucket.count += 1;
    const nowThrottled = bucket.count >= RESOLVE_FAILURE_THRESHOLD;
    if (nowThrottled) {
      if (bucket.throttledLogged) return { shouldLog: false, nowThrottled };
      bucket.throttledLogged = true;
      return { shouldLog: true, nowThrottled };
    }
    return { shouldLog: true, nowThrottled };
  }

  /** Record a successful resolution — clears the source's failure bucket. */
  recordSuccess(source: string): void {
    this.buckets.delete(source);
  }

  reset(): void {
    this.buckets.clear();
  }
}

const resolutionFailureLimiter = new ResolutionFailureLimiter();

/**
 * In-memory placeholder→SecretMapping cache. Per-pod by design: workers are
 * spawned as child processes of their owner pod and always proxy through
 * `HTTP_PROXY=127.0.0.1:8118` (set by the deployment manager). They cannot
 * reach a sibling pod's secret-proxy, so cross-pod resolution is never
 * required — every pod self-serves its own workers' placeholders.
 */
interface CacheEntry {
  mapping: SecretMapping;
  expiresAt: number;
}

class PlaceholderCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Last full sweep (ms). Lazy GC: sweep on writes when stale enough. */
  private lastSweepMs = 0;
  private static readonly SWEEP_INTERVAL_MS = 60_000;

  get(uuid: string): SecretMapping | null {
    const entry = this.entries.get(uuid);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(uuid);
      return null;
    }
    return entry.mapping;
  }

  set(uuid: string, mapping: SecretMapping, ttlSeconds: number): void {
    this.entries.set(uuid, {
      mapping,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    this.maybeSweep();
  }

  delete(uuid: string): void {
    this.entries.delete(uuid);
  }

  /** Drop every mapping pinned to a deployment (cascade on teardown). */
  deleteByDeployment(deploymentName: string): number {
    let removed = 0;
    for (const [uuid, entry] of this.entries) {
      if (entry.mapping.deploymentName === deploymentName) {
        this.entries.delete(uuid);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweepMs < PlaceholderCache.SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = now;
    for (const [uuid, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(uuid);
    }
  }
}

/** Module-level singleton: gateway has one secret proxy and one mapping cache. */
const placeholderCache = new PlaceholderCache();

/**
 * Resolve a placeholder string (`lobu_secret_<uuid>` or a prefixed variant)
 * to its stored {@link SecretMapping}. Returns `null` if the placeholder is
 * malformed, expired, missing, or — when `expectedOrganizationId` is supplied
 * — pinned to a different tenant.
 *
 * Exported for tests so the org-scoping guard can be exercised without
 * spinning up the full HTTP proxy.
 */
export function lookupPlaceholderMapping(
  placeholder: string,
  expectedOrganizationId?: string
): SecretMapping | null {
  const prefixIdx = placeholder.indexOf(PLACEHOLDER_PREFIX);
  if (prefixIdx === -1) return null;
  const uuid = placeholder.slice(prefixIdx + PLACEHOLDER_PREFIX.length);
  const mapping = placeholderCache.get(uuid);
  if (!mapping) return null;
  if (
    expectedOrganizationId !== undefined &&
    mapping.organizationId !== expectedOrganizationId
  ) {
    // Force the check whenever the caller supplied an expected org.
    // Pre-fix this also gated on `mapping.organizationId` being set,
    // which let a legacy mapping (minted before the org-id pivot) sail
    // through whenever the caller's URL named any org — a worker from
    // org B could resolve a legacy unscoped mapping owned by org A under
    // org B's request. Now: if the caller has an org expectation, the
    // mapping must match it, including refusing to match `undefined`.
    logger.warn(
      {
        mappingAgentId: mapping.agentId,
        mappingOrg: mapping.organizationId,
        expectedOrg: expectedOrganizationId,
      },
      "Placeholder mapping rejected: organization mismatch"
    );
    return null;
  }
  // Surface every legacy unscoped access so the deprecation can be
  // planned. A mapping with no `organizationId` is from before the pivot
  // and should disappear once all in-flight placeholders rotate.
  if (!mapping.organizationId) {
    logger.warn(
      {
        mappingAgentId: mapping.agentId,
        expectedOrg: expectedOrganizationId,
      },
      "Placeholder mapping accessed without organizationId — legacy row, schedule rotation"
    );
  }
  return mapping;
}

function safeDecodePathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface SecretMapping {
  agentId: string;
  /**
   * Owning organization of the agent the placeholder was minted for.
   * `lookupPlaceholderMapping()` rejects the lookup when the caller's
   * org doesn't match — defense-in-depth against a compromised worker
   * presenting another tenant's placeholder. Optional only because
   * older mappings minted before the org-id pivot can still be in
   * flight; production-minted mappings always set it.
   */
  organizationId?: string;
  envVarName: string;
  secretRef: SecretRef;
  deploymentName: string;
}

interface SecretProxyConfig {
  defaultUpstreamUrl: string;
  providerUpstreams?: ProviderUpstreamConfig[];
}

/**
 * Generic secret injection proxy.
 *
 * Workers receive random placeholder tokens instead of real secrets.
 * This proxy intercepts requests, swaps placeholders back to real values
 * in auth headers, and forwards to the upstream API.
 *
 * Zero provider-specific logic — works for any API that uses
 * X-Api-Key or Authorization: Bearer headers.
 */
export class SecretProxy {
  private app: Hono;
  private config: SecretProxyConfig;
  private slugMap: Map<string, string>;
  private slugToProviderId: Map<string, string> = new Map();
  private authProfilesManager?: AuthProfilesManager;
  private readonly secretStore: SecretStore;
  private systemKeyResolver?: (providerId: string) => string | undefined;
  private agentOrgResolver?: AgentOrgResolver;

  constructor(config: SecretProxyConfig, secretStore: SecretStore) {
    this.config = config;
    this.secretStore = secretStore;
    this.slugMap = new Map();
    for (const upstream of config.providerUpstreams ?? []) {
      this.slugMap.set(upstream.slug, upstream.upstreamBaseUrl);
      logger.debug(
        `Registered provider upstream: ${upstream.slug} -> ${upstream.upstreamBaseUrl}`
      );
    }
    this.app = new Hono();
    this.setupRoutes();
  }

  setAuthProfilesManager(manager: AuthProfilesManager): void {
    this.authProfilesManager = manager;
  }

  /**
   * Set a callback that resolves system-level API keys for a provider.
   * Used as fallback when no per-agent auth profile exists.
   */
  setSystemKeyResolver(
    resolver: (providerId: string) => string | undefined
  ): void {
    this.systemKeyResolver = resolver;
  }

  /**
   * Wire in a resolver that maps a URL-encoded agentId to its owning org
   * id. Used to compute the `expectedOrganizationId` we hand to
   * `lookupPlaceholderMapping` — without it the org-scoping guard has no
   * independent source of truth and can't enforce anything.
   */
  setAgentOrgResolver(resolver: AgentOrgResolver): void {
    this.agentOrgResolver = resolver;
  }

  /**
   * Register a provider upstream for slug-based routing.
   * Called after provider modules are initialized.
   */
  registerUpstream(
    upstream: ProviderUpstreamConfig,
    providerId?: string
  ): void {
    this.slugMap.set(upstream.slug, upstream.upstreamBaseUrl);
    if (providerId) {
      this.slugToProviderId.set(upstream.slug, providerId);
    }
    logger.debug(
      `Registered provider upstream: ${upstream.slug} -> ${upstream.upstreamBaseUrl}${providerId ? ` (providerId: ${providerId})` : ""}`
    );
  }

  getApp(): Hono {
    return this.app;
  }

  private setupRoutes(): void {
    this.app.get("/health", (c) =>
      c.json({
        service: "secret-proxy",
        status: "enabled",
        timestamp: new Date().toISOString(),
      })
    );

    this.app.all("/*", (c) => this.handleRequest(c));
  }

  private async handleRequest(c: Context): Promise<Response> {
    try {
      return await this.forward(c);
    } catch (error) {
      logger.error("Secret proxy error:", error);
      return c.json({ error: "Internal proxy error" }, 500);
    }
  }

  /**
   * Resolve a placeholder token to its real value via the in-memory cache.
   * Handles both plain (`lobu_secret_<uuid>`) and prefixed
   * (`sk-ant-oat01-lobu_secret_<uuid>`) placeholders.
   *
   * `expectedOrganizationId` is forwarded to {@link lookupPlaceholderMapping}
   * so a worker carrying another tenant's placeholder cannot resolve it
   * even on the legacy header-swap path.
   */
  private async resolveSecret(
    placeholder: string,
    expectedOrganizationId?: string
  ): Promise<string | null> {
    const mapping = this.lookupPlaceholderMapping(
      placeholder,
      expectedOrganizationId
    );
    if (!mapping) return null;
    return this.secretStore.get(mapping.secretRef);
  }

  /**
   * Look up just the SecretMapping (without resolving the secret value)
   * for a placeholder. Used to verify the calling worker's bound agentId
   * matches the agentId in the request URL.
   *
   * If `expectedOrganizationId` is supplied and the stored mapping is
   * tagged with a different org, treat it the same as a missing mapping —
   * log and return null. This is defense-in-depth on top of the existing
   * `mapping.agentId === urlAgentId` check: if a future code path
   * resolves placeholders under a different tenant's context (e.g.
   * cross-tenant header forwarding), the mismatch here blocks it.
   */
  private lookupPlaceholderMapping(
    placeholder: string,
    expectedOrganizationId?: string
  ): SecretMapping | null {
    return lookupPlaceholderMapping(placeholder, expectedOrganizationId);
  }

  /**
   * Extract the worker token from a dedicated `x-lobu-worker-token` header
   * (or query param of the same name — useful for SSE that can't set
   * headers), verify it, and return the bound `organizationId`. Falls back
   * to verifying the bearer credential when it isn't a placeholder.
   *
   * Returns `undefined` when no verifiable token is present — the caller
   * then relies on `agentOrgResolver` (DB lookup keyed by URL agentId) to
   * fill in the expected org.
   */
  private extractWorkerTokenOrg(c: Context): string | undefined {
    const header =
      c.req.header("x-lobu-worker-token") ||
      c.req.header("X-Lobu-Worker-Token");
    const candidate = header || c.req.query("worker_token") || undefined;
    if (candidate) {
      const data = verifyWorkerToken(candidate);
      if (data?.organizationId) return data.organizationId;
    }
    // The bearer credential is normally a `lobu_secret_<uuid>` placeholder
    // but legacy callers may pass the worker JWT directly. Verify if it
    // looks like one (long, no placeholder prefix).
    const auth = c.req.header("authorization");
    if (auth) {
      const parts = auth.split(" ");
      const tok =
        parts.length === 2 && parts[0]?.toLowerCase() === "bearer"
          ? parts[1]
          : null;
      if (tok && !tok.includes(PLACEHOLDER_PREFIX)) {
        const data = verifyWorkerToken(tok);
        if (data?.organizationId) return data.organizationId;
      }
    }
    return undefined;
  }

  /**
   * Extract the bearer/api-key value the caller used to authenticate.
   * Returns the raw token string, or null if no auth header is present.
   */
  private extractCallerToken(c: Context): string | null {
    const apiKey = c.req.header("x-api-key");
    if (apiKey) return apiKey;
    const auth = c.req.header("authorization");
    if (!auth) return null;
    const parts = auth.split(" ");
    if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
      return parts[1] ?? null;
    }
    return auth;
  }

  /**
   * If the value contains a UUID placeholder prefix, resolve the real secret.
   * Returns the value unchanged if it's not a recognized pattern.
   *
   * `source` identifies the caller (best available identity: bound agentId or
   * remote address) for per-source failed-resolution rate limiting.
   */
  private async swap(
    value: string,
    source: string,
    expectedOrganizationId?: string
  ): Promise<string> {
    if (value.includes(PLACEHOLDER_PREFIX)) {
      if (resolutionFailureLimiter.isThrottled(source)) {
        // Source has burned through its failure budget — hard-fail without
        // touching the cache or logging another line.
        return "";
      }
      const resolved = await this.resolveSecret(value, expectedOrganizationId);
      if (!resolved) {
        // Fail closed: forwarding the literal placeholder upstream would
        // surface it in the provider's error response (and thus in worker
        // logs / user-facing messages), giving an attacker a stable handle
        // to enumerate. An empty string fails the auth check upstream
        // without exposing the ref.
        const { shouldLog, nowThrottled } =
          resolutionFailureLimiter.recordFailure(source);
        if (shouldLog) {
          if (nowThrottled) {
            logger.warn(
              { source },
              "Throttling placeholder resolution for source after repeated failures"
            );
          } else {
            logger.warn({ source }, "Failed to resolve secret placeholder");
          }
        }
        return "";
      }
      resolutionFailureLimiter.recordSuccess(source);
      return resolved;
    }

    return value;
  }

  private async forward(c: Context): Promise<Response> {
    // Build upstream URL — strip the proxy mount prefix and resolve provider slug.
    // Handles the case where the gateway is mounted as a sub-app under a prefix
    // (e.g. /lobu/api/proxy/...) by stripping everything up to and including
    // /api/proxy rather than requiring it at the start.
    const url = new URL(c.req.url);
    const proxyIdx = url.pathname.indexOf("/api/proxy");
    const rawPath =
      proxyIdx >= 0
        ? url.pathname.slice(proxyIdx + "/api/proxy".length)
        : url.pathname;

    // Try slug-based routing: /api/proxy/{slug}/rest/of/path
    let upstreamBaseUrl = this.config.defaultUpstreamUrl;
    let forwardPath = rawPath;
    let resolvedSlug: string | undefined;
    let urlAgentId: string | undefined;
    let providerContext: ProviderCredentialContext | undefined;
    const slugMatch = rawPath.match(/^\/([^/]+)(\/.*)?$/);
    if (slugMatch) {
      const candidateSlug = slugMatch[1]!;
      const resolved = this.slugMap.get(candidateSlug);
      if (resolved) {
        upstreamBaseUrl = resolved;
        forwardPath = slugMatch[2] || "";
        resolvedSlug = candidateSlug;

        // Extract agentId from /a/{agentId} path segment if present.
        // URL format: /api/proxy/{slug}/a/{agentId}/v1/chat/completions
        const agentMatch = forwardPath.match(
          /^\/a\/([^/]+)(?:\/u\/([^/]+))?(\/.*)?$/
        );
        if (agentMatch) {
          urlAgentId = safeDecodePathSegment(agentMatch[1]);
          const userId = safeDecodePathSegment(agentMatch[2]);
          forwardPath = agentMatch[3] || "";
          providerContext = userId ? { userId } : undefined;
        }
      }
    }

    const upstream = `${upstreamBaseUrl}${forwardPath}${url.search}`;

    // Copy request body for non-GET/HEAD
    const method = c.req.method;
    let body: string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      body = await c.req.text();
    }

    // Derive the caller's expected org from the verified worker token
    // (preferred — it's signed) and fall back to a DB lookup keyed by the
    // URL agentId. Either source becomes the `expectedOrganizationId`
    // we hand to placeholder + secret lookups so a worker bearing org A's
    // placeholder cannot resolve it under org B's URL.
    const callerToken = this.extractCallerToken(c);
    let expectedOrganizationId: string | undefined =
      this.extractWorkerTokenOrg(c);
    if (!expectedOrganizationId && urlAgentId && this.agentOrgResolver) {
      try {
        const orgId = await this.agentOrgResolver(urlAgentId);
        if (orgId) expectedOrganizationId = orgId;
      } catch (err) {
        // Fail closed. Falling through with `expectedOrganizationId =
        // undefined` on a transient DB error downgrades the placeholder /
        // secret-lookup org checks for the entire request — a window where
        // a worker bound to org A could resolve a placeholder pointed at
        // org B's URL because the binding step lost its expected-org
        // anchor. The isolation invariant matters more than the brief
        // 503 window during a DB hiccup.
        logger.error(
          { urlAgentId, err: String(err) },
          "agentOrgResolver failed — rejecting request to preserve org isolation"
        );
        return c.json(
          { error: "Service Unavailable: failed to resolve agent organization" },
          503
        );
      }
    }

    // Bind the calling worker (identified by its placeholder credential) to
    // the agentId in the URL. Without this, anyone with network access to the
    // gateway could harvest another agent's credentials by changing the URL
    // segment. We accept that legacy callers without a placeholder are not
    // bound (logged as a warning) but reject any request whose placeholder
    // resolves to a different agent than the URL claims.
    if (urlAgentId) {
      if (callerToken?.includes(PLACEHOLDER_PREFIX)) {
        const mapping = this.lookupPlaceholderMapping(
          callerToken,
          expectedOrganizationId
        );
        if (!mapping) {
          logger.warn(
            { urlAgentId },
            "Rejecting proxy request: placeholder did not resolve"
          );
          return c.json({ error: "Unauthorized" }, 401);
        }
        if (mapping.agentId !== urlAgentId) {
          logger.warn(
            { urlAgentId, mappingAgentId: mapping.agentId },
            "Rejecting proxy request: placeholder agentId does not match URL"
          );
          return c.json({ error: "Forbidden" }, 403);
        }
      } else if (callerToken) {
        logger.debug(
          { urlAgentId },
          "Proxy request authenticated by non-placeholder token; agentId binding skipped"
        );
      } else {
        // No auth header at all but the URL names an agent — refuse rather than
        // forward upstream using that agent's credential. An unauthenticated
        // caller must never be able to spend another agent's provider quota.
        logger.warn(
          { urlAgentId },
          "Rejecting proxy request: names an agent but carries no auth header"
        );
        return c.json({ error: "Unauthorized" }, 401);
      }
    }

    // Build headers, swapping placeholder secrets in auth headers
    const headers: Record<string, string> = {};

    // Forward all original headers (except host/connection and inbound auth).
    // We always set our own Authorization below, so the caller's Authorization
    // (which carries an opaque placeholder) must never reach the upstream.
    const skip = new Set([
      "host",
      "connection",
      "transfer-encoding",
      "authorization",
      "x-api-key",
    ]);
    for (const [key, val] of Object.entries(c.req.header())) {
      if (val && !skip.has(key.toLowerCase())) {
        headers[key] = val;
      }
    }

    // Resolve credentials: prefer URL-based agentId (no header parsing needed),
    // fall back to marker/placeholder swap for backward compatibility.
    if (urlAgentId && resolvedSlug && this.authProfilesManager) {
      const providerId = this.slugToProviderId.get(resolvedSlug);
      if (providerId) {
        // Run the credential lookup under the caller's expected org context
        // when we have one. Without this wrapper, `AuthProfilesManager`
        // calls its OWN `agentOrgResolver` to derive the org — and on a
        // transient DB error that resolver logs a warning and returns
        // undefined, then falls through to unscoped credential reads
        // (`auth-profiles-manager.ts:251-275`). Wrapping here makes the
        // org explicit so the resolver short-circuits and a DB hiccup
        // cannot downgrade scoping for a request whose org we already
        // know from the worker token / URL.
        const runWithOrg = <T>(fn: () => Promise<T>): Promise<T> =>
          expectedOrganizationId
            ? orgContext.run({ organizationId: expectedOrganizationId }, fn)
            : fn();
        const authProfilesManager = this.authProfilesManager;
        const profile = await runWithOrg(() =>
          authProfilesManager.getBestProfile(
            urlAgentId,
            providerId,
            undefined,
            providerContext
          )
        );
        const userIdForRefresh = providerContext?.userId;
        const credential = profile && userIdForRefresh
          ? await runWithOrg(() =>
              authProfilesManager.ensureFreshCredential(profile, {
                userId: userIdForRefresh,
                agentId: urlAgentId,
              })
            )
          : profile?.credential;
        if (credential) {
          headers.authorization = `Bearer ${credential}`;
        } else if (this.systemKeyResolver) {
          const systemKey = this.systemKeyResolver(providerId);
          if (systemKey) {
            headers.authorization = `Bearer ${systemKey}`;
          } else {
            logger.warn(
              `No auth profile or system key for agent ${urlAgentId}, provider ${providerId}`
            );
            return c.json(
              {
                error: {
                  message:
                    "No provider credentials configured. End-user provider setup is not available in chat yet. Ask an admin to connect a provider for the base agent.",
                  type: "authentication_error",
                  code: "no_credentials",
                },
              },
              401
            );
          }
        } else {
          logger.warn(
            `No auth profile for agent ${urlAgentId}, provider ${providerId}`
          );
          return c.json(
            {
              error: {
                message:
                  "No provider credentials configured. End-user provider setup is not available in chat yet. Ask an admin to connect a provider for the base agent.",
                type: "authentication_error",
                code: "no_credentials",
              },
            },
            401
          );
        }
      } else {
        logger.warn(`No providerId mapping for slug "${resolvedSlug}"`);
      }
    } else {
      // Legacy path: swap UUID placeholders in auth headers (non-provider secrets).
      // Read the originals from the request because we strip them from the
      // forwarded headers map above.
      const source =
        urlAgentId ??
        getClientIp({
          forwardedFor: c.req.header("x-forwarded-for"),
          realIp: c.req.header("x-real-ip"),
        });
      const apiKey = c.req.header("x-api-key");
      if (apiKey) {
        headers["x-api-key"] = await this.swap(
          apiKey,
          source,
          expectedOrganizationId
        );
      }

      const auth = c.req.header("authorization");
      if (auth) {
        const parts = auth.split(" ");
        if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
          const swapped = await this.swap(
            parts[1]!,
            source,
            expectedOrganizationId
          );
          headers.authorization = `Bearer ${swapped}`;
        }
      }
    }

    logger.info(`Forwarding to upstream: ${method} ${upstream}`);

    const response = await fetch(upstream, { method, headers, body });

    if (!response.ok) {
      // Log upstream failure without echoing the body — error responses from
      // some providers include the (rejected) credential or other sensitive
      // values that we don't want in our logs.
      logger.warn(
        `Upstream returned ${response.status} for ${method} ${upstream}`
      );
    }

    // Build response headers (skip hop-by-hop)
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (
        ![
          "transfer-encoding",
          "connection",
          "upgrade",
          "content-encoding",
        ].includes(key.toLowerCase())
      ) {
        responseHeaders.set(key, value);
      }
    });

    // Stream SSE / chunked responses directly
    if (
      response.headers.get("content-type")?.includes("text/event-stream") ||
      response.headers.get("transfer-encoding") === "chunked"
    ) {
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");
      if (response.body) {
        return new Response(response.body as ReadableStream, {
          status: response.status,
          headers: responseHeaders,
        });
      }
      return c.json({ error: "No response body from upstream" }, 502);
    }

    // Regular response pass-through
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: responseHeaders,
    });
  }
}

// ============================================================================
// Utility: store / delete placeholder mappings (in-memory, per-process)
// ============================================================================

/**
 * Store a secret placeholder mapping in the in-process cache.
 * Called by the deployment manager when generating env vars.
 */
export function storeSecretMapping(
  uuid: string,
  mapping: SecretMapping,
  ttlSeconds: number = defaultPlaceholderTtlSeconds()
): void {
  placeholderCache.set(uuid, mapping, ttlSeconds);
}

/**
 * Delete all secret placeholder mappings for a given deployment.
 * Called during deployment teardown.
 */
export function deleteSecretMappings(deploymentName: string): number {
  return placeholderCache.deleteByDeployment(deploymentName);
}

/**
 * Generate a UUID placeholder token and store its mapping.
 * Returns the placeholder string to pass to the worker.
 * Used for non-provider secrets (custom env vars with _KEY/_TOKEN/_SECRET patterns).
 */
export function generatePlaceholder(
  agentId: string,
  envVarName: string,
  secretRef: SecretRef,
  deploymentName: string,
  options?: { ttlSeconds?: number; organizationId?: string }
): string {
  const uuid = crypto.randomUUID();
  storeSecretMapping(
    uuid,
    {
      agentId,
      envVarName,
      secretRef,
      deploymentName,
      organizationId: options?.organizationId,
    },
    options?.ttlSeconds
  );
  return `${PLACEHOLDER_PREFIX}${uuid}`;
}

/** Test-only: drop every placeholder and reset the failure limiter. */
export function __resetPlaceholderCacheForTests(): void {
  (placeholderCache as unknown as { entries: Map<string, unknown> }).entries.clear();
  resolutionFailureLimiter.reset();
}
