#!/usr/bin/env bun

import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@peerbot/core";
import { apiReference } from "@scalar/hono-api-reference";
import { cors } from "hono/cors";
import type { GatewayConfig } from "../config";
import { registerAutoOpenApiRoutes } from "../routes/openapi-auto";
import type { SlackConfig } from "../slack";
import type { WhatsAppConfig } from "../whatsapp/config";

const logger = createLogger("gateway-startup");

let httpServer: ReturnType<typeof serve> | null = null;

/**
 * Setup Hono server with all routes on port 8080
 */
function setupServer(
  anthropicProxy: any,
  workerGateway: any,
  mcpProxy: any,
  fileHandler?: any,
  sessionManager?: any,
  interactionService?: any,
  platformRegistry?: any,
  coreServices?: any
) {
  if (httpServer) return;

  const app = new OpenAPIHono();

  // Global middleware
  app.use("*", cors());

  // Health endpoints
  app.get("/health", (c) => {
    const mode =
      process.env.PEERBOT_MODE ||
      (process.env.DEPLOYMENT_MODE === "docker" ? "local" : "cloud");

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
      anthropicProxy: !!anthropicProxy,
    });
  });

  app.get("/ready", (c) => c.json({ ready: true }));

  // Prometheus metrics endpoint
  app.get("/metrics", async (c) => {
    const { getMetricsText } = await import("../metrics/prometheus");
    c.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return c.text(getMetricsText());
  });

  // Anthropic proxy (Hono)
  if (anthropicProxy) {
    app.route("/api/anthropic", anthropicProxy.getApp());
    logger.info("Anthropic proxy enabled at :8080/api/anthropic");
  }

  // Worker Gateway routes (Hono)
  if (workerGateway) {
    app.route("/worker", workerGateway.getApp());
    logger.info("Worker gateway routes enabled at :8080/worker/*");
  }

  // Register module endpoints
  const { moduleRegistry } = require("@peerbot/core");
  if (moduleRegistry.registerHonoEndpoints) {
    moduleRegistry.registerHonoEndpoints(app);
  } else {
    // Create express-like adapter for module registry
    const expressApp = createExpressAdapter(app);
    moduleRegistry.registerEndpoints(expressApp);
  }
  logger.info("Module endpoints registered");

  // MCP proxy routes (Hono)
  if (mcpProxy) {
    // Handle root path requests with X-Mcp-Id header
    app.all("/", async (c, next) => {
      if (mcpProxy.isMcpRequest(c)) {
        // Forward to MCP proxy - need to handle directly since it's at root
        return mcpProxy.getApp().fetch(c.req.raw);
      }
      return next();
    });
    // Mount MCP proxy at /mcp/*
    app.route("/mcp", mcpProxy.getApp());
    logger.info("MCP proxy routes enabled at :8080/mcp/*");
  }

  // File routes (already Hono)
  if (fileHandler && sessionManager) {
    const { createFileRoutes } = require("../routes/internal/files");
    const fileRouter = createFileRoutes(fileHandler, sessionManager);
    app.route("/internal/files", fileRouter);
    logger.info("File routes enabled at :8080/internal/files/*");
  }

  // History routes (already Hono)
  {
    const { createHistoryRoutes } = require("../routes/internal/history");
    const historyRouter = createHistoryRoutes();
    app.route("/internal", historyRouter);
    logger.info("History routes enabled at :8080/internal/history");
  }

  // Schedule routes (worker scheduling endpoints)
  if (coreServices) {
    const scheduledWakeupService = coreServices.getScheduledWakeupService();
    if (scheduledWakeupService) {
      const { createScheduleRoutes } = require("../routes/internal/schedule");
      const scheduleRouter = createScheduleRoutes(scheduledWakeupService);
      app.route("", scheduleRouter);
      logger.info("Schedule routes enabled at :8080/internal/schedule");
    }
  }

  // Interaction routes (already Hono)
  if (interactionService) {
    const {
      createInteractionRoutes,
    } = require("../routes/internal/interactions");
    const internalRouter = createInteractionRoutes(interactionService);
    app.route("", internalRouter);
    logger.info("Internal interaction routes enabled");
  }

  // Messaging routes (already Hono)
  if (platformRegistry) {
    const { createMessagingRoutes } = require("../routes/public/messaging");
    const messagingRouter = createMessagingRoutes(platformRegistry);
    app.route("", messagingRouter);
    logger.info("Messaging routes enabled at :8080/api/v1/messaging/send");
  }

  // Agent API routes (direct API access)
  if (coreServices) {
    const queueProducer = coreServices.getQueueProducer();
    const sessionMgr = coreServices.getSessionManager();
    const interactionSvc = coreServices.getInteractionService();
    const publicUrl = coreServices.getPublicGatewayUrl();

    if (queueProducer && sessionMgr && interactionSvc) {
      // Agent API (Hono with OpenAPI docs)
      const { createAgentApi } = require("../routes/public/agent");
      const agentApi = createAgentApi(
        queueProducer,
        sessionMgr,
        interactionSvc,
        publicUrl
      );
      app.route("", agentApi);
      logger.info(
        "Agent API enabled at :8080/api/v1/agents/* with docs at :8080/api/docs"
      );
    }
  }

  if (coreServices) {
    // Mount OAuth modules (Hono)
    const claudeOAuthModule = coreServices.getClaudeOAuthModule();
    if (claudeOAuthModule) {
      app.route("/api/v1/auth/claude", claudeOAuthModule.getApp());
      logger.info("Claude OAuth routes enabled at :8080/api/v1/auth/claude/*");
    }

    const mcpOAuthModule = coreServices.getMcpOAuthModule();
    if (mcpOAuthModule) {
      app.route("/api/v1/auth/mcp", mcpOAuthModule.getApp());
      logger.info("MCP OAuth routes enabled at :8080/api/v1/auth/mcp/*");
    }

    // Settings routes (magic link configuration)
    const agentSettingsStore = coreServices.getAgentSettingsStore();
    if (agentSettingsStore) {
      const { createSettingsRoutes } = require("../routes/public/settings");
      const { ClaudeOAuthClient } = require("../auth/oauth/claude-client");

      // Build provider stores and OAuth clients
      const claudeCredentialStore = coreServices.getClaudeCredentialStore();
      const claudeOAuthStateStore = coreServices.getClaudeOAuthStateStore();
      const claudeOAuthClient = new ClaudeOAuthClient();

      // Get GitHub App auth from Git Filesystem module (if configured)
      const gitFilesystemModule = coreServices.getGitFilesystemModule();
      const githubAuth = gitFilesystemModule?.getGitHubAuth() || undefined;
      const githubAppInstallUrl = process.env.GITHUB_APP_INSTALL_URL;

      const settingsRouter = createSettingsRoutes({
        agentSettingsStore,
        providerStores: claudeCredentialStore
          ? { claude: claudeCredentialStore }
          : undefined,
        oauthClients: { claude: claudeOAuthClient },
        oauthStateStore: claudeOAuthStateStore,
        githubAuth,
        githubAppInstallUrl,
        scheduledWakeupService: coreServices.getScheduledWakeupService(),
        // GitHub OAuth for user identification
        githubOAuthClientId: process.env.GITHUB_CLIENT_ID,
        githubOAuthClientSecret: process.env.GITHUB_CLIENT_SECRET,
        publicGatewayUrl: process.env.PUBLIC_GATEWAY_URL,
      });
      app.route("", settingsRouter);
      logger.info(
        "Settings routes enabled at :8080/settings and :8080/api/v1/settings"
      );
    }

    // Channel binding routes (mount under agent API)
    const channelBindingService = coreServices.getChannelBindingService();
    if (channelBindingService) {
      const {
        createChannelBindingRoutes,
      } = require("../routes/public/channels");
      const channelBindingRouter = createChannelBindingRoutes({
        channelBindingService,
      });
      // Mount as a sub-router under /api/v1/agents/:agentId/channels
      app.route("/api/v1/agents/:agentId/channels", channelBindingRouter);
      logger.info(
        "Channel binding routes enabled at :8080/api/v1/agents/{agentId}/channels/*"
      );
    }
  }

  // Auto-register any non-openapi routes so everything shows up in the schema
  registerAutoOpenApiRoutes(app);

  // OpenAPI Documentation
  app.doc("/api/docs/openapi.json", {
    openapi: "3.0.0",
    info: {
      title: "Peerbot API",
      version: "1.0.0",
      description: `
## Overview

The Peerbot API allows you to create and interact with AI agents programmatically.

## Authentication

1. Create an agent with \`POST /api/v1/agents\` to get a token
2. Use the token as a Bearer token for all subsequent requests

## Quick Start

\`\`\`bash
# 1. Create an agent
curl -X POST http://localhost:8080/api/v1/agents \\
  -H "Content-Type: application/json" \\
  -d '{"provider": "claude"}'

# 2. Send a message (use token from step 1)
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
        description:
          "Create and manage AI agents. Each agent has its own session, can receive messages, and stream responses via SSE.",
      },
      {
        name: "Channels",
        description:
          "Bind agents to platform channels (Slack, WhatsApp). Messages from bound channels are routed to the agent.",
      },
      {
        name: "Messaging",
        description:
          "Send messages through platform adapters (Slack, WhatsApp, API).",
      },
      {
        name: "Settings",
        description:
          "Agent configuration via magic link. Manage model preferences, network access, skills, and OAuth providers.",
      },
      {
        name: "Skills",
        description:
          "Browse and manage agent skills from the skills.sh registry.",
      },
      {
        name: "GitHub",
        description: "GitHub App integration for repository access and OAuth.",
      },
      {
        name: "Schedules",
        description: "Manage scheduled agent wakeups and reminders.",
      },
      {
        name: "Auth",
        description: "OAuth authentication flows for Claude and MCP servers.",
      },
      {
        name: "Internal",
        description:
          "Worker-facing routes for file access, history, and interactions. Not for external use.",
      },
      {
        name: "System",
        description: "Health checks, metrics, and system status.",
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
  logger.info("API docs enabled at :8080/api/docs");

  // Start the server
  const port = 8080;
  httpServer = serve({
    fetch: app.fetch,
    port,
  });

  logger.info(`Hono server listening on port ${port}`);
}

/**
 * Handle Express-style handler with Hono context
 */
async function handleExpressHandler(c: any, handler: any): Promise<Response> {
  const { req, res, responsePromise } = createExpressCompatObjects(c);
  await handler(req, res);
  return responsePromise;
}

/**
 * Create Express-compatible request/response objects from Hono context
 */
function createExpressCompatObjects(c: any, overridePath?: string) {
  let resolveResponse: (response: Response) => void;
  const responsePromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  const url = new URL(c.req.url);
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value: string, key: string) => {
    headers[key] = value;
  });

  // Express-compatible request object
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
      // Express event listener stub - not used in Hono compat layer
    },
  };

  // Response state
  let statusCode = 200;
  const responseHeaders = new Headers();
  let isStreaming = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  // Express-compatible response object
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
      resolveResponse!(
        new Response(JSON.stringify(data), {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    send(data: any) {
      resolveResponse!(
        new Response(data, {
          status: statusCode,
          headers: responseHeaders,
        })
      );
    },

    text(data: string) {
      resolveResponse!(
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
        resolveResponse!(
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
        resolveResponse!(
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
      // No-op for compatibility
    },
  };

  // Parse body for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
    const contentType = c.req.header("content-type") || "";
    c.req.raw
      .clone()
      .arrayBuffer()
      .then((buffer: ArrayBuffer) => {
        if (contentType.includes("application/json")) {
          try {
            req.body = JSON.parse(new TextDecoder().decode(buffer));
          } catch {
            req.body = buffer;
          }
        } else {
          req.body = buffer;
        }
      });
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
        // Global middleware - skip for now
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
export async function startGateway(
  config: GatewayConfig,
  slackConfig: SlackConfig | null,
  whatsappConfig?: WhatsAppConfig | null
): Promise<void> {
  logger.info("Starting Peerbot Gateway");

  // Start filtering proxy for worker network isolation (if enabled)
  const { startFilteringProxy } = await import("../proxy/proxy-manager");
  await startFilteringProxy();

  // Import dependencies
  const { Orchestrator } = await import("../orchestration");
  const { Gateway } = await import("../gateway-main");

  // Create and start orchestrator
  logger.debug("Creating orchestrator", { mode: process.env.DEPLOYMENT_MODE });
  const orchestrator = new Orchestrator(config.orchestration);
  await orchestrator.start();
  logger.info("Orchestrator started");

  // Create Gateway
  const gateway = new Gateway(config);

  const agentOptions = {
    allowedTools: config.claude.allowedTools,
    disallowedTools: config.claude.disallowedTools,
    model: config.claude.model,
    timeoutMinutes: config.claude.timeoutMinutes,
  };

  // Register Slack platform if configured
  let slackPlatform: any = null;
  if (slackConfig) {
    const { SlackPlatform } = await import("../slack");

    const slackPlatformConfig = {
      slack: slackConfig,
      logLevel: config.logLevel as any,
      health: config.health,
    };

    slackPlatform = new SlackPlatform(
      slackPlatformConfig,
      agentOptions,
      config.sessionTimeoutMinutes
    );
    gateway.registerPlatform(slackPlatform);
    logger.info("Slack platform registered");
  }

  // Register WhatsApp platform if enabled
  let whatsappPlatform: any = null;
  logger.debug("WhatsApp config", { enabled: whatsappConfig?.enabled });
  if (whatsappConfig?.enabled) {
    const { WhatsAppPlatform } = await import("../whatsapp");

    const whatsappPlatformConfig = {
      whatsapp: whatsappConfig,
    };

    whatsappPlatform = new WhatsAppPlatform(
      whatsappPlatformConfig,
      agentOptions as any,
      config.sessionTimeoutMinutes
    );
    gateway.registerPlatform(whatsappPlatform);
    logger.info("WhatsApp platform registered");
  }

  // Register API platform (always enabled)
  const { ApiPlatform } = await import("../api");
  const apiPlatform = new ApiPlatform();
  gateway.registerPlatform(apiPlatform);
  logger.info("API platform registered");

  // Start gateway
  await gateway.start();
  logger.info("Gateway started");

  // Get core services
  const coreServices = gateway.getCoreServices();

  // Inject core services into orchestrator
  await orchestrator.injectCoreServices(
    coreServices.getClaudeCredentialStore(),
    config.anthropicProxy.anthropicApiKey
  );
  logger.info("Orchestrator configured with core services");

  // Get file handler from Slack platform (if available)
  const fileHandler = slackPlatform?.getFileHandler() ?? null;
  const sessionManager = coreServices.getSessionManager();

  // Setup server on port 8080
  setupServer(
    coreServices.getAnthropicProxy(),
    coreServices.getWorkerGateway(),
    coreServices.getMcpProxy(),
    fileHandler,
    sessionManager,
    coreServices.getInteractionService(),
    gateway.getPlatformRegistry(),
    coreServices
  );

  logger.info("Peerbot Gateway is running!");

  // Setup graceful shutdown
  const cleanup = async () => {
    logger.info("Shutting down gateway...");
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
