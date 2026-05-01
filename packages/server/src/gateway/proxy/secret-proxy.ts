import { createLogger, type SecretRef } from "@lobu/core";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthProfilesManager } from "../auth/settings/auth-profiles-manager.js";
import type { ProviderCredentialContext } from "../embedded.js";
import type { ProviderUpstreamConfig } from "../modules/module-system.js";
import type { SecretStore } from "../secrets/index.js";

const logger = createLogger("secret-proxy");

const PLACEHOLDER_PREFIX = "lobu_secret_";

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
   */
  private async resolveSecret(placeholder: string): Promise<string | null> {
    const mapping = this.lookupPlaceholderMapping(placeholder);
    if (!mapping) return null;
    return this.secretStore.get(mapping.secretRef);
  }

  /**
   * Look up just the SecretMapping (without resolving the secret value)
   * for a placeholder. Used to verify the calling worker's bound agentId
   * matches the agentId in the request URL.
   */
  private lookupPlaceholderMapping(placeholder: string): SecretMapping | null {
    const prefixIdx = placeholder.indexOf(PLACEHOLDER_PREFIX);
    if (prefixIdx === -1) return null;
    const uuid = placeholder.slice(prefixIdx + PLACEHOLDER_PREFIX.length);
    return placeholderCache.get(uuid);
  }

  /**
   * Extract the bearer/api-key value the caller used to authenticate.
   * Returns the raw token string, or null if no auth header is present.
   */
  private extractCallerToken(c: Context): string | null {
    const apiKey = c.req.header("x-api-key");
    if (apiKey) return apiKey;
    const auth = c.req.header("authorization") || c.req.header("Authorization");
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
   */
  private async swap(value: string): Promise<string> {
    if (value.includes(PLACEHOLDER_PREFIX)) {
      const resolved = await this.resolveSecret(value);
      if (!resolved) {
        logger.warn("Failed to resolve secret placeholder");
        return value;
      }
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

    // Bind the calling worker (identified by its placeholder credential) to
    // the agentId in the URL. Without this, anyone with network access to the
    // gateway could harvest another agent's credentials by changing the URL
    // segment. We accept that legacy callers without a placeholder are not
    // bound (logged as a warning) but reject any request whose placeholder
    // resolves to a different agent than the URL claims.
    if (urlAgentId) {
      const callerToken = this.extractCallerToken(c);
      if (callerToken?.includes(PLACEHOLDER_PREFIX)) {
        const mapping = this.lookupPlaceholderMapping(callerToken);
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
        logger.warn(
          { urlAgentId },
          "Proxy request has no auth header — agentId binding cannot be verified"
        );
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
        const profile = await this.authProfilesManager.getBestProfile(
          urlAgentId,
          providerId,
          undefined,
          providerContext
        );
        const userIdForRefresh = providerContext?.userId;
        const credential = profile && userIdForRefresh
          ? await this.authProfilesManager.ensureFreshCredential(profile, {
              userId: userIdForRefresh,
              agentId: urlAgentId,
            })
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
      const apiKey = c.req.header("x-api-key");
      if (apiKey) {
        headers["x-api-key"] = await this.swap(apiKey);
      }

      const auth =
        c.req.header("authorization") || c.req.header("Authorization");
      if (auth) {
        const parts = auth.split(" ");
        if (parts.length === 2 && parts[0]?.toLowerCase() === "bearer") {
          const swapped = await this.swap(parts[1]!);
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
  ttlSeconds: number = 7 * 24 * 60 * 60 // 7 days default
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
  ttlSeconds?: number
): string {
  const uuid = crypto.randomUUID();
  storeSecretMapping(
    uuid,
    { agentId, envVarName, secretRef, deploymentName },
    ttlSeconds
  );
  return `${PLACEHOLDER_PREFIX}${uuid}`;
}

/** Test-only: drop every placeholder. */
export function __resetPlaceholderCacheForTests(): void {
  (placeholderCache as unknown as { entries: Map<string, unknown> }).entries.clear();
}
