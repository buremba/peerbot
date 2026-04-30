#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger, moduleRegistry as coreModuleRegistry } from "@lobu/core";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AgentMetadata } from "../auth/agent-metadata-store.js";
import { takePendingTool } from "../auth/mcp/pending-tool-store.js";
import { setEnvResolver } from "../auth/mcp/string-substitution.js";
import { OAuthClient } from "../auth/oauth/client.js";
import { CLAUDE_PROVIDER } from "../auth/oauth/providers.js";
import { createAuthProfileLabel } from "../auth/settings/auth-profiles-manager.js";
import { SystemEnvStore } from "../auth/system-env-store.js";
import type { GatewayConfig } from "../config/index.js";
import { getModelProviderModules } from "../modules/module-system.js";
import { createAudioRoutes } from "../routes/internal/audio.js";
import { createDeviceAuthRoutes } from "../routes/internal/device-auth.js";
import { createFileRoutes } from "../routes/internal/files.js";
import { createHistoryRoutes } from "../routes/internal/history.js";
import { createImageRoutes } from "../routes/internal/images.js";
import { createInteractionRoutes } from "../routes/internal/interactions.js";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto.js";
import { createAgentApi } from "../routes/public/agent.js";
import { createAgentConfigRoutes } from "../routes/public/agent-config.js";
import { createAgentHistoryRoutes } from "../routes/public/agent-history.js";
import { createAgentRoutes } from "../routes/public/agents.js";
import { createChannelBindingRoutes } from "../routes/public/channels.js";
import { createConnectAuthRoutes } from "../routes/public/connect-auth.js";
import {
  createConnectionCrudRoutes,
  createConnectionWebhookRoutes,
} from "../routes/public/connections.js";
import { createPublicFileRoutes } from "../routes/public/files.js";
import { createLandingRoutes } from "../routes/public/landing.js";
import { createMcpOAuthRoutes } from "../routes/public/mcp-oauth.js";
import {
  createOAuthRoutes,
  type ProviderCredentialStore,
} from "../routes/public/oauth.js";
import {
  setAuthProvider,
  verifySettingsSessionOrToken,
} from "../routes/public/settings-auth.js";
import { createSlackRoutes } from "../routes/public/slack.js";

const logger = createLogger("gateway-startup");

let httpServer: Server | null = null;

interface CreateGatewayAppOptions {
  secretProxy: any;
  workerGateway: any;
  mcpProxy: any;
  interactionService?: any;
  platformRegistry?: any;
  coreServices?: any;
  chatInstanceManager?:
    | import("../connections/index.js").ChatInstanceManager
    | null;
  /** Custom auth provider for embedded mode. When set, gateway delegates auth to this function instead of using cookie-based sessions. */
  authProvider?: import("../routes/public/settings-auth.js").AuthProvider;
}

/**
 * Create the Hono app with all gateway routes.
 * Returns the app without starting an HTTP server — the caller can mount it
 * on their own server (embedded mode) or pass it to `startGatewayServer()`.
 */
export function createGatewayApp(
  options: CreateGatewayAppOptions
): OpenAPIHono {
  const {
    secretProxy,
    workerGateway,
    mcpProxy,
    interactionService,
    platformRegistry,
    coreServices,
    chatInstanceManager,
    authProvider,
  } = options;

  if (authProvider) {
    setAuthProvider(authProvider);
  }

  const app = new OpenAPIHono();

  app.use(
    "*",
    secureHeaders({
      xFrameOptions: false,
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'self'", "*"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "ws:", "wss:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
      },
    })
  );
  app.use(
    "*",
    cors({
      origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : [],
      credentials: true,
    })
  );

  app.get("/health", (c) => {
    const mode = process.env.LOBU_MODE || "cloud";

    return c.json({
      status: "ok",
      mode,
      version: process.env.npm_package_version || "2.3.0",
      timestamp: new Date().toISOString(),
      publicGatewayUrl:
        coreServices?.getPublicGatewayUrl?.() || process.env.PUBLIC_GATEWAY_URL,
      capabilities: {
        agents: ["claude"],
        streaming: true,
        toolApproval: true,
      },
      wsUrl: `ws://localhost:8080/ws`,
      secretProxy: !!secretProxy,
    });
  });

  app.get("/ready", (c) => c.json({ ready: true }));

  const adminPassword: string =
    process.env.ADMIN_PASSWORD || randomBytes(16).toString("base64url");

  // Metrics auth is optional so existing ServiceMonitor configs continue to scrape.
  app.get("/metrics", async (c) => {
    const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
    if (metricsAuthToken) {
      const authHeader = c.req.header("Authorization");
      if (authHeader !== `Bearer ${metricsAuthToken}`) {
        return c.text("Unauthorized", 401);
      }
    }
    const { getMetricsText } = await import("../metrics/prometheus.js");
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(getMetricsText());
  });

  if (secretProxy) {
    app.route("/api/proxy", secretProxy.getApp());
    logger.debug("Secret proxy enabled at :8080/api/proxy");
  }

  if (coreServices) {
    const bedrockOpenAIService = coreServices.getBedrockOpenAIService?.();
    if (bedrockOpenAIService) {
      app.route("/api/bedrock", bedrockOpenAIService.getApp());
      logger.debug("Bedrock routes enabled at :8080/api/bedrock/*");
    }
  }

  if (workerGateway) {
    app.route("/worker", workerGateway.getApp());
    logger.debug("Worker gateway routes enabled at :8080/worker/*");
  }

  const expressApp = createExpressAdapter(app);
  coreModuleRegistry.registerEndpoints(expressApp);
  logger.debug("Module endpoints registered");

  // MCP OAuth callback MUST register before the MCP proxy mount at /mcp,
  // otherwise the proxy's `/:mcpId/*` route swallows /mcp/oauth/callback.
  if (coreServices) {
    const mcpOAuthRouter = createMcpOAuthRoutes({
      secretStore: coreServices.getSecretStore(),
      publicGatewayUrl: coreServices.getPublicGatewayUrl(),
      coreServices,
      chatInstanceManager: chatInstanceManager ?? undefined,
    });
    app.route("", mcpOAuthRouter);
    logger.debug(
      "MCP OAuth callback route enabled at :8080/mcp/oauth/callback"
    );
  }

  if (mcpProxy) {
    app.all("/", async (c, next) => {
      if (mcpProxy.isMcpRequest(c)) {
        return mcpProxy.getApp().fetch(c.req.raw);
      }
      return next();
    });
    app.route("/mcp", mcpProxy.getApp());
    logger.debug("MCP proxy routes enabled at :8080/mcp/*");
  }

  if (platformRegistry && coreServices) {
    const artifactStore = coreServices.getArtifactStore();
    const fileRouter = createFileRoutes(
      platformRegistry,
      artifactStore,
      coreServices.getPublicGatewayUrl()
    );
    app.route("/internal/files", fileRouter);

    app.route("", createPublicFileRoutes(artifactStore));
    logger.debug(
      "File routes enabled at :8080/internal/files/* and /api/v1/files/*"
    );
  }

  {
    const historyRouter = createHistoryRoutes();
    app.route("/internal", historyRouter);
    logger.debug("History routes enabled at :8080/internal/history");
  }

  if (coreServices) {
    const mcpConfigService = coreServices.getMcpConfigService();
    if (mcpConfigService) {
      const deviceAuthRouter = createDeviceAuthRoutes({
        mcpConfigService,
        secretStore: coreServices.getSecretStore(),
      });
      app.route("", deviceAuthRouter);
      logger.debug(
        "Device auth routes enabled at :8080/internal/device-auth/*"
      );
    }
  }

  if (coreServices) {
    const transcriptionService = coreServices.getTranscriptionService();
    if (transcriptionService) {
      const audioRouter = createAudioRoutes(transcriptionService);
      app.route("", audioRouter);
      logger.debug("Audio routes enabled at :8080/internal/audio/*");
    }
  }

  if (coreServices) {
    const imageGenerationService = coreServices.getImageGenerationService();
    if (imageGenerationService) {
      const imageRouter = createImageRoutes(imageGenerationService);
      app.route("", imageRouter);
      logger.debug("Image routes enabled at :8080/internal/images/*");
    }
  }

  if (interactionService) {
    const internalRouter = createInteractionRoutes(interactionService);
    app.route("", internalRouter);
    logger.debug("Internal interaction routes enabled");
  }

  if (coreServices) {
    const queueProducer = coreServices.getQueueProducer();
    const sessionMgr = coreServices.getSessionManager();
    const interactionSvc = coreServices.getInteractionService();
    const publicUrl = coreServices.getPublicGatewayUrl();

    if (queueProducer && sessionMgr && interactionSvc) {
      const approveGrantStore = coreServices.getGrantStore();
      const approveMcpProxy = coreServices.getMcpProxy();

      const agentApi = createAgentApi({
        queueProducer,
        sessionManager: sessionMgr,
        sseManager: coreServices.getSseManager(),
        publicGatewayUrl: publicUrl,
        adminPassword,
        externalAuthClient: coreServices.getExternalAuthClient(),
        agentSettingsStore: coreServices.getAgentSettingsStore(),
        agentConfigStore: coreServices.getConfigStore(),
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getAgentMetadataStore(),
        platformRegistry,
        approveToolCall: async (requestId: string, decision: string) => {
          // DELETE ... RETURNING atomically claims the pending invocation
          // so a retry of POST /api/v1/agents/approve (CLI re-tries,
          // double-clicks, Slack webhook retries) cannot double-execute the
          // tool. The Slack/Telegram interaction-bridge path uses the same
          // helper.
          const pending = await takePendingTool(requestId);
          if (!pending)
            return { success: false, error: "Request not found or expired" };
          const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;
          const expiresMap: Record<string, number | null> = {
            "1h": Date.now() + 3_600_000,
            "24h": Date.now() + 86_400_000,
            always: null,
          };
          if (decision === "deny") {
            await approveGrantStore?.grant(
              pending.agentId,
              pattern,
              null,
              true
            );
            return { success: true };
          }
          await approveGrantStore?.grant(
            pending.agentId,
            pattern,
            decision in expiresMap ? expiresMap[decision]! : null
          );
          if (approveMcpProxy) {
            const result = await approveMcpProxy.executeToolDirect(
              pending.agentId,
              pending.userId,
              pending.mcpId,
              pending.toolName,
              pending.args
            );
            return { success: true, result } as any;
          }
          return { success: true };
        },
      });
      app.route("", agentApi);
      logger.debug(
        "Agent API enabled at :8080/api/v1/agents/* with docs at :8080/api/docs"
      );
    }
  }

  if (coreServices) {
    const authRouter = new OpenAPIHono();
    const registeredProviders: string[] = [];

    {
      const connectAuthRouter = createConnectAuthRoutes({
        externalAuthClient: coreServices.getExternalAuthClient(),
      });
      app.route("", connectAuthRouter);
    }

    const providerModules = getModelProviderModules();

    const authProfilesManager = coreServices.getAuthProfilesManager();
    if (authProfilesManager) {
      const agentMetadataStore = coreServices.getAgentMetadataStore();
      const userAgentsStore = coreServices.getUserAgentsStore();

      const verifyProviderAuth = async (
        c: any,
        agentId: string
      ): Promise<{ userId: string; platform: string } | null> => {
        const payload = verifySettingsSessionOrToken(c);
        if (!payload) return null;
        const principal = {
          userId: payload.userId,
          platform: payload.platform,
        };
        if (payload.isAdmin) return principal;

        if (payload.agentId)
          return payload.agentId === agentId ? principal : null;

        if (userAgentsStore) {
          const owns = await userAgentsStore.ownsAgent(
            payload.platform,
            payload.userId,
            agentId
          );
          if (owns) return principal;
        }

        if (agentMetadataStore) {
          const metadata = await agentMetadataStore.getMetadata(agentId);
          const isOwner =
            metadata?.owner?.platform === payload.platform &&
            metadata?.owner?.userId === payload.userId;
          if (isOwner) {
            userAgentsStore
              ?.addAgent(payload.platform, payload.userId, agentId)
              .catch(() => {
                /* best-effort reconciliation */
              });
            return principal;
          }
        }

        return null;
      };

      authRouter.post("/:provider/save-key", async (c: any) => {
        try {
          const providerId = c.req.param("provider");
          const mod = getModelProviderModules().find(
            (m) => m.providerId === providerId
          );
          if (!mod) return c.json({ error: "Unknown provider" }, 404);

          const body = await c.req.json();
          const { agentId, apiKey } = body;
          if (!agentId || !apiKey) {
            return c.json({ error: "Missing agentId or apiKey" }, 400);
          }

          const principal = await verifyProviderAuth(c, agentId);
          if (!principal) {
            return c.json({ error: "Unauthorized" }, 401);
          }

          await authProfilesManager.upsertProfile({
            agentId,
            userId: principal.userId,
            provider: providerId,
            credential: apiKey,
            authType: "api-key",
            label: createAuthProfileLabel(mod.providerDisplayName, apiKey),
            makePrimary: true,
          });

          return c.json({ success: true });
        } catch (error) {
          logger.error("Failed to save API key", { error });
          return c.json({ error: "Failed to save API key" }, 500);
        }
      });

      authRouter.post("/:provider/start", async (c: any) => {
        try {
          const providerId = c.req.param("provider");
          const mod = getModelProviderModules().find(
            (m) => m.providerId === providerId
          );
          if (!mod) return c.json({ error: "Unknown provider" }, 404);

          const supportsDeviceCode =
            mod.authType === "device-code" ||
            mod.supportedAuthTypes?.includes("device-code");
          if (!supportsDeviceCode) {
            return c.json(
              { error: "Provider does not support device code" },
              400
            );
          }

          if (typeof mod.startDeviceCode !== "function") {
            return c.json({ error: "Device code start not implemented" }, 501);
          }

          const body = (await c.req.json().catch(() => ({}))) as {
            agentId?: string;
          };
          const agentId = body.agentId?.trim();
          if (!agentId) return c.json({ error: "Missing agentId" }, 400);

          if (!(await verifyProviderAuth(c, agentId))) {
            return c.json({ error: "Unauthorized" }, 401);
          }

          const result = await mod.startDeviceCode(agentId);
          return c.json(result);
        } catch (error) {
          logger.error("Failed to start device code flow", { error });
          return c.json({ error: "Failed to start device code flow" }, 500);
        }
      });

      authRouter.post("/:provider/poll", async (c: any) => {
        try {
          const providerId = c.req.param("provider");
          const mod = getModelProviderModules().find(
            (m) => m.providerId === providerId
          );
          if (!mod) return c.json({ error: "Unknown provider" }, 404);

          const supportsDeviceCode =
            mod.authType === "device-code" ||
            mod.supportedAuthTypes?.includes("device-code");
          if (!supportsDeviceCode) {
            return c.json(
              { error: "Provider does not support device code" },
              400
            );
          }

          if (typeof mod.pollDeviceCode !== "function") {
            return c.json({ error: "Device code poll not implemented" }, 501);
          }

          const body = (await c.req.json().catch(() => ({}))) as {
            agentId?: string;
            deviceAuthId?: string;
            userCode?: string;
          };
          const agentId = body.agentId?.trim();
          const deviceAuthId = body.deviceAuthId?.trim();
          const userCode = body.userCode?.trim();
          if (!agentId || !deviceAuthId || !userCode) {
            return c.json(
              { error: "Missing agentId, deviceAuthId, or userCode" },
              400
            );
          }

          const principal = await verifyProviderAuth(c, agentId);
          if (!principal) {
            return c.json({ error: "Unauthorized" }, 401);
          }

          const result = await mod.pollDeviceCode(agentId, principal.userId, {
            deviceAuthId,
            userCode,
          });
          return c.json(result);
        } catch (error) {
          logger.error("Failed to poll device code flow", { error });
          return c.json({ error: "Failed to poll device code flow" }, 500);
        }
      });

      authRouter.post("/:provider/logout", async (c: any) => {
        try {
          const providerId = c.req.param("provider");
          const mod = getModelProviderModules().find(
            (m) => m.providerId === providerId
          );
          if (!mod) return c.json({ error: "Unknown provider" }, 404);

          const body = await c.req.json().catch(() => ({}));
          const agentId = body.agentId || c.req.query("agentId");
          if (!agentId) {
            return c.json({ error: "Missing agentId" }, 400);
          }

          const principal = await verifyProviderAuth(c, agentId);
          if (!principal) {
            return c.json({ error: "Unauthorized" }, 401);
          }

          await authProfilesManager.deleteProviderProfiles(
            agentId,
            providerId,
            {
              userId: principal.userId,
              ...(body.profileId ? { profileId: body.profileId } : {}),
            }
          );

          return c.json({ success: true });
        } catch (error) {
          logger.error("Failed to logout", { error });
          return c.json({ error: "Failed to logout" }, 500);
        }
      });
    }

    const agentSettingsStore = coreServices.getAgentSettingsStore();
    const claudeOAuthStateStore = coreServices.getOAuthStateStore();

    const providerStores: Record<
      string,
      { hasCredentials(agentId: string): Promise<boolean> }
    > = {};
    const providerConnectedOverrides: Record<string, boolean> = {};
    for (const mod of providerModules) {
      providerStores[mod.providerId] = mod;
      providerConnectedOverrides[mod.providerId] = mod.hasSystemKey();
      if (mod.getApp) {
        authRouter.route(`/${mod.providerId}`, mod.getApp());
        registeredProviders.push(mod.providerId);
      }
    }

    const providerRegistryService = coreServices.getProviderRegistryService();

    if (providerRegistryService) {
      const systemEnvStore = new SystemEnvStore(coreServices.getSecretStore());
      systemEnvStore.refreshCache().catch((e: any) => {
        logger.error("Failed to refresh system env cache", { error: e });
      });
      setEnvResolver((key: string) => systemEnvStore.resolve(key));
    }

    if (!process.env.ADMIN_PASSWORD) {
      logger.info(
        "An admin password has been auto-generated. For security reasons, it is not logged. Set the ADMIN_PASSWORD env var to use a fixed password."
      );
    }

    {
      const landingRouter = createLandingRoutes();
      app.route("", landingRouter);
      logger.debug("Landing page enabled at :8080/");
    }

    {
      const connectionManager = coreServices
        .getWorkerGateway()
        ?.getConnectionManager();
      if (connectionManager) {
        const agentHistoryRouter = createAgentHistoryRoutes({
          connectionManager,
          chatInstanceManager: chatInstanceManager ?? undefined,
          agentConfigStore: coreServices.getConfigStore(),
          userAgentsStore: coreServices.getUserAgentsStore(),
        });
        app.route("/api/v1/agents/:agentId/history", agentHistoryRouter);
        logger.debug(
          "Agent history routes enabled at :8080/api/v1/agents/{agentId}/history/*"
        );
      }
    }

    if (agentSettingsStore) {
      const agentConfigRouter = createAgentConfigRoutes({
        agentSettingsStore,
        agentConfigStore: coreServices.getConfigStore()!,
        userAgentsStore: coreServices.getUserAgentsStore(),
        queue: coreServices.getQueue(),
        providerStores:
          Object.keys(providerStores).length > 0 ? providerStores : undefined,
        providerConnectedOverrides,
        providerCatalogService: coreServices.getProviderCatalogService(),
        authProfilesManager: coreServices.getAuthProfilesManager(),
        connectionManager: coreServices
          .getWorkerGateway()
          ?.getConnectionManager(),
        grantStore: coreServices.getGrantStore(),
      });
      app.route("/api/v1/agents/:agentId/config", agentConfigRouter);
      logger.debug(
        "Agent config routes enabled at :8080/api/v1/agents/{id}/config"
      );
    }

    if (agentSettingsStore) {
      const claudeOAuthClient = new OAuthClient(CLAUDE_PROVIDER);
      const oauthRouter = createOAuthRoutes({
        providerStores:
          Object.keys(providerStores).length > 0
            ? (providerStores as Record<string, ProviderCredentialStore>)
            : undefined,
        oauthClients: { claude: claudeOAuthClient },
        oauthStateStore: claudeOAuthStateStore,
      });
      authRouter.route("", oauthRouter);
      registeredProviders.push("oauth");
    }

    if (registeredProviders.length > 0) {
      app.route("/api/v1/auth", authRouter);
      logger.debug(
        `Auth routes enabled at :8080/api/v1/auth/* for: ${registeredProviders.join(", ")}`
      );
    }

    const channelBindingService = coreServices.getChannelBindingService();
    if (channelBindingService) {
      const channelBindingRouter = createChannelBindingRoutes({
        channelBindingService,
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getAgentMetadataStore(),
      });
      app.route("/api/v1/agents/:agentId/channels", channelBindingRouter);
      logger.debug(
        "Channel binding routes enabled at :8080/api/v1/agents/{agentId}/channels/*"
      );
    }

    {
      const userAgentsStore = coreServices.getUserAgentsStore();
      const agentMetadataStore = coreServices.getAgentMetadataStore();
      const agentManagementRouter = createAgentRoutes({
        userAgentsStore,
        agentMetadataStore,
        agentSettingsStore,
        channelBindingService,
      });
      app.route("/api/v1/agents", agentManagementRouter);
      logger.debug("Agent management routes enabled at :8080/api/v1/agents/*");
    }
  }

  if (chatInstanceManager) {
    app.route("", createSlackRoutes(chatInstanceManager));
    app.route("", createConnectionWebhookRoutes(chatInstanceManager));
    app.route(
      "",
      createConnectionCrudRoutes(chatInstanceManager, {
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getConfigStore()!,
      })
    );
    logger.debug(
      "Slack and connection routes enabled at :8080/slack/*, :8080/api/v1/connections/*, and :8080/api/v1/webhooks/*"
    );
  }

  app.post("/api/v1/reload", async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }
    const authHeader = c.req.header("Authorization");
    if (authHeader !== `Bearer ${adminPassword}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (!coreServices?.isFileFirstMode()) {
      return c.json(
        { error: "Reload only available in file-first dev mode" },
        400
      );
    }

    try {
      const result = await coreServices.reloadFromFiles();
      return c.json(result);
    } catch (err) {
      logger.error("Reload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Reload failed" }, 500);
    }
  });

  app.get("/internal/status", async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }
    const authHeader = c.req.header("Authorization");
    if (authHeader !== `Bearer ${adminPassword}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const agentConfigStore = coreServices?.getConfigStore();

    const allAgents: AgentMetadata[] = agentConfigStore
      ? await agentConfigStore.listAgents()
      : [];
    const templateAgents = allAgents.filter(
      (a: AgentMetadata) => !a.parentConnectionId
    );
    const sandboxAgents = allAgents.filter(
      (a: AgentMetadata) => !!a.parentConnectionId
    );

    const connections = chatInstanceManager
      ? await chatInstanceManager.listConnections()
      : [];

    const agentDetails = [];
    for (const a of templateAgents) {
      const settings = agentConfigStore
        ? await agentConfigStore.getSettings(a.agentId)
        : null;
      const providers = (settings?.installedProviders || []).map(
        (p: { providerId: string }) => p.providerId
      );
      agentDetails.push({
        agentId: a.agentId,
        name: a.name,
        providers,
        model:
          settings?.modelSelection?.mode === "pinned"
            ? (settings.modelSelection as { pinnedModel?: string })
                .pinnedModel || "pinned"
            : settings?.modelSelection?.mode || "auto",
      });
    }

    return c.json({
      agents: agentDetails,
      connections: connections.map(
        (conn: {
          id: string;
          platform: string;
          templateAgentId?: string;
          metadata?: Record<string, string>;
        }) => ({
          id: conn.id,
          platform: conn.platform,
          status: chatInstanceManager?.getInstance(conn.id)
            ? "connected"
            : "disconnected",
          templateAgentId: conn.templateAgentId || null,
          botUsername: conn.metadata?.botUsername || null,
        })
      ),
      sandboxes: sandboxAgents.map((s: AgentMetadata) => ({
        agentId: s.agentId,
        name: s.name,
        parentConnectionId: s.parentConnectionId || null,
        lastUsedAt: s.lastUsedAt ?? null,
      })),
    });
  });

  registerAutoOpenApiRoutes(app);

  app.doc("/api/docs/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "Lobu API",
      version: "1.0.0",
      description: `
## Overview

The Lobu API allows you to create and interact with AI agents programmatically.

## Authentication

1. Authenticate the agent-creation request with an admin password or CLI access token
2. Create an agent with \`POST /api/v1/agents\` to get a worker token
3. Use the returned worker token as a Bearer token for subsequent agent requests

## Quick Start

\`\`\`bash
# 1. Create an agent (authenticate with admin password or CLI token)
curl -X POST http://localhost:8080/api/v1/agents \\
  -H "Authorization: Bearer $ADMIN_PASSWORD" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "claude"}'

# 2. Send a message (use worker token from step 1)
curl -X POST http://localhost:8080/api/v1/agents/{agentId}/messages \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{"content": "Hello!"}'
\`\`\`

## MCP Servers

Agents can be configured with custom MCP (Model Context Protocol) servers:

\`\`\`json
{
  "mcpServers": {
    "my-http-mcp": { "url": "https://my-mcp.com/sse" },
    "my-stdio-mcp": { "command": "npx", "args": ["-y", "@org/mcp"] }
  }
}
\`\`\`
      `,
    },
    tags: [
      {
        name: "Agents",
        description: "Create, list, update, and delete agents.",
      },
      {
        name: "Messages",
        description:
          "Send messages to agents and subscribe to real-time events (SSE).",
      },
      {
        name: "Configuration",
        description:
          "Agent configuration — LLM providers, Nix packages, domain grants.",
      },
      {
        name: "Channels",
        description:
          "Bind agents to messaging platform channels (Slack, Telegram, WhatsApp).",
      },
      {
        name: "Connections",
        description:
          "Manage Chat SDK-backed platform connections and their lifecycle.",
      },
      {
        name: "Schedules",
        description: "Scheduled wakeups and recurring reminders.",
      },
      {
        name: "History",
        description: "Session messages, stats, and connection status.",
      },
      {
        name: "Auth",
        description:
          "Provider authentication — API keys, OAuth, device code flows.",
      },
      {
        name: "Integrations",
        description: "Browse and install skills and MCP servers.",
      },
    ],
    servers: [
      { url: "http://localhost:8080", description: "Local development" },
    ],
  });

  app.get(
    "/api/docs",
    apiReference({
      url: "/api/docs/openapi.json",
      theme: "kepler",
      layout: "modern",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
    })
  );
  logger.debug("API docs enabled at /api/docs");

  return app;
}

/**
 * Start an HTTP server for the gateway Hono app.
 * Used in standalone mode. In embedded mode, the host creates its own server.
 */
export function startGatewayServer(app: OpenAPIHono, port = 8080): Server {
  const honoListener = getRequestListener(app.fetch);
  const server = createServer(honoListener);
  server.listen(port);
  logger.debug(`Server listening on port ${port}`);
  return server;
}

/**
 * Handle Express-style handler with Hono context
 */
async function handleExpressHandler(c: any, handler: any): Promise<Response> {
  const { req, res, responsePromise } = await createExpressCompatObjects(c);
  await handler(req, res);
  return responsePromise;
}

/**
 * Create Express-compatible request/response objects from Hono context
 */
async function createExpressCompatObjects(c: any, overridePath?: string) {
  let resolveResponse: (response: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  const url = new URL(c.req.url);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    headers[key] = value;
  });

  const req: any = {
    method: c.req.method,
    url: c.req.url,
    path: overridePath || url.pathname,
    headers,
    query: Object.fromEntries(url.searchParams),
    params: c.req.param() || {},
    body: null,
    get: (name: string) => headers[name.toLowerCase()],
    on: () => {
      /* no-op */
    },
  };

  let statusCode = 200;
  const responseHeaders = new Headers();
  let isStreaming = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  const res: any = {
    statusCode: 200,
    destroyed: false,
    writableEnded: false,

    status(code: number) {
      statusCode = code;
      this.statusCode = code;
      return this;
    },

    setHeader(name: string, value: string) {
      responseHeaders.set(name, value);
      return this;
    },

    set(name: string, value: string) {
      responseHeaders.set(name, value);
      return this;
    },

    json(data: any) {
      responseHeaders.set("Content-Type", "application/json");
      resolveResponse?.(
        new Response(JSON.stringify(data), {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    send(data: any) {
      resolveResponse?.(
        new Response(data, {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    text(data: string) {
      resolveResponse?.(
        new Response(data, {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    end(data?: any) {
      this.writableEnded = true;
      if (isStreaming && streamController) {
        if (data) {
          streamController.enqueue(
            typeof data === "string" ? new TextEncoder().encode(data) : data
          );
        }
        streamController.close();
      } else {
        resolveResponse?.(
          new Response(data || null, {
            status: statusCode,
            headers: responseHeaders,
          })
        );
      }
    },

    write(chunk: any) {
      if (!isStreaming) {
        isStreaming = true;
        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            if (chunk) {
              controller.enqueue(
                typeof chunk === "string"
                  ? new TextEncoder().encode(chunk)
                  : chunk
              );
            }
          },
        });
        resolveResponse?.(
          new Response(stream, {
            status: statusCode,
            headers: responseHeaders,
          })
        );
      } else if (streamController) {
        streamController.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        );
      }
      return true;
    },

    flushHeaders() {
      /* no-op */
    },
  };

  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    const contentType = c.req.header("content-type") || "";
    const buffer = await c.req.raw.clone().arrayBuffer();
    if (contentType.includes("application/json")) {
      try {
        req.body = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        req.body = buffer;
      }
    } else {
      req.body = buffer;
    }
  }

  return { req, res, responsePromise };
}

/**
 * Create Express-like adapter for compatibility with module registry
 */
function createExpressAdapter(honoApp: any) {
  return {
    get: (path: string, ...handlers: any[]) => {
      const handler = handlers[handlers.length - 1];
      honoApp.get(path, (c: any) => handleExpressHandler(c, handler));
    },
    post: (path: string, ...handlers: any[]) => {
      const handler = handlers[handlers.length - 1];
      honoApp.post(path, (c: any) => handleExpressHandler(c, handler));
    },
    put: (path: string, ...handlers: any[]) => {
      const handler = handlers[handlers.length - 1];
      honoApp.put(path, (c: any) => handleExpressHandler(c, handler));
    },
    delete: (path: string, ...handlers: any[]) => {
      const handler = handlers[handlers.length - 1];
      honoApp.delete(path, (c: any) => handleExpressHandler(c, handler));
    },
    use: (pathOrHandler: any, handler?: any) => {
      if (typeof pathOrHandler === "function") {
        // no-op
      } else if (handler) {
        honoApp.all(`${pathOrHandler}/*`, (c: any) =>
          handleExpressHandler(c, handler)
        );
      }
    },
  };
}

/**
 * Start the gateway with the provided configuration
 */
export async function startGateway(config: GatewayConfig): Promise<void> {
  logger.info("Starting Lobu Gateway");

  const { startFilteringProxy } = await import("../proxy/proxy-manager.js");
  await startFilteringProxy();

  const { Orchestrator } = await import("../orchestration/index.js");
  const { Gateway } = await import("../gateway-main.js");

  logger.debug("Creating orchestrator");
  const orchestrator = new Orchestrator(config.orchestration);
  await orchestrator.start();
  logger.debug("Orchestrator started");

  const gateway = new Gateway(config);

  const { ApiPlatform } = await import("../api/index.js");
  const apiPlatform = new ApiPlatform();
  gateway.registerPlatform(apiPlatform);
  logger.debug("API platform registered");

  await gateway.start();
  logger.debug("Gateway started");

  // Get core services
  const coreServices = gateway.getCoreServices();

  // Wire grant store to HTTP proxy for domain grant checks
  const grantStore = coreServices.getGrantStore();
  if (grantStore) {
    const { setProxyGrantStore } = await import("../proxy/http-proxy.js");
    setProxyGrantStore(grantStore);
    logger.debug("Grant store connected to HTTP proxy");
  }

  // Wire policy store + egress judge into the HTTP proxy for judged-domain
  // rules declared by skills or agent config.
  const policyStore = coreServices.getPolicyStore();
  if (policyStore) {
    const { setProxyPolicyStore } = await import("../proxy/http-proxy.js");
    setProxyPolicyStore(policyStore);
    logger.debug("Policy store connected to HTTP proxy");
  }

  await orchestrator.injectCoreServices(
    coreServices.getSecretStore(),
    coreServices.getProviderCatalogService(),
    coreServices.getGrantStore() ?? undefined,
    coreServices.getPolicyStore() ?? undefined
  );
  logger.debug("Orchestrator configured with core services");

  // Wire reload-from-files notifications to the deployment manager's
  // grant-sync cache so that changes to `networkConfig.allowedDomains` or
  // `preApprovedTools` in lobu.toml take effect on the next message —
  // without this, the cached hash short-circuits both grants AND revokes.
  const deploymentManager = orchestrator.getDeploymentManager();
  coreServices.onReloadFromFiles((agentIds: string[]) => {
    for (const agentId of agentIds) {
      deploymentManager.invalidateGrantSyncCache(agentId);
    }
    logger.debug(
      `Invalidated grant-sync cache for ${agentIds.length} reloaded agent(s)`
    );
  });

  const { ChatInstanceManager, ChatResponseBridge } = await import(
    "../connections/index.js"
  );
  const chatInstanceManager = new ChatInstanceManager();
  try {
    await chatInstanceManager.initialize(coreServices);

    for (const adapter of chatInstanceManager.createPlatformAdapters()) {
      gateway.registerPlatform(adapter);
    }
    logger.debug("ChatInstanceManager initialized");

    const fileLoadedAgents = coreServices.getFileLoadedAgents();
    if (fileLoadedAgents.length > 0) {
      for (const agent of fileLoadedAgents) {
        if (!agent.platforms?.length) continue;
        // Look up by stable id — `(platform, templateAgentId)` alone collapses
        // multi-platform agents (e.g. two Slack workspaces) into one seed.
        const existingForAgent = await chatInstanceManager.listConnections({
          platform: undefined,
          templateAgentId: agent.agentId,
        });
        const existingIds = new Set(existingForAgent.map((c: any) => c.id));
        for (const platform of agent.platforms) {
          if (existingIds.has(platform.id)) continue;
          try {
            await chatInstanceManager.addConnection(
              platform.type,
              agent.agentId,
              { platform: platform.type as any, ...platform.config },
              { allowGroups: true },
              {},
              platform.id
            );
            logger.debug(
              `Created ${platform.type} platform for agent "${agent.agentId}" as "${platform.id}"`
            );
          } catch (err) {
            logger.error(
              `Failed to create ${platform.type} platform for agent "${agent.agentId}"`,
              { error: err instanceof Error ? err.message : String(err) }
            );
          }
        }
      }
    }

    const unifiedConsumer = gateway.getUnifiedConsumer();
    if (unifiedConsumer) {
      const chatResponseBridge = new ChatResponseBridge(chatInstanceManager);
      unifiedConsumer.setChatResponseBridge(chatResponseBridge);
      logger.debug("ChatResponseBridge wired to unified thread consumer");
    }
  } catch (error) {
    logger.warn(
      { error: String(error) },
      "ChatInstanceManager initialization failed — connections feature disabled"
    );
  }

  if (!httpServer) {
    const app = createGatewayApp({
      secretProxy: coreServices.getSecretProxy(),
      workerGateway: coreServices.getWorkerGateway(),
      mcpProxy: coreServices.getMcpProxy(),
      interactionService: coreServices.getInteractionService(),
      platformRegistry: gateway.getPlatformRegistry(),
      coreServices,
      chatInstanceManager,
    });
    httpServer = startGatewayServer(app);
  }

  logger.info("Lobu Gateway is running!");

  const cleanup = async () => {
    logger.info("Shutting down gateway...");

    // Hard deadline: force exit after 30s if graceful shutdown stalls
    const hardDeadline = setTimeout(() => {
      logger.error("Graceful shutdown timed out after 30s, forcing exit");
      process.exit(1);
    }, 30_000);
    hardDeadline.unref();

    await chatInstanceManager.shutdown();
    await orchestrator.stop();
    await gateway.stop();
    if (httpServer) {
      httpServer.close();
    }
    logger.info("Gateway shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.on("SIGUSR1", () => {
    const status = gateway.getStatus();
    logger.info("Health check:", JSON.stringify(status, null, 2));
  });
}
