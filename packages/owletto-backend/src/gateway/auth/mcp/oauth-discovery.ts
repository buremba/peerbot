/**
 * MCP OAuth 2.1 auto-discovery (RFC 9728 + RFC 8414 + RFC 7591).
 *
 * When an upstream MCP server returns HTTP 401 with a `WWW-Authenticate: Bearer
 * resource_metadata="..."` header, the gateway walks the metadata chain to
 * discover authorization/token endpoints and (if needed) dynamically registers
 * a client. Results are cached per `mcpId` so repeated 401s don't re-run the
 * probes on every tool call.
 *
 * All outbound fetches pass through `isInternalUrl` SSRF guards — advertised
 * resource_metadata / issuer URLs are untrusted.
 */

import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import { createLogger } from "@lobu/core";
import type { WritableSecretStore } from "../../secrets/index.js";

const logger = createLogger("mcp-oauth-discovery");

const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // 24 hours
const DISCOVERY_FETCH_TIMEOUT_MS = 5000;

export interface DiscoveredOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  issuer: string;
  /** RFC 8707 resource indicator — the canonical URL of the protected resource. */
  resource?: string;
}

export interface DiscoveredClient {
  clientId: string;
  clientSecret?: string;
  /** `none` for public/PKCE clients. */
  tokenEndpointAuthMethod?: string;
}

interface DiscoveryResult {
  endpoints: DiscoveredOAuthEndpoints;
  client: DiscoveredClient;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  grant_types_supported?: string[];
}

/**
 * Parse the `resource_metadata` URL from a `WWW-Authenticate: Bearer ...` header.
 * Tolerates quoted/unquoted values and multiple `Bearer` challenges.
 *
 * When multiple `resource_metadata` parameters are present (Sentry, for example,
 * emits both a generic and an MCP-specific one), the LAST value is returned —
 * servers list refinements after the generic default per RFC 9728 guidance.
 */
function parseResourceMetadataFromWwwAuth(
  header: string | null
): string | null {
  if (!header) return null;
  const matches = [...header.matchAll(/resource_metadata="?([^",\s]+)"?/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1]?.[1] ?? null;
}

function isReservedIp(ip: string): boolean {
  if (ip === "::1") return true;
  if (/^f[cd]/i.test(ip)) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length === 4) {
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

async function assertPublicUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  if (isReservedIp(host)) {
    throw new Error(`URL resolves to a blocked internal host: ${host}`);
  }
  const ipv4 = await dns.resolve4(host).catch(() => [] as string[]);
  const ipv6 = await dns.resolve6(host).catch(() => [] as string[]);
  for (const ip of [...ipv4, ...ipv6]) {
    if (isReservedIp(ip)) {
      throw new Error(
        `URL resolves to a blocked internal host: ${host} (${ip})`
      );
    }
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    DISCOVERY_FETCH_TIMEOUT_MS
  );
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET ${url} returned ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch RFC 9728 Protected Resource Metadata.
 */
async function fetchProtectedResourceMetadata(
  url: string
): Promise<ProtectedResourceMetadata> {
  logger.debug("Fetching protected resource metadata", { url });
  return fetchJson<ProtectedResourceMetadata>(url);
}

/**
 * Fetch RFC 8414 Authorization Server Metadata.
 * Tries the `/.well-known/oauth-authorization-server` path and falls back to
 * `/.well-known/openid-configuration` for providers that only advertise OIDC.
 */
async function fetchAuthorizationServerMetadata(
  issuer: string
): Promise<AuthServerMetadata> {
  const base = issuer.replace(/\/+$/, "");
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const metadata = await fetchJson<AuthServerMetadata>(candidate);
      if (metadata?.authorization_endpoint && metadata?.token_endpoint) {
        logger.debug("Fetched authorization server metadata", {
          url: candidate,
          issuer: metadata.issuer,
        });
        return metadata;
      }
    } catch (error) {
      lastError = error;
      logger.debug("Authorization server metadata probe failed", {
        url: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(
    `Unable to fetch authorization server metadata from ${issuer}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/**
 * Dynamically register a public PKCE client with the authorization server
 * (RFC 7591). Returns the assigned client_id and (rarely) client_secret.
 */
async function dynamicClientRegistration(
  registrationEndpoint: string,
  clientName: string,
  redirectUri: string,
  scope: string | undefined
): Promise<DiscoveredClient> {
  await assertPublicUrl(registrationEndpoint);
  const body: Record<string, unknown> = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
  if (scope) body.scope = scope;

  const response = await fetch(registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Dynamic client registration failed: ${response.status} ${text}`
    );
  }
  const data = (await response.json()) as {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
  };
  if (!data.client_id) {
    throw new Error("Dynamic client registration returned no client_id");
  }
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret,
    tokenEndpointAuthMethod: data.token_endpoint_auth_method ?? "none",
  };
}

/**
 * Scope cache keys by `(agentId, mcpId, upstreamUrl)` so that re-pointing an
 * agent at a different upstream (or swapping an MCP id across agents) cannot
 * serve a stale discovery or DCR record from a previous binding.
 */
function scopeTag(agentId: string, upstreamUrl: string): string {
  const hash = createHash("sha256")
    .update(`${agentId}\u0000${upstreamUrl}`)
    .digest("base64url")
    .slice(0, 16);
  return hash;
}

function discoveryCacheName(
  mcpId: string,
  agentId: string,
  upstreamUrl: string
): string {
  return `mcp-oauth/${mcpId}/${scopeTag(agentId, upstreamUrl)}/discovery`;
}

function clientCacheName(
  mcpId: string,
  agentId: string,
  upstreamUrl: string
): string {
  return `mcp-oauth/clients/${mcpId}/${scopeTag(agentId, upstreamUrl)}/registration`;
}

/**
 * Pick the token endpoint auth method for a static client with a secret based
 * on what the authorization server advertises. Defaults to `client_secret_basic`
 * per RFC 6749 §2.3.1 when nothing is advertised.
 */
function pickStaticAuthMethod(
  supported: string[] | undefined,
  hasSecret: boolean
): string {
  if (!hasSecret) return "none";
  if (supported?.includes("client_secret_basic")) return "client_secret_basic";
  if (supported?.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

async function readSecretJson<T>(
  secretStore: WritableSecretStore,
  name: string
): Promise<T | null> {
  const ref = `secret://${encodeURIComponent(name)}` as const;
  const value = await secretStore.get(ref as any);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

async function writeSecretJson<T>(
  secretStore: WritableSecretStore,
  name: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  await secretStore.put(name, JSON.stringify(value), { ttlSeconds });
}

interface DiscoverOptions {
  mcpId: string;
  /** Agent that owns this MCP binding — used for cache scoping. */
  agentId: string;
  upstreamUrl: string;
  wwwAuthenticate: string | null;
  redirectUri: string;
  secretStore: WritableSecretStore;
  /**
   * Pre-registered static client from lobu.toml. Short-circuits dynamic
   * registration when present.
   */
  staticClientId?: string;
  staticClientSecret?: string;
  /** Requested scopes (space-separated or array). */
  requestedScopes?: string[];
}

/**
 * Resolve OAuth endpoints + client for an MCP server.
 *
 * Uses an in-memory cache so we don't re-run the discovery chain on every
 * 401. The cache is invalidated by deleting the credential (logout).
 */
export async function discoverOAuth(
  options: DiscoverOptions
): Promise<DiscoveryResult> {
  const {
    mcpId,
    agentId,
    upstreamUrl,
    wwwAuthenticate,
    redirectUri,
    secretStore,
    staticClientId,
    staticClientSecret,
    requestedScopes,
  } = options;

  const cacheName = discoveryCacheName(mcpId, agentId, upstreamUrl);
  const cached = await readSecretJson<DiscoveryResult>(secretStore, cacheName);
  if (cached) {
    logger.debug("Using cached OAuth discovery", { mcpId, agentId });
    // Override the client if the operator has set an explicit one.
    if (staticClientId) {
      cached.client = {
        clientId: staticClientId,
        clientSecret: staticClientSecret,
        tokenEndpointAuthMethod: pickStaticAuthMethod(
          cached.endpoints.tokenEndpointAuthMethodsSupported,
          !!staticClientSecret
        ),
      };
    }
    return cached;
  }

  // Resolve the protected-resource-metadata URL. If the server advertised it
  // in WWW-Authenticate, use that. Otherwise try the well-known fallback.
  let prmUrl = parseResourceMetadataFromWwwAuth(wwwAuthenticate);
  if (!prmUrl) {
    try {
      const origin = new URL(upstreamUrl).origin;
      prmUrl = `${origin}/.well-known/oauth-protected-resource`;
    } catch {
      throw new Error(`Cannot derive PRM URL from ${upstreamUrl}`);
    }
  }

  const prm = await fetchProtectedResourceMetadata(prmUrl);
  const authServerIssuer = prm.authorization_servers?.[0];
  if (!authServerIssuer) {
    throw new Error(
      `Protected resource metadata at ${prmUrl} lists no authorization_servers`
    );
  }

  const asm = await fetchAuthorizationServerMetadata(authServerIssuer);
  if (!asm.authorization_endpoint || !asm.token_endpoint) {
    throw new Error(
      `Authorization server ${authServerIssuer} missing required endpoints`
    );
  }

  const scopes = requestedScopes?.length
    ? requestedScopes
    : (prm.scopes_supported ?? asm.scopes_supported);

  const endpoints: DiscoveredOAuthEndpoints = {
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    scopesSupported: scopes,
    codeChallengeMethodsSupported: asm.code_challenge_methods_supported,
    tokenEndpointAuthMethodsSupported:
      asm.token_endpoint_auth_methods_supported,
    issuer: asm.issuer ?? authServerIssuer,
    resource: prm.resource,
  };

  // Resolve client: operator-provided → cached DCR → fresh DCR.
  let client: DiscoveredClient;
  if (staticClientId) {
    client = {
      clientId: staticClientId,
      clientSecret: staticClientSecret,
      tokenEndpointAuthMethod: pickStaticAuthMethod(
        endpoints.tokenEndpointAuthMethodsSupported,
        !!staticClientSecret
      ),
    };
  } else {
    const cachedClient = await readSecretJson<DiscoveredClient>(
      secretStore,
      clientCacheName(mcpId, agentId, upstreamUrl)
    );
    if (cachedClient) {
      client = cachedClient;
    } else {
      if (!endpoints.registrationEndpoint) {
        throw new Error(
          `Authorization server ${endpoints.issuer} has no registration_endpoint and no static client_id configured for MCP '${mcpId}'`
        );
      }
      client = await dynamicClientRegistration(
        endpoints.registrationEndpoint,
        `Lobu Gateway (${mcpId})`,
        redirectUri,
        scopes?.join(" ")
      );
      await writeSecretJson(
        secretStore,
        clientCacheName(mcpId, agentId, upstreamUrl),
        client
      );
      logger.info("Registered new OAuth client via DCR", {
        mcpId,
        agentId,
        clientId: client.clientId,
      });
    }
  }

  const result: DiscoveryResult = { endpoints, client };
  await writeSecretJson(secretStore, cacheName, result, DISCOVERY_CACHE_TTL);

  logger.info("OAuth discovery complete", {
    mcpId,
    issuer: endpoints.issuer,
    hasRegistrationEndpoint: !!endpoints.registrationEndpoint,
    clientId: client.clientId,
  });

  return result;
}
