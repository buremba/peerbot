import { createLogger, type McpOAuthConfig } from "@lobu/core";
import { Hono } from "hono";
import { GenericDeviceCodeClient } from "../../auth/external/device-code-client.js";
import type { McpConfigService } from "../../auth/mcp/config-service.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";

const logger = createLogger("device-auth");

const DEFAULT_MCP_SCOPE = "mcp:read mcp:write profile:read";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  /** RFC 8707 resource indicator, included in refresh requests. */
  resource?: string;
  /**
   * How to authenticate to the token endpoint on refresh.
   * - `none` — public PKCE client, send no secret.
   * - `client_secret_basic` — send secret via HTTP Basic header (RFC 6749 §2.3.1 default).
   * - `client_secret_post` — send secret in form body.
   *
   * Omitted → legacy device-code behavior (secret in body, JSON content-type).
   */
  tokenEndpointAuthMethod?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post";
}

interface StoredDeviceAuth {
  deviceCode: string;
  userCode?: string;
  clientId: string;
  clientSecret?: string;
  interval: number;
  expiresAt: number;
  tokenUrl: string;
  issuer: string;
  /** Stored so poll/complete can reconstruct the client without re-deriving. */
  deviceAuthorizationUrl?: string;
  /** RFC 8707 resource indicator. */
  resource?: string;
  /** Custom scopes from oauth config. */
  scope?: string;
}

interface StoredClient {
  clientId: string;
  clientSecret?: string;
}

interface DeviceAuthConfig {
  mcpConfigService: McpConfigService;
  secretStore: WritableSecretStore;
}

interface ResolvedOAuthEndpoints {
  registrationUrl: string;
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  verificationUri: string;
  scope: string;
  clientId?: string;
  clientSecret?: string;
  resource?: string;
}

/** Read a JSON payload directly from the secret store. */
async function getSecretJson<T>(
  secretStore: WritableSecretStore,
  name: string,
  context: Record<string, unknown>
): Promise<T | null> {
  // The secret store's `get` accepts a SecretRef; we always store under the
  // default `secret://` scheme so the ref form is mechanical.
  const ref = `secret://${encodeURIComponent(name)}` as const;
  const value = await secretStore.get(ref as any);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    logger.warn("Failed to parse JSON payload from secret store", {
      name,
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function putSecretJson<T>(
  secretStore: WritableSecretStore,
  name: string,
  value: T,
  ttlSeconds?: number
): Promise<void> {
  await secretStore.put(name, JSON.stringify(value), { ttlSeconds });
}

async function deleteSecretJson(
  secretStore: WritableSecretStore,
  name: string,
  _context: Record<string, unknown>
): Promise<boolean> {
  // delete() is idempotent for the underlying store; we don't know if a row
  // existed before, but for cleanup that doesn't matter.
  try {
    await secretStore.delete(name);
    return true;
  } catch {
    return false;
  }
}

function credentialName(
  agentId: string,
  userId: string,
  mcpId: string
): string {
  return `mcp-auth/${agentId}/${userId}/${mcpId}/credential`;
}

function deviceAuthName(
  agentId: string,
  userId: string,
  mcpId: string
): string {
  return `mcp-auth/${agentId}/${userId}/${mcpId}/device-auth`;
}

function clientCacheName(mcpId: string): string {
  return `mcp-auth/clients/${mcpId}/registration`;
}

/**
 * Per-process refresh lock. Single-process gateway, so an in-memory mutex
 * is sufficient. Lock entries expire after 30s as a safety net for handlers
 * that throw without releasing.
 */
const refreshLocks = new Map<string, number>();
const REFRESH_LOCK_TTL_MS = 30_000;

function tryAcquireRefreshLock(
  agentId: string,
  userId: string,
  mcpId: string
): boolean {
  const key = `${agentId}:${userId}:${mcpId}`;
  const expiresAt = refreshLocks.get(key);
  if (expiresAt && expiresAt > Date.now()) return false;
  refreshLocks.set(key, Date.now() + REFRESH_LOCK_TTL_MS);
  return true;
}

function releaseRefreshLock(
  agentId: string,
  userId: string,
  mcpId: string
): void {
  refreshLocks.delete(`${agentId}:${userId}:${mcpId}`);
}

function deriveOAuthBaseUrl(upstreamUrl: string): string {
  const url = new URL(upstreamUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Resolve OAuth endpoints from explicit config, falling back to
 * auto-derived endpoints from the MCP server's URL origin.
 */
function resolveOAuthEndpoints(
  upstreamUrl: string,
  oauth?: McpOAuthConfig
): ResolvedOAuthEndpoints {
  const issuer = deriveOAuthBaseUrl(upstreamUrl);
  return {
    registrationUrl: oauth?.registrationUrl ?? `${issuer}/oauth/register`,
    deviceAuthorizationUrl:
      oauth?.deviceAuthorizationUrl ?? `${issuer}/oauth/device_authorization`,
    tokenUrl: oauth?.tokenUrl ?? `${issuer}/oauth/token`,
    verificationUri: oauth?.authUrl ?? `${issuer}/oauth/device`,
    scope: oauth?.scopes?.join(" ") || DEFAULT_MCP_SCOPE,
    clientId: oauth?.clientId,
    clientSecret: oauth?.clientSecret,
    resource: oauth?.resource,
  };
}

export async function getStoredCredential(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string
): Promise<StoredCredential | null> {
  return getSecretJson<StoredCredential>(
    secretStore,
    credentialName(agentId, userId, mcpId),
    { agentId, userId, mcpId }
  );
}

async function storeCredential(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string,
  credential: StoredCredential
): Promise<void> {
  await putSecretJson(
    secretStore,
    credentialName(agentId, userId, mcpId),
    credential,
    90 * 24 * 60 * 60
  );
}

/**
 * Persist an OAuth credential under an opaque scope key.
 * `scopeKey` is `userId` for per-user scope or `channel-<id>` for channel scope.
 * Exposed so the MCP auth-code callback can write credentials without importing
 * internal helpers.
 */
export async function storeCredentialForScope(
  secretStore: WritableSecretStore,
  agentId: string,
  scopeKey: string,
  mcpId: string,
  credential: StoredCredential
): Promise<void> {
  await storeCredential(secretStore, agentId, scopeKey, mcpId, credential);
}

/**
 * Delete a stored MCP device-auth credential (logout). Removes the secret
 * row directly so no orphaned tokens linger for the remainder of the 90-day
 * TTL.
 */
async function deleteCredential(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string
): Promise<boolean> {
  const deleted = await deleteSecretJson(
    secretStore,
    credentialName(agentId, userId, mcpId),
    { agentId, userId, mcpId }
  );
  await deleteSecretJson(
    secretStore,
    deviceAuthName(agentId, userId, mcpId),
    { agentId, userId, mcpId, scope: "device-auth" }
  );
  logger.info("Deleted MCP credential", { agentId, userId, mcpId });
  return deleted;
}

export async function refreshCredential(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string,
  credential: StoredCredential
): Promise<StoredCredential | null> {
  if (!credential.refreshToken) return null;

  const acquired = tryAcquireRefreshLock(agentId, userId, mcpId);

  if (!acquired) {
    // Another request is refreshing — wait briefly and re-read
    await new Promise((r) => setTimeout(r, 150));
    return getStoredCredential(secretStore, agentId, userId, mcpId);
  }

  try {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
    };
    if (credential.resource) {
      body.resource = credential.resource;
    }

    const authMethod = credential.tokenEndpointAuthMethod;
    const headers: Record<string, string> = { Accept: "application/json" };
    let requestBody: string;

    if (!authMethod) {
      // Legacy device-code path — JSON body with secret inline.
      if (credential.clientSecret) body.client_secret = credential.clientSecret;
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    } else {
      // RFC 6749-compliant form-encoded refresh. Auth method drives where the
      // secret goes.
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (authMethod === "client_secret_post" && credential.clientSecret) {
        body.client_secret = credential.clientSecret;
      } else if (
        authMethod === "client_secret_basic" &&
        credential.clientSecret
      ) {
        const basic = Buffer.from(
          `${encodeURIComponent(credential.clientId)}:${encodeURIComponent(credential.clientSecret)}`
        ).toString("base64");
        headers.Authorization = `Basic ${basic}`;
      }
      requestBody = new URLSearchParams(body).toString();
    }

    const response = await fetch(credential.tokenUrl, {
      method: "POST",
      headers,
      body: requestBody,
    });

    if (!response.ok) {
      logger.error("Token refresh failed", {
        status: response.status,
        agentId,
        userId,
        mcpId,
      });
      return null;
    }

    const data = (await response.json()) as Record<string, unknown>;
    if (typeof data.access_token !== "string") return null;

    const refreshed: StoredCredential = {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string"
          ? data.refresh_token
          : credential.refreshToken,
      expiresAt:
        typeof data.expires_in === "number"
          ? Date.now() + data.expires_in * 1000
          : Date.now() + 3_600_000,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      tokenUrl: credential.tokenUrl,
      resource: credential.resource,
      tokenEndpointAuthMethod: credential.tokenEndpointAuthMethod,
    };

    await storeCredential(secretStore, agentId, userId, mcpId, refreshed);
    logger.info("Token refreshed", { agentId, userId, mcpId });
    return refreshed;
  } catch (error) {
    logger.error("Token refresh error", { error, agentId, userId, mcpId });
    return null;
  } finally {
    releaseRefreshLock(agentId, userId, mcpId);
  }
}

/**
 * Try to complete a pending device-code auth flow.
 * Called by the MCP proxy's resolveCredentialToken when no stored credential
 * exists but a device-auth flow may have been started earlier.
 * Returns the access token on success, null if pending or no flow in progress.
 */
export async function tryCompletePendingDeviceAuth(
  secretStore: WritableSecretStore,
  agentId: string,
  userId: string,
  mcpId: string
): Promise<string | null> {
  const deviceState = await getSecretJson<StoredDeviceAuth>(
    secretStore,
    deviceAuthName(agentId, userId, mcpId),
    { agentId, userId, mcpId, scope: "device-auth" }
  );
  if (!deviceState) return null;

  if (Date.now() > deviceState.expiresAt) {
    await deleteSecretJson(
      secretStore,
      deviceAuthName(agentId, userId, mcpId),
      { agentId, userId, mcpId, scope: "device-auth" }
    );
    return null;
  }

  try {
    const deviceCodeClient = new GenericDeviceCodeClient({
      clientId: deviceState.clientId,
      clientSecret: deviceState.clientSecret,
      tokenUrl: deviceState.tokenUrl,
      deviceAuthorizationUrl:
        deviceState.deviceAuthorizationUrl ??
        `${deviceState.issuer}/oauth/device_authorization`,
      scope: deviceState.scope ?? DEFAULT_MCP_SCOPE,
      resource: deviceState.resource,
      tokenEndpointAuthMethod: deviceState.clientSecret
        ? "client_secret_post"
        : "none",
    });

    const pollResult = await deviceCodeClient.pollForToken(
      deviceState.deviceCode,
      deviceState.interval
    );

    if (pollResult.status === "pending") {
      return null;
    }

    if (pollResult.status === "error") {
      await deleteSecretJson(
        secretStore,
        deviceAuthName(agentId, userId, mcpId),
        { agentId, userId, mcpId, scope: "device-auth" }
      );
      return null;
    }

    // Success — store credential and clean up
    const { credentials } = pollResult;
    const storedCred: StoredCredential = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      clientId: deviceState.clientId,
      clientSecret: deviceState.clientSecret,
      tokenUrl: deviceState.tokenUrl,
      resource: deviceState.resource,
    };

    await storeCredential(secretStore, agentId, userId, mcpId, storedCred);
    await deleteSecretJson(
      secretStore,
      deviceAuthName(agentId, userId, mcpId),
      { agentId, userId, mcpId, scope: "device-auth" }
    );

    logger.info("Device auth auto-completed by proxy", {
      mcpId,
      agentId,
      userId,
    });
    return credentials.accessToken;
  } catch (error) {
    logger.warn("Auto-complete device auth failed", {
      mcpId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Start device-code auth flow for a given MCP server.
 * Reusable by the MCP proxy to auto-initiate auth on "unauthorized" errors.
 *
 * When the MCP server's oauth config provides a clientId, dynamic client
 * registration is skipped entirely.
 */
export async function startDeviceAuth(
  secretStore: WritableSecretStore,
  mcpConfigService: {
    getHttpServer: (
      id: string,
      agentId?: string
    ) => Promise<{ upstreamUrl: string; oauth?: McpOAuthConfig } | undefined>;
  },
  mcpId: string,
  agentId: string,
  userId: string
): Promise<{
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
} | null> {
  // Reuse existing pending device auth flow if not expired
  const existing = await getSecretJson<StoredDeviceAuth>(
    secretStore,
    deviceAuthName(agentId, userId, mcpId),
    { agentId, userId, mcpId, scope: "device-auth" }
  );
  if (existing?.expiresAt && existing.expiresAt > Date.now()) {
    const httpServer = await mcpConfigService.getHttpServer(mcpId, agentId);
    const issuer = httpServer
      ? deriveOAuthBaseUrl(httpServer.upstreamUrl)
      : existing.issuer;
    const endpoints = httpServer
      ? resolveOAuthEndpoints(httpServer.upstreamUrl, httpServer.oauth)
      : null;
    const verificationUri =
      endpoints?.verificationUri ?? `${issuer}/oauth/device`;
    logger.info("Reusing existing pending device auth", {
      mcpId,
      agentId,
      userId,
    });
    return {
      userCode: existing.userCode || "",
      verificationUri,
      verificationUriComplete: existing.userCode
        ? `${verificationUri}?user_code=${existing.userCode}`
        : verificationUri,
      expiresIn: Math.floor((existing.expiresAt - Date.now()) / 1000),
    };
  }

  const httpServer = await mcpConfigService.getHttpServer(mcpId, agentId);
  if (!httpServer) {
    logger.warn("startDeviceAuth: httpServer not found", { mcpId, agentId });
    return null;
  }

  const endpoints = resolveOAuthEndpoints(
    httpServer.upstreamUrl,
    httpServer.oauth
  );

  // Resolve client: use explicit config clientId, or cached registration, or register new
  let client: StoredClient | null = null;

  if (endpoints.clientId) {
    // Config provides a pre-registered client — skip dynamic registration
    client = {
      clientId: endpoints.clientId,
      clientSecret: endpoints.clientSecret,
    };
    logger.info("Using pre-registered OAuth client from config", {
      mcpId,
      clientId: endpoints.clientId,
    });
  } else {
    // Check cached client registration
    client = await getSecretJson<StoredClient>(
      secretStore,
      clientCacheName(mcpId),
      { mcpId, scope: "device-client" }
    );

    // Register a new client if needed
    if (!client) {
      const regResponse = await fetch(endpoints.registrationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
          token_endpoint_auth_method: "none",
          client_name: "Lobu Gateway Device Auth",
          scope: endpoints.scope,
        }),
      });

      if (!regResponse.ok) return null;

      const registration = (await regResponse.json()) as {
        client_id: string;
        client_secret?: string;
      };

      client = {
        clientId: registration.client_id,
        clientSecret: registration.client_secret,
      };

      await putSecretJson(secretStore, clientCacheName(mcpId), client);
    }
  }

  const deviceCodeClient = new GenericDeviceCodeClient({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenUrl: endpoints.tokenUrl,
    deviceAuthorizationUrl: endpoints.deviceAuthorizationUrl,
    scope: endpoints.scope,
    resource: endpoints.resource,
    tokenEndpointAuthMethod: client.clientSecret
      ? "client_secret_post"
      : "none",
  });

  const started = await deviceCodeClient.requestDeviceCode();

  const deviceState: StoredDeviceAuth = {
    deviceCode: started.deviceAuthId,
    userCode: started.userCode,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    interval: started.interval,
    expiresAt: Date.now() + started.expiresIn * 1000,
    tokenUrl: endpoints.tokenUrl,
    issuer: deriveOAuthBaseUrl(httpServer.upstreamUrl),
    deviceAuthorizationUrl: endpoints.deviceAuthorizationUrl,
    resource: endpoints.resource,
    scope: endpoints.scope,
  };

  await putSecretJson(
    secretStore,
    deviceAuthName(agentId, userId, mcpId),
    deviceState,
    started.expiresIn
  );

  logger.info("Device auth started (auto)", { mcpId, agentId, userId });

  return {
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    expiresIn: started.expiresIn,
  };
}

export function createDeviceAuthRoutes(
  config: DeviceAuthConfig
): Hono<WorkerContext> {
  const { mcpConfigService } = config;
  const router = new Hono<WorkerContext>();

  // POST /internal/device-auth/start
  router.post("/internal/device-auth/start", authenticateWorker, async (c) => {
    const body = await c.req.json<{ mcpId: string }>();
    const mcpId = body?.mcpId;
    if (!mcpId) {
      return errorResponse(c, "Missing required field: mcpId", 400);
    }

    const worker = getVerifiedWorker(c);
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    try {
      const result = await startDeviceAuth(
        config.secretStore,
        mcpConfigService,
        mcpId,
        agentId,
        userId
      );

      if (!result) {
        return errorResponse(
          c,
          `MCP server '${mcpId}' not found or client registration failed`,
          404
        );
      }

      return c.json(result);
    } catch (error) {
      logger.error("Failed to start device auth", {
        mcpId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return errorResponse(c, "Failed to start device authentication", 500);
    }
  });

  // POST /internal/device-auth/poll
  router.post("/internal/device-auth/poll", authenticateWorker, async (c) => {
    const body = await c.req.json<{ mcpId: string }>();
    const mcpId = body?.mcpId;
    if (!mcpId) {
      return errorResponse(c, "Missing required field: mcpId", 400);
    }

    const worker = getVerifiedWorker(c);
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    const deviceState = await getSecretJson<StoredDeviceAuth>(
      config.secretStore,
      deviceAuthName(agentId, userId, mcpId),
      { agentId, userId, mcpId, scope: "device-auth" }
    );
    if (!deviceState) {
      return c.json(
        {
          status: "error",
          message: "No device auth in progress. Call start first.",
        },
        400
      );
    }

    if (Date.now() > deviceState.expiresAt) {
      await deleteSecretJson(
        config.secretStore,
        deviceAuthName(agentId, userId, mcpId),
        { agentId, userId, mcpId, scope: "device-auth" }
      );
      return c.json(
        { status: "error", message: "Device code expired. Start again." },
        400
      );
    }

    try {
      const deviceCodeClient = new GenericDeviceCodeClient({
        clientId: deviceState.clientId,
        clientSecret: deviceState.clientSecret,
        tokenUrl: deviceState.tokenUrl,
        deviceAuthorizationUrl:
          deviceState.deviceAuthorizationUrl ??
          `${deviceState.issuer}/oauth/device_authorization`,
        scope: deviceState.scope ?? DEFAULT_MCP_SCOPE,
        resource: deviceState.resource,
        tokenEndpointAuthMethod: deviceState.clientSecret
          ? "client_secret_post"
          : "none",
      });

      const pollResult = await deviceCodeClient.pollForToken(
        deviceState.deviceCode,
        deviceState.interval
      );

      if (pollResult.status === "pending") {
        // Update interval if slow_down was received
        if (
          pollResult.interval &&
          pollResult.interval !== deviceState.interval
        ) {
          deviceState.interval = pollResult.interval;
          const ttl = Math.max(
            Math.floor((deviceState.expiresAt - Date.now()) / 1000),
            10
          );
          await putSecretJson(
            config.secretStore,
            deviceAuthName(agentId, userId, mcpId),
            deviceState,
            ttl
          );
        }
        return c.json({ status: "pending" });
      }

      if (pollResult.status === "error") {
        await deleteSecretJson(
          config.secretStore,
          deviceAuthName(agentId, userId, mcpId),
          { agentId, userId, mcpId, scope: "device-auth" }
        );
        return c.json({ status: "error", message: pollResult.error });
      }

      // Success — store credential and clean up device auth state
      const { credentials } = pollResult;
      const storedCred: StoredCredential = {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        clientId: deviceState.clientId,
        clientSecret: deviceState.clientSecret,
        tokenUrl: deviceState.tokenUrl,
        resource: deviceState.resource,
      };

      await storeCredential(
        config.secretStore,
        agentId,
        userId,
        mcpId,
        storedCred
      );
      await deleteSecretJson(
        config.secretStore,
        deviceAuthName(agentId, userId, mcpId),
        { agentId, userId, mcpId, scope: "device-auth" }
      );

      logger.info("Device auth completed", { mcpId, agentId, userId });
      return c.json({ status: "complete" });
    } catch (error) {
      logger.error("Failed to poll device auth", { mcpId, error });
      return c.json(
        { status: "error", message: "Failed to poll device auth" },
        500
      );
    }
  });

  // GET /internal/device-auth/status?mcpId=owletto
  router.get("/internal/device-auth/status", authenticateWorker, async (c) => {
    const mcpId = c.req.query("mcpId");
    if (!mcpId) {
      return errorResponse(c, "Missing required query param: mcpId", 400);
    }

    const worker = getVerifiedWorker(c);
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    const credential = await getStoredCredential(
      config.secretStore,
      agentId,
      userId,
      mcpId
    );
    return c.json({ authenticated: !!credential });
  });

  // DELETE /internal/device-auth/credential?mcpId=owletto
  // Logout: revoke a stored credential + purge the underlying secret.
  router.delete(
    "/internal/device-auth/credential",
    authenticateWorker,
    async (c) => {
      const mcpId = c.req.query("mcpId");
      if (!mcpId) {
        return errorResponse(c, "Missing required query param: mcpId", 400);
      }

      const worker = getVerifiedWorker(c);
      const agentId = worker.agentId || worker.userId;
      const userId = worker.userId;

      const deleted = await deleteCredential(
        config.secretStore,
        agentId,
        userId,
        mcpId
      );
      return c.json({ deleted });
    }
  );

  logger.debug("Device auth routes registered");
  return router;
}
