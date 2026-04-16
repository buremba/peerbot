import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  type AgentConfigStore,
  createLogger,
  createRootSpan,
  findTemplateAgentId,
  generateWorkerToken,
  type InstalledProvider,
  type McpServerConfig,
  type NetworkConfig,
  normalizeDomainPatterns,
  verifyWorkerToken,
} from "@lobu/core";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  createApiAuthMiddleware,
  TOKEN_EXPIRATION_MS,
} from "../../auth/api-auth-middleware";
import type { CliTokenService } from "../../auth/cli/token-service";
import type { ExternalAuthClient } from "../../auth/external/client";
import type { AgentSettingsStore } from "../../auth/settings/agent-settings-store";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer";
import { getModelProviderModules } from "../../modules/module-system";
import type { PlatformRegistry } from "../../platform";
import { resolveAgentOptions } from "../../services/platform-helpers";
import type { ISessionManager, ThreadSession } from "../../session";

const logger = createLogger("agent-api");

// =============================================================================
// Constants
// =============================================================================

const MAX_CONNECTIONS_PER_AGENT = 5;
const MAX_TOTAL_CONNECTIONS = 1000;

// SSE connection tracking
const sseConnections = new Map<string, Set<any>>();
const sseEventBacklog = new Map<
  string,
  Array<{ event: string; data: unknown; timestamp: number }>
>();
const SSE_EVENT_BACKLOG_LIMIT = 100;
const SSE_EVENT_BACKLOG_TTL_MS = 2 * 60 * 1000;

function pruneExpiredSseEventBacklog(now = Date.now()): void {
  for (const [agentId, entries] of sseEventBacklog.entries()) {
    const freshEntries = entries.filter(
      (entry) => now - entry.timestamp <= SSE_EVENT_BACKLOG_TTL_MS
    );
    if (freshEntries.length === 0) {
      sseEventBacklog.delete(agentId);
      continue;
    }
    sseEventBacklog.set(agentId, freshEntries);
  }
}

// =============================================================================
// Zod Schemas
// =============================================================================

const NetworkConfigSchema = z.object({
  allowedDomains: z.array(z.string()).optional(),
  deniedDomains: z.array(z.string()).optional(),
});

const McpServerConfigSchema = z.object({
  url: z.string().optional(),
  type: z.enum(["sse", "stdio"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  description: z.string().optional(),
});

const NixConfigSchema = z.object({
  flakeUrl: z.string().optional(),
  packages: z.array(z.string()).optional(),
});

const CreateAgentRequestSchema = z.object({
  provider: z.string().default("claude").optional(),
  model: z.string().optional(),
  agentId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  thread: z.string().optional(),
  forceNew: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  networkConfig: NetworkConfigSchema.optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  nix: NixConfigSchema.optional(),
});

const CreateAgentResponseSchema = z.object({
  success: z.boolean(),
  agentId: z.string(),
  token: z.string(),
  expiresAt: z.number(),
  sseUrl: z.string(),
  messagesUrl: z.string(),
});

const SlackRoutingInfoSchema = z.object({
  channel: z.string().describe("Slack channel ID"),
  thread: z.string().optional().describe("Thread timestamp for replies"),
  team: z.string().optional().describe("Slack team ID"),
});

const SendMessageRequestSchema = z
  .object({
    content: z.string().optional().describe("Message content"),
    message: z
      .string()
      .optional()
      .describe("Message content (alias for content)"),
    messageId: z.string().optional(),
    platform: z
      .string()
      .optional()
      .describe("Target platform (api, slack, telegram)"),
    slack: SlackRoutingInfoSchema.optional().describe(
      "Slack-specific routing info (required when platform=slack)"
    ),
  })
  .passthrough();

const SendMessageResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string(),
  agentId: z.string().optional(),
  jobId: z.string().optional(),
  eventsUrl: z.string().optional(),
  queued: z.boolean(),
  traceparent: z.string().optional(),
});

const AgentStatusResponseSchema = z.object({
  success: z.boolean(),
  agent: z.object({
    agentId: z.string(),
    userId: z.string(),
    status: z.string(),
    createdAt: z.number(),
    lastActivity: z.number(),
    hasActiveConnection: z.boolean(),
  }),
});

const ErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.string(),
  details: z.string().optional(),
});

const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  agentId: z.string().optional(),
});

// Path parameters
const AgentIdParamSchema = z.object({
  agentId: z.string(),
});

// =============================================================================
// Validation Helpers
// =============================================================================

function validateDomainPattern(pattern: string): string | null {
  if (!pattern || typeof pattern !== "string") {
    return "Domain pattern must be a non-empty string";
  }
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed === "*") return "Bare wildcard '*' is not allowed";
  if (trimmed.includes("://"))
    return `Domain pattern cannot contain protocol: ${pattern}`;
  if (trimmed.includes("/"))
    return `Domain pattern cannot contain path: ${pattern}`;
  if (trimmed.includes(":") && !trimmed.includes("[")) {
    return `Domain pattern cannot contain port: ${pattern}`;
  }
  if (trimmed.startsWith("*.") || trimmed.startsWith(".")) {
    const domain = trimmed.startsWith("*.")
      ? trimmed.substring(2)
      : trimmed.substring(1);
    if (!domain.includes(".")) {
      return `Wildcard pattern too broad: ${pattern}`;
    }
  } else if (!trimmed.includes(".")) {
    return `Invalid domain pattern: ${pattern}`;
  }
  return null;
}

function validateNetworkConfig(config: NetworkConfig): string | null {
  for (const domains of [config.allowedDomains, config.deniedDomains]) {
    if (domains) {
      for (const domain of domains) {
        const error = validateDomainPattern(domain);
        if (error) return error;
      }
    }
  }
  return null;
}

function normalizeNetworkConfig(config: NetworkConfig): NetworkConfig {
  return {
    allowedDomains: normalizeDomainPatterns(config.allowedDomains),
    deniedDomains: normalizeDomainPatterns(config.deniedDomains),
  };
}

function validateMcpServerConfig(
  id: string,
  config: McpServerConfig
): string | null {
  if (!config.url && !config.command) {
    return `MCP ${id}: must specify either 'url' or 'command'`;
  }
  if (
    config.url &&
    !config.url.startsWith("http://") &&
    !config.url.startsWith("https://")
  ) {
    return `MCP ${id}: url must be http:// or https://`;
  }
  if (config.command) {
    const dangerousCommands = [
      "rm",
      "sudo",
      "curl",
      "wget",
      "sh",
      "bash",
      "zsh",
      "kill",
    ];
    const baseCommand = config.command.split("/").pop()?.split(" ")[0] || "";
    if (dangerousCommands.includes(baseCommand)) {
      return `MCP ${id}: command '${baseCommand}' is not allowed`;
    }
  }
  return null;
}

function validateMcpConfig(
  mcpServers: Record<string, McpServerConfig>
): string | null {
  for (const [id, config] of Object.entries(mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return `MCP ID '${id}' is invalid`;
    }
    const error = validateMcpServerConfig(id, config);
    if (error) return error;
  }
  return null;
}

// =============================================================================
// Broadcast Functions (exported for use by other modules)
// =============================================================================

function rememberSseEvent(agentId: string, event: string, data: unknown): void {
  const now = Date.now();
  pruneExpiredSseEventBacklog(now);
  const existing = sseEventBacklog.get(agentId) || [];
  const next = existing
    .concat({ event, data, timestamp: now })
    .slice(-SSE_EVENT_BACKLOG_LIMIT);
  sseEventBacklog.set(agentId, next);
}

function getRecentSseEvents(
  agentId: string
): Array<{ event: string; data: unknown; timestamp: number }> {
  const now = Date.now();
  pruneExpiredSseEventBacklog(now);
  return sseEventBacklog.get(agentId) || [];
}

export function broadcastToAgent(
  agentId: string,
  event: string,
  data: unknown
): void {
  rememberSseEvent(agentId, event, data);

  const connections = sseConnections.get(agentId);
  if (!connections || connections.size === 0) return;

  const deadConnections = new Set<any>();

  for (const res of connections) {
    try {
      if (res.closed || res.destroyed || res.writableEnded) {
        deadConnections.add(res);
        continue;
      }
      if (typeof res.writeSSE === "function") {
        res.writeSSE({ event, data: JSON.stringify(data) });
      } else if (typeof res.write === "function") {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(message);
      }
    } catch {
      deadConnections.add(res);
    }
  }

  for (const deadRes of deadConnections) {
    connections.delete(deadRes);
  }
  if (connections.size === 0) {
    sseConnections.delete(agentId);
  }
}

// =============================================================================
// OpenAPI Route Definitions
// =============================================================================

const createAgentRoute = createRoute({
  method: "post",
  path: "/api/v1/agents",
  tags: ["Agents"],
  summary: "Create a new agent",
  security: [{ bearerAuth: [] }],
  description:
    "Creates a new agent session and returns authentication credentials",
  request: {
    body: {
      content: { "application/json": { schema: CreateAgentRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "Agent created",
      content: { "application/json": { schema: CreateAgentResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const getAgentRoute = createRoute({
  method: "get",
  path: "/api/v1/agents/{agentId}",
  tags: ["Agents"],
  summary: "Get agent status",
  security: [{ bearerAuth: [] }],
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Agent status",
      content: { "application/json": { schema: AgentStatusResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const deleteAgentRoute = createRoute({
  method: "delete",
  path: "/api/v1/agents/{agentId}",
  tags: ["Agents"],
  summary: "Delete an agent",
  security: [{ bearerAuth: [] }],
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Agent deleted",
      content: { "application/json": { schema: SuccessResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const getAgentEventsRoute = createRoute({
  method: "get",
  path: "/api/v1/agents/{agentId}/events",
  tags: ["Messages"],
  summary: "Subscribe to agent events (SSE)",
  description: "Server-Sent Events stream for real-time agent updates",
  security: [{ bearerAuth: [] }],
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "SSE stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    429: {
      description: "Too many connections",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const sendMessageRoute = createRoute({
  method: "post",
  path: "/api/v1/agents/{agentId}/messages",
  tags: ["Messages"],
  summary: "Send a message to the agent",
  description:
    "Send a message to an agent. Supports JSON body or multipart form data for file uploads. " +
    "When platform is specified, the message is routed through the platform adapter.",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: SendMessageRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Message queued",
      content: { "application/json": { schema: SendMessageResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Forbidden - worker tokens cannot route to platforms",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// =============================================================================
// Create OpenAPI Hono App
// =============================================================================

export interface AgentApiConfig {
  queueProducer: QueueProducer;
  sessionManager: ISessionManager;
  publicGatewayUrl: string;
  adminPassword?: string;
  cliTokenService?: CliTokenService;
  externalAuthClient?: ExternalAuthClient;
  agentSettingsStore?: AgentSettingsStore;
  agentConfigStore?: Pick<AgentConfigStore, "getSettings" | "listAgents">;
  platformRegistry?: PlatformRegistry;
  approveToolCall?: (
    requestId: string,
    decision: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export function createAgentApi(config: AgentApiConfig): OpenAPIHono;
export function createAgentApi(
  queueProducer: QueueProducer,
  sessionManager: ISessionManager,
  publicGatewayUrl: string
): OpenAPIHono;
export function createAgentApi(
  configOrQueue: AgentApiConfig | QueueProducer,
  sessionManager?: ISessionManager,
  publicGatewayUrl?: string
): OpenAPIHono {
  const config: AgentApiConfig =
    configOrQueue instanceof Object && "queueProducer" in configOrQueue
      ? configOrQueue
      : {
          queueProducer: configOrQueue as QueueProducer,
          sessionManager: sessionManager!,
          publicGatewayUrl: publicGatewayUrl!,
        };

  const {
    queueProducer,
    adminPassword,
    cliTokenService,
    agentSettingsStore,
    agentConfigStore,
    platformRegistry,
  } = config;
  const sessMgr = config.sessionManager;
  const pubUrl = config.publicGatewayUrl;
  const app = new OpenAPIHono();

  // Unified auth middleware for all agent API routes
  app.use(
    "/api/v1/agents/*",
    createApiAuthMiddleware({
      adminPassword,
      cliTokenService,
      externalAuthClient: config.externalAuthClient,
      allowSettingsSession: true,
    })
  );

  // =============================================================================
  // Route Handlers
  // =============================================================================

  // POST /api/v1/agents - Create agent
  app.openapi(createAgentRoute, async (c): Promise<any> => {
    const body = c.req.valid("json");
    const {
      provider = "claude",
      model,
      agentId: requestedAgentId,
      userId: requestedUserId,
      thread,
      forceNew,
      dryRun,
      networkConfig,
      mcpServers,
      nix: nixConfig,
    } = body;

    // Validate provider
    if (provider && !["claude"].includes(provider)) {
      return c.json(
        { success: false, error: "Invalid provider. Supported: claude" },
        400
      );
    }

    const normalizedNetworkConfig = networkConfig
      ? normalizeNetworkConfig(networkConfig as NetworkConfig)
      : undefined;

    // Validate network config
    if (normalizedNetworkConfig) {
      const error = validateNetworkConfig(normalizedNetworkConfig);
      if (error) return c.json({ success: false, error }, 400);
    }

    // Validate MCP config
    if (mcpServers) {
      const error = validateMcpConfig(
        mcpServers as Record<string, McpServerConfig>
      );
      if (error) return c.json({ success: false, error }, 400);
    }

    const isEphemeral = !requestedAgentId?.trim();
    const agentId = requestedAgentId?.trim() || randomUUID();

    // For ephemeral agents, auto-provision settings so the worker gets provider config
    if (isEphemeral && agentSettingsStore) {
      // Try system-key providers first (env var based API keys)
      const providerModules = getModelProviderModules();
      const systemProviders: InstalledProvider[] = providerModules
        .filter((m) => m.hasSystemKey())
        .map((m) => ({
          providerId: m.providerId,
          installedAt: Date.now(),
        }));

      if (systemProviders.length > 0) {
        // Also inherit pluginsConfig from template agent if available
        const templateId = agentConfigStore
          ? await findTemplateAgentId(agentConfigStore)
          : await agentSettingsStore.findTemplateAgentId();
        const templateSettings = templateId
          ? await (agentConfigStore?.getSettings(templateId) ??
              agentSettingsStore.getSettings(templateId))
          : null;
        await agentSettingsStore.saveSettings(agentId, {
          installedProviders: systemProviders,
          pluginsConfig: templateSettings?.pluginsConfig,
        });
        logger.info(
          `Ephemeral agent ${agentId}: provisioned system providers [${systemProviders.map((p) => p.providerId).join(", ")}]`
        );
      } else {
        // Fall back to using an existing agent as template (inherits its providers)
        const templateId = agentConfigStore
          ? await findTemplateAgentId(agentConfigStore)
          : await agentSettingsStore.findTemplateAgentId();
        if (templateId) {
          const templateSettings = await (agentConfigStore?.getSettings(
            templateId
          ) ?? agentSettingsStore.getSettings(templateId));
          await agentSettingsStore.saveSettings(agentId, {
            templateAgentId: templateId,
            pluginsConfig: templateSettings?.pluginsConfig,
          });
          logger.info(
            `Ephemeral agent ${agentId}: using template ${templateId}`
          );
        }
      }
    }

    const userId = requestedUserId || agentId;

    // Build composite conversationId for user-specific sessions
    // Uses _ separator (colons not allowed in BullMQ custom IDs)
    const conversationId = thread
      ? `${agentId}_${userId}_${thread}`
      : `${agentId}_${userId}`;
    const channelId = `api_${userId}`;
    const deploymentName = `api-${agentId.slice(0, 8)}`;

    // Try to resume existing session (unless forceNew is requested)
    if (!forceNew) {
      const existing = await sessMgr.getSession(conversationId);
      if (existing) {
        // Reuse existing session — touch lastActivity and return existing token
        await sessMgr.touchSession(conversationId);

        const token = generateWorkerToken(
          agentId,
          conversationId,
          deploymentName,
          {
            channelId,
            agentId,
            platform: "api",
            sessionKey: userId,
          }
        );

        const expiresAt = Date.now() + TOKEN_EXPIRATION_MS;
        const baseUrl = pubUrl || "http://localhost:8080";

        logger.info(
          `Resumed API session: ${conversationId} (agent=${agentId})`
        );

        return c.json(
          {
            success: true,
            agentId: conversationId,
            token,
            expiresAt,
            sseUrl: `${baseUrl}/api/v1/agents/${conversationId}/events`,
            messagesUrl: `${baseUrl}/api/v1/agents/${conversationId}/messages`,
          },
          201
        );
      }
    }

    const token = generateWorkerToken(agentId, conversationId, deploymentName, {
      channelId,
      agentId,
      platform: "api",
      sessionKey: userId,
    });

    const expiresAt = Date.now() + TOKEN_EXPIRATION_MS;

    const session: ThreadSession = {
      conversationId,
      channelId,
      userId,
      threadCreator: userId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      status: "created",
      provider,
      model,
      networkConfig: normalizedNetworkConfig,
      mcpConfig: mcpServers
        ? { mcpServers: mcpServers as Record<string, McpServerConfig> }
        : undefined,
      nixConfig,
      agentId,
      dryRun: dryRun || false,
      isEphemeral,
    };
    await sessMgr.setSession(session);

    logger.info(`Created API agent: ${conversationId} (agent=${agentId})`);

    const baseUrl = pubUrl || "http://localhost:8080";
    return c.json(
      {
        success: true,
        agentId: conversationId,
        token,
        expiresAt,
        sseUrl: `${baseUrl}/api/v1/agents/${conversationId}/events`,
        messagesUrl: `${baseUrl}/api/v1/agents/${conversationId}/messages`,
      },
      201
    );
  });

  // GET /api/v1/agents/:agentId - Get status
  app.openapi(getAgentRoute, async (c): Promise<any> => {
    const { agentId: sessionKey } = c.req.valid("param");

    const session = await sessMgr.getSession(sessionKey);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const hasActiveConnection =
      sseConnections.has(sessionKey) &&
      (sseConnections.get(sessionKey)?.size ?? 0) > 0;

    return c.json({
      success: true,
      agent: {
        agentId: session.conversationId,
        userId: session.userId,
        status: session.status || "active",
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        hasActiveConnection,
      },
    });
  });

  // DELETE /api/v1/agents/:agentId
  app.openapi(deleteAgentRoute, async (c): Promise<any> => {
    const { agentId: sessionKey } = c.req.valid("param");

    const connections = sseConnections.get(sessionKey);
    if (connections) {
      for (const connection of connections) {
        try {
          if (typeof connection.writeSSE === "function") {
            connection.writeSSE({
              event: "closed",
              data: JSON.stringify({ reason: "agent_deleted" }),
            });
          } else if (typeof connection.write === "function") {
            connection.write(
              `event: closed\ndata: ${JSON.stringify({ reason: "agent_deleted" })}\n\n`
            );
          }
          connection.close?.();
          connection.end?.();
        } catch {
          // Ignore
        }
      }
      sseConnections.delete(sessionKey);
    }

    // Drop any remembered SSE events so a later connection with the same key
    // (rare, but possible with deterministic conversationIds) can't replay
    // stale completion events from this deleted session.
    sseEventBacklog.delete(sessionKey);

    // Get real agentId from session before deleting
    const session = await sessMgr.getSession(sessionKey);
    const realAgentId = session?.agentId || sessionKey;
    const wasEphemeral = session?.isEphemeral === true;

    await sessMgr.deleteSession(sessionKey);
    // Only tear down agent settings if we auto-provisioned them for an
    // ephemeral session. Named/shared agents (like ones loaded from
    // filesystem config) must keep their settings across session lifecycles.
    if (wasEphemeral && agentSettingsStore) {
      await agentSettingsStore.deleteSettings(realAgentId).catch(() => {
        /* best-effort cleanup */
      });
    }
    logger.info(`Deleted agent ${sessionKey}`);

    return c.json({
      success: true,
      message: "Agent deleted",
      agentId: sessionKey,
    });
  });

  // GET /api/v1/agents/:agentId/events - SSE stream
  app.openapi(getAgentEventsRoute, async (c): Promise<any> => {
    const { agentId: sessionKey } = c.req.valid("param");

    const session = await sessMgr.getSession(sessionKey);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    // Check connection limits
    const totalConnections = Array.from(sseConnections.values()).reduce(
      (acc, set) => acc + set.size,
      0
    );
    if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
      return c.json(
        { success: false, error: "Server connection limit reached" },
        429
      );
    }

    // Use conversationId as the SSE connection key (matches broadcastToAgent calls)
    const sseKey = session.conversationId;
    if (!sseConnections.has(sseKey)) {
      sseConnections.set(sseKey, new Set());
    }
    const agentConnections = sseConnections.get(sseKey)!;
    if (agentConnections.size >= MAX_CONNECTIONS_PER_AGENT) {
      return c.json(
        {
          success: false,
          error: `Maximum ${MAX_CONNECTIONS_PER_AGENT} connections`,
        },
        429
      );
    }

    // Return SSE stream
    return streamSSE(c, async (stream) => {
      agentConnections.add(stream);

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({
          agentId: session.agentId || sessionKey,
          timestamp: Date.now(),
        }),
      });

      for (const entry of getRecentSseEvents(sseKey)) {
        await stream.writeSSE({
          event: entry.event,
          data: JSON.stringify(entry.data),
        });
      }

      const heartbeatInterval = setInterval(async () => {
        try {
          await stream.writeSSE({
            event: "ping",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 30000);

      stream.onAbort(() => {
        clearInterval(heartbeatInterval);
        agentConnections.delete(stream);
        if (agentConnections.size === 0) {
          sseConnections.delete(sseKey);
        }
        logger.info(`SSE connection closed for session ${sseKey}`);
      });

      while (true) {
        await stream.sleep(1000);
      }
    });
  });

  // POST /api/v1/agents/:agentId/messages - Send message
  // Supports two paths:
  //   1. Direct API (no platform field): requires pre-created session, enqueues directly
  //   2. Platform-routed (platform field present): delegates to platform adapter
  app.openapi(sendMessageRoute, async (c): Promise<any> => {
    const { agentId } = c.req.valid("param");

    // Parse body — multipart for file uploads, JSON otherwise
    const contentType = c.req.header("content-type") || "";
    let body: Record<string, any>;
    let files: Array<{ buffer: Buffer; filename: string }> | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      body = {
        content: formData.get("content") as string | null,
        message: formData.get("message") as string | null,
        messageId: formData.get("messageId") as string | null,
        platform: formData.get("platform") as string | null,
      };

      // Extract nested platform routing from form fields
      const slackChannel = formData.get("slack.channel") as string;
      if (slackChannel) {
        body.slack = {
          channel: slackChannel,
          thread: formData.get("slack.thread") as string | undefined,
          team: formData.get("slack.team") as string | undefined,
        };
      }
      const whatsappChat = formData.get("whatsapp.chat") as string;
      if (whatsappChat) {
        body.whatsapp = { chat: whatsappChat };
      }
      const telegramChatId = formData.get("telegram.chatId") as string;
      if (telegramChatId) {
        body.telegram = { chatId: telegramChatId };
      }

      // Extract files with size validation
      const MAX_FILE_SIZE = 50 * 1024 * 1024;
      const MAX_TOTAL_SIZE = 100 * 1024 * 1024;
      const MAX_FILE_COUNT = 10;
      const fileEntries = formData.getAll("files");
      if (fileEntries.length > MAX_FILE_COUNT) {
        return c.json(
          {
            success: false,
            error: `Too many files: ${fileEntries.length} (max ${MAX_FILE_COUNT})`,
          },
          400
        );
      }
      if (fileEntries.length > 0) {
        const fileResults: Array<{ buffer: Buffer; filename: string }> = [];
        let totalSize = 0;
        for (const entry of fileEntries) {
          if (entry instanceof File) {
            if (entry.size > MAX_FILE_SIZE) {
              return c.json(
                {
                  success: false,
                  error: `File "${entry.name}" exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
                },
                400
              );
            }
            totalSize += entry.size;
            if (totalSize > MAX_TOTAL_SIZE) {
              return c.json(
                {
                  success: false,
                  error: `Total upload size exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB`,
                },
                400
              );
            }
            const arrayBuffer = await entry.arrayBuffer();
            fileResults.push({
              buffer: Buffer.from(arrayBuffer),
              filename: entry.name,
            });
          }
        }
        if (fileResults.length > 0) files = fileResults;
      }
    } else {
      body = c.req.valid("json");
    }

    const messageContent = body.content || body.message;
    const messageId = body.messageId || randomUUID();

    if (!messageContent || typeof messageContent !== "string") {
      return c.json({ success: false, error: "content is required" }, 400);
    }

    const platform = body.platform as string | undefined;

    // ── Platform-routed path ──────────────────────────────────────────────────
    // When platform is specified, delegate to the platform adapter which handles
    // session creation, routing, and file delivery.
    if (platform) {
      // Worker tokens cannot route to user-facing platform connections
      const authHeader = c.req.header("Authorization");
      const rawToken = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : "";
      if (verifyWorkerToken(rawToken)) {
        return c.json(
          { success: false, error: "Worker tokens cannot route to platforms" },
          403
        );
      }

      if (!platformRegistry) {
        return c.json(
          { success: false, error: "Platform routing not available" },
          501
        );
      }

      const adapter = platformRegistry.get(platform);
      if (!adapter) {
        return c.json(
          {
            success: false,
            error: `Platform "${platform}" not found`,
            details: `Available: ${platformRegistry.getAvailablePlatforms().join(", ")}`,
          },
          404
        );
      }

      if (!adapter.sendMessage) {
        return c.json(
          {
            success: false,
            error: `Platform "${platform}" does not support sendMessage`,
          },
          501
        );
      }

      // Extract platform-specific routing info
      let channelId = agentId;
      let conversationId: string | undefined =
        platform === "api" ? agentId : undefined;
      let teamId = "api";

      if (adapter.extractRoutingInfo) {
        const routingInfo = adapter.extractRoutingInfo(
          body as Record<string, unknown>
        );
        if (routingInfo) {
          channelId = routingInfo.channelId;
          conversationId = routingInfo.conversationId || conversationId;
          teamId = routingInfo.teamId || "api";
        } else if (platform !== "api") {
          return c.json(
            {
              success: false,
              error: `Platform-specific routing info required for ${platform}`,
            },
            400
          );
        }
      }

      logger.info(
        `Sending message via ${platform}: agentId=${agentId}, channelId=${channelId}${files?.length ? `, files=${files.length}` : ""}`
      );

      try {
        const result = await adapter.sendMessage(rawToken, messageContent, {
          agentId,
          channelId,
          conversationId,
          teamId,
          files,
        });

        return c.json({
          success: true,
          agentId,
          messageId: result.messageId,
          eventsUrl: result.eventsUrl,
          queued: result.queued || false,
        });
      } catch (error) {
        logger.error("Failed to send platform message", { error });
        return c.json({ success: false, error: "Internal server error" }, 500);
      }
    }

    // ── Direct API path ───────────────────────────────────────────────────────
    // No platform field: use existing session-based direct enqueue
    const session = await sessMgr.getSession(agentId);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    await sessMgr.touchSession(agentId);

    const realAgentId = session.agentId || agentId;

    const { span: rootSpan, traceparent } = createRootSpan("message_received", {
      "lobu.agent_id": realAgentId,
      "lobu.message_id": messageId,
    });

    try {
      const channelId = session.channelId || `api_${session.userId}`;

      const baseOptions: Record<string, any> = {
        provider: session.provider || "claude",
        model: session.model,
      };
      const agentOptions = await resolveAgentOptions(
        realAgentId,
        baseOptions,
        agentSettingsStore
      );

      const {
        networkConfig: settingsNetwork,
        mcpServers: settingsMcpServers,
        ...remainingOptions
      } = agentOptions;

      const jobId = await queueProducer.enqueueMessage({
        userId: session.userId,
        conversationId: session.conversationId || agentId,
        messageId,
        channelId,
        teamId: "api",
        agentId: realAgentId,
        botId: "lobu-api",
        platform: "api",
        messageText: messageContent,
        platformMetadata: {
          agentId: realAgentId,
          source: "direct-api",
          traceparent: traceparent || undefined,
          dryRun: session.dryRun || false,
        },
        agentOptions: remainingOptions,
        networkConfig: session.networkConfig || settingsNetwork,
        mcpConfig:
          session.mcpConfig ||
          (settingsMcpServers ? { mcpServers: settingsMcpServers } : undefined),
      });

      rootSpan?.end();

      return c.json({
        success: true,
        messageId,
        jobId,
        queued: true,
        traceparent: traceparent || undefined,
      });
    } catch (error) {
      rootSpan?.end();
      throw error;
    }
  });

  // POST /api/v1/agents/approve - Approve a pending tool call (CLI/web)
  if (config.approveToolCall) {
    const approveHandler = config.approveToolCall;
    app.post("/api/v1/agents/approve", async (c) => {
      const { requestId, decision } = await c.req.json();
      if (!requestId || !decision) {
        return c.json({ error: "Missing requestId or decision" }, 400);
      }
      const validDecisions = ["1h", "24h", "always", "deny"];
      if (!validDecisions.includes(decision)) {
        return c.json(
          {
            error: `Invalid decision. Must be one of: ${validDecisions.join(", ")}`,
          },
          400
        );
      }
      const result = await approveHandler(requestId, decision);
      if (!result.success) {
        return c.json({ error: result.error || "Approval failed" }, 400);
      }
      return c.json({ success: true });
    });
  }

  logger.debug("Hono Agent API routes registered");

  return app;
}
