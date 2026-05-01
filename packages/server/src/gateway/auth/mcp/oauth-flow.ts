/**
 * MCP OAuth authorization-code + PKCE flow (RFC 6749 + RFC 7636).
 *
 * Ties together:
 *   - `oauth-discovery` for endpoint/client resolution,
 *   - `OAuthStateStore` for CSRF-protected, one-time PKCE state,
 *   - `storeCredentialForScope` from `device-auth.ts` for credential persistence.
 *
 * The state entry has a 5-minute TTL (enforced by OAuthStateStore). The
 * consume() is atomic, so replay of the same `state` fails.
 */

import { createHash, randomBytes } from "node:crypto";
import { createLogger, type McpOAuthConfig } from "@lobu/core";
import {
  OAuthStateStore,
  type ProviderOAuthStateData,
} from "../oauth/state-store.js";
import { storeCredentialForScope } from "../../routes/internal/device-auth.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import {
  discoverOAuth,
  type DiscoveredOAuthEndpoints,
  type DiscoveredClient,
} from "./oauth-discovery.js";

const logger = createLogger("mcp-oauth-flow");

const STATE_KEY_PREFIX = "mcp-oauth:state";

/**
 * Persisted state associated with a pending OAuth authorization-code flow.
 * Bound to `state` (CSRF) and loaded by the callback handler to exchange the
 * returned `code` for tokens.
 */
interface McpOAuthStateData extends ProviderOAuthStateData {
  mcpId: string;
  /** Opaque credential-scope key — `userId` for per-user, `channel-<id>` for channel scope. */
  scopeKey: string;
  /** Endpoints resolved at discovery time. */
  endpoints: DiscoveredOAuthEndpoints;
  /** Client registered (or configured) at discovery time. */
  client: DiscoveredClient;
  /** Space-separated scope string actually requested. */
  scope?: string;
  /** RFC 8707 resource indicator. */
  resource?: string;
  /** Chat context so the callback success page can deep-link back, and for auditing. */
  platform: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  connectionId?: string;
}

function getStateStore(): OAuthStateStore<McpOAuthStateData> {
  return new OAuthStateStore<McpOAuthStateData>(
    STATE_KEY_PREFIX,
    "mcp-oauth-state"
  );
}

function generateCodeVerifier(): string {
  // 32 random bytes → 43 base64url chars (RFC 7636 minimum).
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface StartFlowOptions {
  secretStore: WritableSecretStore;
  mcpId: string;
  upstreamUrl: string;
  agentId: string;
  userId: string;
  scopeKey: string;
  wwwAuthenticate: string | null;
  /** Absolute callback URL — `{publicGatewayUrl}/mcp/oauth/callback`. */
  redirectUri: string;
  staticOauth?: McpOAuthConfig;
  platform: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  connectionId?: string;
}

interface StartFlowResult {
  authorizationUrl: string;
  state: string;
}

/**
 * Begin a new PKCE auth-code flow. Returns the user-facing authorization URL
 * that the gateway will present via Slack link button. The callback handler
 * resumes from the `state` parameter.
 */
export async function startAuthCodeFlow(
  options: StartFlowOptions
): Promise<StartFlowResult> {
  const {
    secretStore,
    mcpId,
    upstreamUrl,
    agentId,
    userId,
    scopeKey,
    wwwAuthenticate,
    redirectUri,
    staticOauth,
    platform,
    channelId,
    conversationId,
    teamId,
    connectionId,
  } = options;

  const discovery = await discoverOAuth({
    mcpId,
    agentId,
    upstreamUrl,
    wwwAuthenticate,
    redirectUri,
    secretStore,
    staticClientId: staticOauth?.clientId,
    staticClientSecret: staticOauth?.clientSecret,
    requestedScopes: staticOauth?.scopes,
  });

  const { endpoints, client } = discovery;

  // Prefer operator-configured scopes; fall back to advertised ones.
  const scopes =
    staticOauth?.scopes && staticOauth.scopes.length > 0
      ? staticOauth.scopes
      : endpoints.scopesSupported;
  const scopeString = scopes?.length ? scopes.join(" ") : undefined;

  // RFC 8707 resource indicator — MCP servers like Sentry require this.
  const resource = staticOauth?.resource ?? endpoints.resource ?? upstreamUrl;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const stateStore = getStateStore();
  const state = await stateStore.create({
    userId,
    agentId,
    codeVerifier,
    mcpId,
    scopeKey,
    endpoints,
    client,
    scope: scopeString,
    resource,
    platform,
    channelId,
    conversationId,
    teamId,
    connectionId,
  });

  const authUrl = new URL(endpoints.authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", client.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  if (scopeString) {
    authUrl.searchParams.set("scope", scopeString);
  }
  if (resource) {
    authUrl.searchParams.set("resource", resource);
  }

  logger.info("Started MCP OAuth auth-code flow", {
    mcpId,
    agentId,
    scopeKey,
    clientId: client.clientId,
    hasResource: !!resource,
  });

  return {
    authorizationUrl: authUrl.toString(),
    state,
  };
}

interface CompleteFlowOptions {
  secretStore: WritableSecretStore;
  state: string;
  code: string;
  redirectUri: string;
}

interface CompleteFlowResult {
  mcpId: string;
  agentId: string;
  userId: string;
  scopeKey: string;
  platform: string;
  channelId: string;
  conversationId: string;
  teamId?: string;
  connectionId?: string;
  /** Space-separated scopes actually granted (provider-reported) or requested. */
  scope?: string;
}

/**
 * Exchange the callback `code` for tokens using the stored PKCE verifier,
 * persist the credential scoped to `(agentId, scopeKey, mcpId)`, and return
 * the context fields the callback page needs to render a success message.
 */
export async function completeAuthCodeFlow(
  options: CompleteFlowOptions
): Promise<CompleteFlowResult> {
  const { secretStore, state, code, redirectUri } = options;

  const stateStore = getStateStore();
  const stateData = await stateStore.consume(state);
  if (!stateData) {
    throw new Error("Invalid or expired OAuth state");
  }

  const {
    mcpId,
    agentId,
    userId,
    scopeKey,
    endpoints,
    client,
    codeVerifier,
    scope,
    resource,
    platform,
    channelId,
    conversationId,
    teamId,
    connectionId,
  } = stateData;

  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: client.clientId,
  };
  if (resource) {
    body.resource = resource;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // RFC 6749 §2.3.1 — `client_secret_basic` is the default. Only fall back to
  // `_post` when the AS advertises it explicitly (and we have a secret). A
  // public PKCE client ("none") sends no secret at all.
  if (client.clientSecret && client.tokenEndpointAuthMethod !== "none") {
    if (client.tokenEndpointAuthMethod === "client_secret_post") {
      body.client_secret = client.clientSecret;
    } else {
      const basic = Buffer.from(
        `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`
      ).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }
  }

  const response = await fetch(endpoints.tokenEndpoint, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error("Token exchange failed", {
      mcpId,
      status: response.status,
      body: text.slice(0, 500),
    });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const tokenData = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    throw new Error("Token exchange response missing access_token");
  }

  const expiresAt =
    typeof tokenData.expires_in === "number"
      ? Date.now() + tokenData.expires_in * 1000
      : Date.now() + 3_600_000; // default 1h if not reported

  await storeCredentialForScope(secretStore, agentId, scopeKey, mcpId, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenUrl: endpoints.tokenEndpoint,
    resource,
    tokenEndpointAuthMethod:
      client.tokenEndpointAuthMethod === "client_secret_basic" ||
      client.tokenEndpointAuthMethod === "client_secret_post" ||
      client.tokenEndpointAuthMethod === "none"
        ? client.tokenEndpointAuthMethod
        : undefined,
  });

  logger.info("MCP OAuth auth-code flow completed", {
    mcpId,
    agentId,
    scopeKey,
    scope: scope ?? tokenData.scope,
  });

  return {
    mcpId,
    agentId,
    userId,
    scopeKey,
    platform,
    channelId,
    conversationId,
    teamId,
    connectionId,
    scope: tokenData.scope ?? scope,
  };
}
