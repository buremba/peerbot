#!/usr/bin/env bun

import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@lobu/core";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AgentMetadata } from "../auth/agent-metadata-store.js";
import { takePendingTool } from "../auth/mcp/pending-tool-store.js";
import { setEnvResolver } from "../auth/mcp/string-substitution.js";
import { createAuthProfileLabel } from "../auth/settings/auth-profiles-manager.js";
import { SystemEnvStore } from "../auth/system-env-store.js";
import { createPostgresAppInstallationStore } from "../../lobu/stores/app-installation-store.js";
import { getMetricsText } from "../metrics/prometheus.js";
import { getModelProviderModules } from "../modules/module-system.js";
import { createAudioRoutes } from "../routes/internal/audio.js";
import { createDeviceAuthRoutes } from "../routes/internal/device-auth.js";
import { createFileRoutes } from "../routes/internal/files.js";
import { createConversationsRoutes } from "../routes/internal/conversations.js";
import { createHistoryRoutes } from "../routes/internal/history.js";
import { createImageRoutes } from "../routes/internal/images.js";
import { createInteractionRoutes } from "../routes/internal/interactions.js";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto.js";
import { createAgentApi } from "../routes/public/agent.js";
import {
  type AppWebhookProvider,
  createAppWebhookRoutes,
  createDefaultAppWebhookSecretResolver,
  createGithubAppWebhookProvider,
  createJiraAppWebhookProvider,
  createLinearAppWebhookProvider,
} from "../routes/public/app-webhooks.js";
import { createAppInstallRoutes } from "../routes/public/app-install.js";
import { resolveInstallOrgId } from "../routes/public/slack.js";
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
  type AuthProvider,
  setAuthProvider,
  verifySettingsSessionOrToken,
} from "../routes/public/settings-auth.js";
import { createSlackRoutes } from "../routes/public/slack.js";

const logger = createLogger("gateway-startup");

interface CreateGatewayAppOptions {
  secretProxy: any;
  workerGateway: any;
  mcpProxy: any;
  interactionService?: any;
  platformRegistry?: any;
  coreServices?: any;
  chatInstanceManager?:
    | import("../connections/chat-instance-manager.js").ChatInstanceManager
    | null;
  /** Custom auth provider for embedded mode. When set, gateway delegates auth to this function instead of using cookie-based sessions. */
  authProvider?: AuthProvider;
}

/**
 * Create the Hono app with all gateway routes.
 * Returns the app without starting an HTTP server — the caller mounts it on its
 * own server (embedded mode; see `src/server.ts` / `src/lobu/gateway.ts`).
 */
export function createGatewayApp(
	options: CreateGatewayAppOptions,
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
		}),
  );
  app.use(
    "*",
    cors({
      origin: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(",")
        : [],
      credentials: true,
		}),
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
      wsUrl: `ws://localhost:${process.env.PORT || process.env.GATEWAY_PORT || "8787"}/ws`,
      secretProxy: !!secretProxy,
    });
  });

  app.get("/ready", (c) => c.json({ ready: true }));

  // Metrics auth is optional so existing ServiceMonitor configs continue to scrape.
  app.get("/metrics", async (c) => {
    const metricsAuthToken = process.env.METRICS_AUTH_TOKEN;
    if (metricsAuthToken) {
      const authHeader = c.req.header("Authorization");
      if (authHeader !== `Bearer ${metricsAuthToken}`) {
        return c.text("Unauthorized", 401);
      }
    }
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
			"MCP OAuth callback route enabled at :8080/mcp/oauth/callback",
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
			coreServices.getPublicGatewayUrl(),
    );
    app.route("/internal/files", fileRouter);

    app.route("", createPublicFileRoutes(artifactStore));
    logger.debug(
			"File routes enabled at :8080/internal/files/* and /api/v1/files/*",
    );
  }

  {
    const historyRouter = createHistoryRoutes();
    app.route("/internal", historyRouter);
    logger.debug("History routes enabled at :8080/internal/history");
  }

  {
    const conversationsRouter = createConversationsRoutes();
    app.route("/internal", conversationsRouter);
    logger.debug(
      "Conversation routes enabled at :8080/internal/conversations/*"
    );
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
				"Device auth routes enabled at :8080/internal/device-auth/*",
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
        externalAuthClient: coreServices.getExternalAuthClient(),
        agentSettingsStore: coreServices.getAgentSettingsStore(),
        agentConfigStore: coreServices.getConfigStore(),
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getAgentMetadataStore(),
        platformRegistry,
        approveToolCall: async (requestId: string, decision: string) => {
          const expiresMap = {
            "1h": Date.now() + 3_600_000,
            "24h": Date.now() + 86_400_000,
            always: null,
          } satisfies Record<string, number | null>;
          const isGrantDecision = (
            value: string,
          ): value is keyof typeof expiresMap => value in expiresMap;
          if (decision !== "deny" && !isGrantDecision(decision)) {
            return { success: false, error: "Invalid decision" };
          }

          // DELETE ... RETURNING atomically claims the pending invocation
          // so a retry of POST /api/v1/agents/approve (CLI re-tries,
          // double-clicks, Slack webhook retries) cannot double-execute the
          // tool. The Slack/Telegram interaction-bridge path uses the same
          // helper.
          const pending = await takePendingTool(requestId);
          if (!pending)
            return { success: false, error: "Request not found or expired" };
          if (!pending.organizationId) {
            return {
              success: false,
              error: "Tool approval missing organization context",
            };
          }
          const pattern = `/mcp/${pending.mcpId}/tools/${pending.toolName}`;
          if (decision === "deny") {
            await approveGrantStore?.grant(
              pending.agentId,
              pattern,
              null,
              true,
            );
            return { success: true };
          }
          await approveGrantStore?.grant(
            pending.agentId,
            pattern,
            expiresMap[decision],
          );
          if (approveMcpProxy) {
            const result = await approveMcpProxy.executeToolDirect(
              pending.agentId,
              pending.userId,
              pending.mcpId,
              pending.toolName,
              pending.args,
              { organizationId: pending.organizationId },
            );
            return { success: true, result } as any;
          }
          return { success: true };
        },
      });
      app.route("", agentApi);
      logger.debug(
				"Agent API enabled at :8080/api/v1/agents/* with docs at :8080/api/docs",
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
				agentId: string,
      ): Promise<{ userId: string; platform: string } | null> => {
        const payload = await verifySettingsSessionOrToken(c);
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
						agentId,
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

      // Each provider-auth handler does the same envelope work: resolve the
      // `:provider` module (404 if unknown), then a try/catch that logs and
      // returns a 500 with `errorLabel`. Factor that out so the bodies are
      // just the per-route logic.
      const withProviderAndAuth =
        (
          errorLabel: string,
          handler: (args: {
            c: any;
            mod: ReturnType<typeof getModelProviderModules>[number];
            providerId: string;
					}) => Promise<Response>,
        ) =>
        async (c: any): Promise<Response> => {
          try {
            const providerId = c.req.param("provider");
            const mod = getModelProviderModules().find(
							(m) => m.providerId === providerId,
            );
            if (!mod) return c.json({ error: "Unknown provider" }, 404);
            return await handler({ c, mod, providerId });
          } catch (error) {
            logger.error(errorLabel, { error });
            return c.json({ error: errorLabel }, 500);
          }
        };

      const requireDeviceCode = (
        c: any,
        mod: ReturnType<typeof getModelProviderModules>[number],
				method: "startDeviceCode" | "pollDeviceCode",
      ): Response | null => {
        const supportsDeviceCode =
          mod.authType === "device-code" ||
          mod.supportedAuthTypes?.includes("device-code");
        if (!supportsDeviceCode) {
          return c.json(
            { error: "Provider does not support device code" },
						400,
          );
        }
        if (typeof mod[method] !== "function") {
          return c.json(
            {
              error:
                method === "startDeviceCode"
                  ? "Device code start not implemented"
                  : "Device code poll not implemented",
            },
						501,
          );
        }
        return null;
      };

      authRouter.post(
        "/:provider/save-key",
        withProviderAndAuth(
          "Failed to save API key",
          async ({ c, mod, providerId }) => {
            const body = await c.req.json().catch(() => null);
            if (!body || typeof body !== "object") {
              return c.json({ error: "Invalid JSON body" }, 400);
            }
            const { agentId, apiKey } = body as {
              agentId?: string;
              apiKey?: string;
            };
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
					},
				),
      );

      authRouter.post(
        "/:provider/start",
        withProviderAndAuth(
          "Failed to start device code flow",
          async ({ c, mod }) => {
            const unsupported = requireDeviceCode(c, mod, "startDeviceCode");
            if (unsupported) return unsupported;

            const body = (await c.req.json().catch(() => ({}))) as {
              agentId?: string;
            };
            const agentId = body.agentId?.trim();
            if (!agentId) return c.json({ error: "Missing agentId" }, 400);

            if (!(await verifyProviderAuth(c, agentId))) {
              return c.json({ error: "Unauthorized" }, 401);
            }

            const result = await mod.startDeviceCode!(agentId);
            return c.json(result);
					},
				),
      );

      authRouter.post(
        "/:provider/poll",
        withProviderAndAuth(
          "Failed to poll device code flow",
          async ({ c, mod }) => {
            const unsupported = requireDeviceCode(c, mod, "pollDeviceCode");
            if (unsupported) return unsupported;

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
								400,
              );
            }

            const principal = await verifyProviderAuth(c, agentId);
            if (!principal) {
              return c.json({ error: "Unauthorized" }, 401);
            }

						const result = await mod.pollDeviceCode!(
							agentId,
							principal.userId,
							{
              deviceAuthId,
              userCode,
							},
						);
            return c.json(result);
					},
				),
      );

      authRouter.post(
        "/:provider/logout",
				withProviderAndAuth("Failed to logout", async ({ c, providerId }) => {
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
						},
            );

            return c.json({ success: true });
				}),
      );
    }

    const agentSettingsStore = coreServices.getAgentSettingsStore();

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
          agentConfigStore: coreServices.getConfigStore(),
          userAgentsStore: coreServices.getUserAgentsStore(),
        });
        app.route("/api/v1/agents/:agentId/history", agentHistoryRouter);
        logger.debug(
					"Agent history routes enabled at :8080/api/v1/agents/{agentId}/history/*",
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
				"Agent config routes enabled at :8080/api/v1/agents/{id}/config",
      );
    }

    if (registeredProviders.length > 0) {
      app.route("/api/v1/auth", authRouter);
      logger.debug(
				`Auth routes enabled at :8080/api/v1/auth/* for: ${registeredProviders.join(", ")}`,
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
				"Channel binding routes enabled at :8080/api/v1/agents/{agentId}/channels/*",
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

    // Shared multi-tenant app-webhook router (app-installation design §4.3): one
    // public endpoint per provider for an installed Lobu App. A provider plugin
    // is registered only when its Lobu app id is configured (GitHub App id, or
    // the provider's OAuth client id) — otherwise the route is present but
    // reports the provider unknown (404), since a missing app id can't match any
    // installation. GitHub/Jira/Linear share one schema-driven HMAC verify;
    // Slack stays a custom plugin (timestamped signing base).
    const appWebhookSecretStore = coreServices.getSecretStore();
    const appWebhookProviders: AppWebhookProvider[] = [];
    const githubAppId = process.env.GITHUB_APP_ID;
    if (githubAppId) {
      appWebhookProviders.push(
        createGithubAppWebhookProvider({
          appId: githubAppId,
          // Land event-complete deliveries (stars) directly instead of re-polling.
          // Default on; GITHUB_WEBHOOK_STORE_EVENTS=false makes every delivery a trigger.
          storeWebhookEvents: process.env.GITHUB_WEBHOOK_STORE_EVENTS !== "false",
        }),
      );
    }
    const jiraAppId = process.env.JIRA_CLIENT_ID;
    if (jiraAppId) {
      appWebhookProviders.push(createJiraAppWebhookProvider({ appId: jiraAppId }));
    }
    const linearAppId = process.env.LINEAR_CLIENT_ID;
    if (linearAppId) {
      appWebhookProviders.push(createLinearAppWebhookProvider({ appId: linearAppId }));
    }
    app.route(
      "",
      createAppWebhookRoutes({
        installationStore: createPostgresAppInstallationStore(),
        secretStore: appWebhookSecretStore,
        providers: appWebhookProviders,
        resolveAppWebhookSecret:
          createDefaultAppWebhookSecretResolver(appWebhookSecretStore),
      }),
    );

    // GitHub App post-install callback (app-installation design §4.4): records
    // the installation + links the org's github connection to it. Session-bound
    // org resolution shares the Slack install flow's resolver.
    app.route(
      "",
      createAppInstallRoutes({
        installationStore: createPostgresAppInstallationStore(),
        resolveInstallOrgId,
        getPublicGatewayUrl: () => coreServices.getPublicGatewayUrl(),
      }),
    );
    app.route(
      "",
      createConnectionCrudRoutes(chatInstanceManager, {
        userAgentsStore: coreServices.getUserAgentsStore(),
        agentMetadataStore: coreServices.getConfigStore()!,
			}),
    );
    logger.debug(
			"Slack and connection routes enabled at :8080/slack/*, :8080/api/v1/connections/*, and :8080/api/v1/webhooks/*",
    );
  }

  async function hasDevRouteAccess(c: any): Promise<boolean> {
    if (await verifySettingsSessionOrToken(c)) return true;
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    const externalAuthClient = coreServices?.getExternalAuthClient?.();
    if (!externalAuthClient) return false;
    try {
      const userInfo = await externalAuthClient.fetchUserInfo(token);
      return Boolean(userInfo?.sub);
    } catch {
      return false;
    }
  }

  app.get("/internal/status", async (c) => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }
    if (!(await hasDevRouteAccess(c))) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const agentConfigStore = coreServices?.getConfigStore();

    const allAgents: AgentMetadata[] = agentConfigStore
      ? await agentConfigStore.listAgents()
      : [];

    const connections = chatInstanceManager
      ? await chatInstanceManager.listConnections()
      : [];

    const agentDetails = [];
    for (const a of allAgents) {
      const settings = agentConfigStore
        ? await agentConfigStore.getSettings(a.agentId)
        : null;
      const providers = (settings?.installedProviders || []).map(
				(p: { providerId: string }) => p.providerId,
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
          agentId?: string;
          metadata?: Record<string, string>;
        }) => ({
          id: conn.id,
          platform: conn.platform,
          status: chatInstanceManager?.getInstance(conn.id)
            ? "connected"
            : "disconnected",
          agentId: conn.agentId || null,
          botUsername: conn.metadata?.botUsername || null,
				}),
      ),
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

1. Authenticate the agent-creation request with a settings session or CLI access token
2. Create an agent with \`POST /api/v1/agents\` to get a worker token
3. Use the returned worker token as a Bearer token for subsequent agent requests

## Quick Start

\`\`\`bash
# 1. Create an agent (authenticate with a CLI token)
curl -X POST http://localhost:8787/api/v1/agents \\
  -H "Authorization: Bearer $LOBU_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "claude"}'

# 2. Send a message (use worker token from step 1)
curl -X POST http://localhost:8787/api/v1/agents/{agentId}/messages \\
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
      { url: "http://localhost:8787", description: "Local development" },
    ],
  });

  app.get(
    "/api/docs",
    apiReference({
      url: "/api/docs/openapi.json",
      theme: "kepler",
      layout: "modern",
      defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
		}),
  );
  logger.debug("API docs enabled at /api/docs");

  return app;
}
