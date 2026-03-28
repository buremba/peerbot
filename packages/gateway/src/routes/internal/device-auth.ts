import { createLogger, decrypt, encrypt } from "@lobu/core";
import { Hono } from "hono";
import type Redis from "ioredis";
import { GenericDeviceCodeClient } from "../../auth/external/device-code-client";
import type { McpConfigService } from "../../auth/mcp/config-service";
import { authenticateWorker } from "./middleware";

const logger = createLogger("device-auth");

const DEFAULT_MCP_SCOPE = "mcp:read mcp:write profile:read";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

type WorkerContext = {
  Variables: {
    worker: {
      userId: string;
      agentId?: string;
      deploymentName: string;
    };
  };
};

interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
}

interface StoredDeviceAuth {
  deviceCode: string;
  clientId: string;
  clientSecret?: string;
  interval: number;
  expiresAt: number;
  tokenUrl: string;
  issuer: string;
}

interface StoredClient {
  clientId: string;
  clientSecret?: string;
}

export interface DeviceAuthConfig {
  redis: Redis;
  mcpConfigService: McpConfigService;
}

function credentialKey(agentId: string, userId: string, mcpId: string): string {
  return `auth:credential:${agentId}:${userId}:${mcpId}`;
}

function deviceAuthKey(agentId: string, userId: string, mcpId: string): string {
  return `device-auth:${agentId}:${userId}:${mcpId}`;
}

function clientCacheKey(mcpId: string): string {
  return `device-auth:client:${mcpId}`;
}

function refreshLockKey(
  agentId: string,
  userId: string,
  mcpId: string
): string {
  return `auth:refresh-lock:${agentId}:${userId}:${mcpId}`;
}

export async function getStoredCredential(
  redis: Redis,
  agentId: string,
  userId: string,
  mcpId: string
): Promise<StoredCredential | null> {
  const raw = await redis.get(credentialKey(agentId, userId, mcpId));
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw)) as StoredCredential;
  } catch {
    return null;
  }
}

async function storeCredential(
  redis: Redis,
  agentId: string,
  userId: string,
  mcpId: string,
  credential: StoredCredential
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credential));
  // Store with 90-day TTL (tokens can be refreshed before expiry)
  await redis.set(
    credentialKey(agentId, userId, mcpId),
    encrypted,
    "EX",
    90 * 24 * 60 * 60
  );
}

export async function refreshCredential(
  redis: Redis,
  agentId: string,
  userId: string,
  mcpId: string,
  credential: StoredCredential
): Promise<StoredCredential | null> {
  if (!credential.refreshToken) return null;

  const lockKey = refreshLockKey(agentId, userId, mcpId);
  const acquired = await redis.set(lockKey, "1", "EX", 30, "NX");

  if (!acquired) {
    // Another request is refreshing — wait briefly and re-read
    await new Promise((r) => setTimeout(r, 150));
    return getStoredCredential(redis, agentId, userId, mcpId);
  }

  try {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      client_id: credential.clientId,
      refresh_token: credential.refreshToken,
    };
    if (credential.clientSecret) {
      body.client_secret = credential.clientSecret;
    }

    const response = await fetch(credential.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
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
    };

    await storeCredential(redis, agentId, userId, mcpId, refreshed);
    logger.info("Token refreshed", { agentId, userId, mcpId });
    return refreshed;
  } catch (error) {
    logger.error("Token refresh error", { error, agentId, userId, mcpId });
    return null;
  } finally {
    await redis.del(lockKey).catch(() => undefined);
  }
}

/**
 * Try to complete a pending device-code auth flow.
 * Called by the MCP proxy's resolveCredentialToken when no stored credential
 * exists but a device-auth flow may have been started earlier.
 * Returns the access token on success, null if pending or no flow in progress.
 */
export async function tryCompletePendingDeviceAuth(
  redis: Redis,
  agentId: string,
  userId: string,
  mcpId: string
): Promise<string | null> {
  const raw = await redis.get(deviceAuthKey(agentId, userId, mcpId));
  if (!raw) return null;

  let deviceState: StoredDeviceAuth;
  try {
    deviceState = JSON.parse(raw) as StoredDeviceAuth;
  } catch {
    return null;
  }

  if (Date.now() > deviceState.expiresAt) {
    await redis.del(deviceAuthKey(agentId, userId, mcpId));
    return null;
  }

  try {
    const deviceCodeClient = new GenericDeviceCodeClient({
      clientId: deviceState.clientId,
      clientSecret: deviceState.clientSecret,
      tokenUrl: deviceState.tokenUrl,
      deviceAuthorizationUrl: `${deviceState.issuer}/oauth/device_authorization`,
      scope: DEFAULT_MCP_SCOPE,
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
      await redis.del(deviceAuthKey(agentId, userId, mcpId));
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
    };

    await storeCredential(redis, agentId, userId, mcpId, storedCred);
    await redis.del(deviceAuthKey(agentId, userId, mcpId));

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

function deriveOAuthBaseUrl(upstreamUrl: string): string {
  const url = new URL(upstreamUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * Start device-code auth flow for a given MCP server.
 * Reusable by the MCP proxy to auto-initiate auth on "unauthorized" errors.
 */
export async function startDeviceAuth(
  redis: Redis,
  mcpConfigService: {
    getHttpServer: (
      id: string,
      agentId?: string
    ) => Promise<{ upstreamUrl: string } | undefined>;
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
  const httpServer = await mcpConfigService.getHttpServer(mcpId, agentId);
  if (!httpServer) return null;

  const issuer = deriveOAuthBaseUrl(httpServer.upstreamUrl);

  // Check cached client registration
  let client: StoredClient | null = null;
  const cachedClient = await redis.get(clientCacheKey(mcpId));
  if (cachedClient) {
    try {
      client = JSON.parse(cachedClient) as StoredClient;
    } catch {
      client = null;
    }
  }

  // Register a new client if needed
  if (!client) {
    const regResponse = await fetch(`${issuer}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
        token_endpoint_auth_method: "none",
        client_name: "Lobu Gateway Device Auth",
        scope: DEFAULT_MCP_SCOPE,
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

    await redis.set(clientCacheKey(mcpId), JSON.stringify(client));
  }

  const deviceCodeClient = new GenericDeviceCodeClient({
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    tokenUrl: `${issuer}/oauth/token`,
    deviceAuthorizationUrl: `${issuer}/oauth/device_authorization`,
    scope: DEFAULT_MCP_SCOPE,
    tokenEndpointAuthMethod: client.clientSecret
      ? "client_secret_post"
      : "none",
  });

  const started = await deviceCodeClient.requestDeviceCode();

  const deviceState: StoredDeviceAuth = {
    deviceCode: started.deviceAuthId,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    interval: started.interval,
    expiresAt: Date.now() + started.expiresIn * 1000,
    tokenUrl: `${issuer}/oauth/token`,
    issuer,
  };

  await redis.set(
    deviceAuthKey(agentId, userId, mcpId),
    JSON.stringify(deviceState),
    "EX",
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
  const { redis, mcpConfigService } = config;
  const router = new Hono<WorkerContext>();

  // POST /internal/device-auth/start
  router.post("/internal/device-auth/start", authenticateWorker, async (c) => {
    const body = await c.req.json<{ mcpId: string }>();
    const mcpId = body?.mcpId;
    if (!mcpId) {
      return c.json({ error: "Missing required field: mcpId" }, 400);
    }

    const worker = c.get("worker");
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    // Resolve the MCP server to get its upstream URL
    const httpServer = await mcpConfigService.getHttpServer(mcpId, agentId);
    if (!httpServer) {
      return c.json({ error: `MCP server '${mcpId}' not found` }, 404);
    }

    const issuer = deriveOAuthBaseUrl(httpServer.upstreamUrl);

    try {
      // Check cached client registration
      let client: StoredClient | null = null;
      const cachedClient = await redis.get(clientCacheKey(mcpId));
      if (cachedClient) {
        try {
          client = JSON.parse(cachedClient) as StoredClient;
        } catch {
          client = null;
        }
      }

      // Register a new client if needed
      if (!client) {
        const regResponse = await fetch(`${issuer}/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_types: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
            token_endpoint_auth_method: "none",
            client_name: "Lobu Gateway Device Auth",
            scope: DEFAULT_MCP_SCOPE,
          }),
        });

        if (!regResponse.ok) {
          const errText = await regResponse.text();
          logger.error("Client registration failed", { mcpId, error: errText });
          return c.json({ error: "Client registration failed" }, 502);
        }

        const registration = (await regResponse.json()) as {
          client_id: string;
          client_secret?: string;
        };

        client = {
          clientId: registration.client_id,
          clientSecret: registration.client_secret,
        };

        // Cache indefinitely (clients don't expire)
        await redis.set(clientCacheKey(mcpId), JSON.stringify(client));
      }

      // Request device authorization
      const deviceCodeClient = new GenericDeviceCodeClient({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenUrl: `${issuer}/oauth/token`,
        deviceAuthorizationUrl: `${issuer}/oauth/device_authorization`,
        scope: DEFAULT_MCP_SCOPE,
        tokenEndpointAuthMethod: client.clientSecret
          ? "client_secret_post"
          : "none",
      });

      const started = await deviceCodeClient.requestDeviceCode();

      // Store device auth state in Redis
      const deviceState: StoredDeviceAuth = {
        deviceCode: started.deviceAuthId,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        interval: started.interval,
        expiresAt: Date.now() + started.expiresIn * 1000,
        tokenUrl: `${issuer}/oauth/token`,
        issuer,
      };

      await redis.set(
        deviceAuthKey(agentId, userId, mcpId),
        JSON.stringify(deviceState),
        "EX",
        started.expiresIn
      );

      logger.info("Device auth started", { mcpId, agentId, userId });

      return c.json({
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        expiresIn: started.expiresIn,
      });
    } catch (error) {
      logger.error("Failed to start device auth", { mcpId, error });
      return c.json({ error: "Failed to start device authentication" }, 500);
    }
  });

  // POST /internal/device-auth/poll
  router.post("/internal/device-auth/poll", authenticateWorker, async (c) => {
    const body = await c.req.json<{ mcpId: string }>();
    const mcpId = body?.mcpId;
    if (!mcpId) {
      return c.json({ error: "Missing required field: mcpId" }, 400);
    }

    const worker = c.get("worker");
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    const raw = await redis.get(deviceAuthKey(agentId, userId, mcpId));
    if (!raw) {
      return c.json(
        {
          status: "error",
          message: "No device auth in progress. Call start first.",
        },
        400
      );
    }

    const deviceState = JSON.parse(raw) as StoredDeviceAuth;

    if (Date.now() > deviceState.expiresAt) {
      await redis.del(deviceAuthKey(agentId, userId, mcpId));
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
        deviceAuthorizationUrl: `${deviceState.issuer}/oauth/device_authorization`,
        scope: DEFAULT_MCP_SCOPE,
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
          await redis.set(
            deviceAuthKey(agentId, userId, mcpId),
            JSON.stringify(deviceState),
            "EX",
            ttl
          );
        }
        return c.json({ status: "pending" });
      }

      if (pollResult.status === "error") {
        await redis.del(deviceAuthKey(agentId, userId, mcpId));
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
      };

      await storeCredential(redis, agentId, userId, mcpId, storedCred);
      await redis.del(deviceAuthKey(agentId, userId, mcpId));

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
      return c.json({ error: "Missing required query param: mcpId" }, 400);
    }

    const worker = c.get("worker");
    const agentId = worker.agentId || worker.userId;
    const userId = worker.userId;

    const credential = await getStoredCredential(redis, agentId, userId, mcpId);
    return c.json({ authenticated: !!credential });
  });

  logger.debug("Device auth routes registered");
  return router;
}
