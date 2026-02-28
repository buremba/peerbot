import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  createLogger,
  createRootSpan,
  generateWorkerToken,
  type McpServerConfig,
  type NetworkConfig,
  verifyWorkerToken,
  type WorkerTokenData,
} from "@lobu/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer";
import type { ISessionManager, ThreadSession } from "../../session";

const logger = createLogger("agent-api");

// =============================================================================
// Constants
// =============================================================================

const TOKEN_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXEC_TIMEOUT = 300000;
const MAX_EXEC_TIMEOUT = 600000;
const MAX_CONNECTIONS_PER_AGENT = 5;
const MAX_TOTAL_CONNECTIONS = 1000;

const RESERVED_EXEC_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "WORKSPACE_DIR",
  "LOBU_WORKSPACES_DIR",
  "WORKER_TOKEN",
  "LOBU_API_KEY",
  "ENCRYPTION_KEY",
  "TRACE_ID",
  "TRACEPARENT",
  "NODE_OPTIONS",
]);

// SSE connection tracking
const sseConnections = new Map<string, Set<any>>();
const execConnections = new Map<string, Set<any>>();

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
  agentId: z.string().optional(),
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
  execUrl: z.string(),
});

const SendMessageRequestSchema = z.object({
  content: z.string(),
  messageId: z.string().optional(),
});

const SendMessageResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string(),
  jobId: z.string(),
  queued: z.boolean(),
  traceparent: z.string().optional(),
});

const ExecRequestSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeout: z.number().optional(),
});

const ExecResponseSchema = z.object({
  success: z.boolean(),
  execId: z.string(),
  jobId: z.string(),
  eventsUrl: z.string(),
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

const ExecIdParamSchema = z.object({
  agentId: z.string(),
  execId: z.string(),
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

function sanitizeExecEnv(
  env?: Record<string, string>
): Record<string, string> | undefined {
  if (!env) return undefined;
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || RESERVED_EXEC_ENV_KEYS.has(key)) continue;
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (typeof value !== "string") continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function resolveExecCwd(baseDir: string, requested?: string): string | null {
  try {
    // Resolve symlinks to prevent escape via symlink attacks
    const resolvedBase = fs.realpathSync(path.resolve(baseDir));
    const resolvedRequested = requested
      ? fs.realpathSync(path.resolve(resolvedBase, requested))
      : resolvedBase;

    // Check path containment using resolved (symlink-resolved) paths
    if (
      resolvedRequested !== resolvedBase &&
      !resolvedRequested.startsWith(`${resolvedBase}${path.sep}`)
    ) {
      return null;
    }
    return resolvedRequested;
  } catch {
    // Path doesn't exist or permission denied
    return null;
  }
}

// =============================================================================
// Broadcast Functions (exported for use by other modules)
// =============================================================================

export function broadcastToAgent(
  agentId: string,
  event: string,
  data: unknown
): void {
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

export function broadcastToExec(
  execId: string,
  event: string,
  data: unknown
): void {
  const connections = execConnections.get(execId);
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
    execConnections.delete(execId);
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
  tags: ["Agents"],
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
  tags: ["Agent Messages"],
  summary: "Send a message to the agent",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
    body: {
      content: { "application/json": { schema: SendMessageRequestSchema } },
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
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const execRoute = createRoute({
  method: "post",
  path: "/api/v1/agents/{agentId}/exec",
  tags: ["Agent Exec"],
  summary: "Execute a command in the agent sandbox",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
    body: { content: { "application/json": { schema: ExecRequestSchema } } },
  },
  responses: {
    202: {
      description: "Exec queued",
      content: { "application/json": { schema: ExecResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const execEventsRoute = createRoute({
  method: "get",
  path: "/api/v1/agents/{agentId}/exec/{execId}/events",
  tags: ["Agent Exec"],
  summary: "Subscribe to exec output (SSE)",
  security: [{ bearerAuth: [] }],
  request: { params: ExecIdParamSchema },
  responses: {
    200: {
      description: "SSE stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

// =============================================================================
// Create OpenAPI Hono App
// =============================================================================

export function createAgentApi(
  queueProducer: QueueProducer,
  sessionManager: ISessionManager,
  publicGatewayUrl: string
): OpenAPIHono {
  const app = new OpenAPIHono();

  // Auth helper
  const authenticateAgent = async (
    c: Context,
    agentId: string
  ): Promise<WorkerTokenData | null> => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return null;
    }
    const token = authHeader.substring(7);
    const tokenData = verifyWorkerToken(token);
    if (!tokenData) return null;
    if (tokenData.sessionKey !== agentId) return null;
    const tokenAge = Date.now() - tokenData.timestamp;
    if (tokenAge > TOKEN_EXPIRATION_MS) return null;
    return tokenData;
  };

  const checkApiKey = (c: Context): boolean => {
    const apiKey = process.env.LOBU_API_KEY;
    if (!apiKey) return true;
    const providedKey = c.req.header("X-API-Key");
    if (!providedKey) return false;
    if (providedKey.length !== apiKey.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(providedKey),
      Buffer.from(apiKey)
    );
  };

  // =============================================================================
  // Route Handlers
  // =============================================================================

  // POST /api/v1/agents - Create agent
  app.openapi(createAgentRoute, async (c): Promise<any> => {
    if (!checkApiKey(c)) {
      return c.json(
        { success: false, error: "Invalid or missing API key" },
        401
      );
    }

    const body = c.req.valid("json");
    const {
      provider = "claude",
      model,
      agentId: requestedAgentId,
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

    // Validate network config
    if (networkConfig) {
      const error = validateNetworkConfig(networkConfig as NetworkConfig);
      if (error) return c.json({ success: false, error }, 400);
    }

    // Validate MCP config
    if (mcpServers) {
      const error = validateMcpConfig(
        mcpServers as Record<string, McpServerConfig>
      );
      if (error) return c.json({ success: false, error }, 400);
    }

    const agentId = requestedAgentId || randomUUID();
    const conversationId = agentId;
    const channelId = `api-${agentId.slice(0, 8)}`;
    const deploymentName = `api-${agentId.slice(0, 8)}`;

    const token = generateWorkerToken(agentId, conversationId, deploymentName, {
      channelId,
      agentId,
      platform: "api",
      sessionKey: agentId,
    });

    const expiresAt = Date.now() + TOKEN_EXPIRATION_MS;

    const session: ThreadSession = {
      conversationId,
      channelId,
      userId: agentId,
      threadCreator: agentId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      status: "created",
      provider,
      model,
      networkConfig: networkConfig as NetworkConfig | undefined,
      mcpConfig: mcpServers
        ? { mcpServers: mcpServers as Record<string, McpServerConfig> }
        : undefined,
      nixConfig,
    };
    await sessionManager.setSession(session);

    logger.info(`Created API agent: ${agentId}`);

    const baseUrl = publicGatewayUrl || "http://localhost:8080";
    return c.json(
      {
        success: true,
        agentId,
        token,
        expiresAt,
        sseUrl: `${baseUrl}/api/v1/agents/${agentId}/events`,
        messagesUrl: `${baseUrl}/api/v1/agents/${agentId}/messages`,
        execUrl: `${baseUrl}/api/v1/agents/${agentId}/exec`,
      },
      201
    );
  });

  // GET /api/v1/agents/:agentId - Get status
  app.openapi(getAgentRoute, async (c): Promise<any> => {
    const { agentId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const session = await sessionManager.getSession(agentId);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const hasActiveConnection =
      sseConnections.has(agentId) && sseConnections.get(agentId)!.size > 0;

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
    const { agentId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const connections = sseConnections.get(agentId);
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
      sseConnections.delete(agentId);
    }

    await sessionManager.deleteSession(agentId);
    logger.info(`Deleted agent ${agentId}`);

    return c.json({ success: true, message: "Agent deleted", agentId });
  });

  // GET /api/v1/agents/:agentId/events - SSE stream
  app.openapi(getAgentEventsRoute, async (c): Promise<any> => {
    const { agentId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const session = await sessionManager.getSession(agentId);
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

    if (!sseConnections.has(agentId)) {
      sseConnections.set(agentId, new Set());
    }
    const agentConnections = sseConnections.get(agentId)!;
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
        data: JSON.stringify({ agentId, timestamp: Date.now() }),
      });

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
          sseConnections.delete(agentId);
        }
        logger.info(`SSE connection closed for agent ${agentId}`);
      });

      while (true) {
        await stream.sleep(1000);
      }
    });
  });

  // POST /api/v1/agents/:agentId/messages - Send message
  app.openapi(sendMessageRoute, async (c): Promise<any> => {
    const { agentId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const body = c.req.valid("json");
    const { content, messageId = randomUUID() } = body;

    if (!content || typeof content !== "string") {
      return c.json({ success: false, error: "content is required" }, 400);
    }

    const session = await sessionManager.getSession(agentId);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    await sessionManager.touchSession(agentId);

    const { span: rootSpan, traceparent } = createRootSpan("message_received", {
      "lobu.agent_id": agentId,
      "lobu.message_id": messageId,
    });

    try {
      const jobId = await queueProducer.enqueueMessage({
        userId: tokenData.userId,
        conversationId: tokenData.conversationId || agentId,
        messageId,
        channelId: tokenData.channelId,
        teamId: tokenData.teamId || "api",
        agentId: tokenData.agentId || `api-${tokenData.userId}`,
        botId: "lobu-api",
        platform: "api",
        messageText: content,
        platformMetadata: {
          agentId,
          source: "direct-api",
          traceparent: traceparent || undefined,
        },
        agentOptions: {
          provider: session.provider || "claude",
          model: session.model,
        },
        networkConfig: session.networkConfig,
        mcpConfig: session.mcpConfig,
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

  // POST /api/v1/agents/:agentId/exec - Execute command
  app.openapi(execRoute, async (c): Promise<any> => {
    const { agentId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const body = c.req.valid("json");
    const { command, cwd, env, timeout = DEFAULT_EXEC_TIMEOUT } = body;

    if (!command || typeof command !== "string") {
      return c.json({ success: false, error: "command is required" }, 400);
    }

    const session = await sessionManager.getSession(agentId);
    if (!session) {
      return c.json({ success: false, error: "Agent not found" }, 404);
    }

    const validTimeout = Math.min(
      Math.max(timeout || DEFAULT_EXEC_TIMEOUT, 1000),
      MAX_EXEC_TIMEOUT
    );
    const execId = randomUUID();
    const baseDir =
      session.workingDirectory || process.env.WORKSPACE_DIR || "/workspace";
    const workingDir = resolveExecCwd(baseDir, cwd);

    if (!workingDir) {
      return c.json(
        { success: false, error: "cwd must be within agent workspace" },
        400
      );
    }

    const { span: rootSpan, traceparent } = createRootSpan("exec_received", {
      "lobu.agent_id": agentId,
      "lobu.exec_id": execId,
    });

    try {
      const jobId = await queueProducer.enqueueMessage({
        userId: tokenData.userId,
        conversationId: tokenData.conversationId || agentId,
        messageId: execId,
        channelId: tokenData.channelId,
        teamId: tokenData.teamId || "api",
        agentId: tokenData.agentId || `api-${tokenData.userId}`,
        botId: "lobu-api",
        platform: "api",
        messageText: "",
        platformMetadata: {
          agentId,
          source: "direct-api",
          traceparent: traceparent || undefined,
        },
        agentOptions: { workingDirectory: workingDir },
        networkConfig: session.networkConfig,
        mcpConfig: session.mcpConfig,
        jobType: "exec",
        execId,
        execCommand: command,
        execCwd: workingDir,
        execEnv: sanitizeExecEnv(env),
        execTimeout: validTimeout,
      });

      rootSpan?.end();

      const baseUrl = publicGatewayUrl || "http://localhost:8080";
      return c.json(
        {
          success: true,
          execId,
          jobId,
          eventsUrl: `${baseUrl}/api/v1/agents/${agentId}/exec/${execId}/events`,
        },
        202
      );
    } catch (error) {
      rootSpan?.end();
      throw error;
    }
  });

  // GET /api/v1/agents/:agentId/exec/:execId/events - Exec SSE
  app.openapi(execEventsRoute, async (c): Promise<any> => {
    const { agentId, execId } = c.req.valid("param");
    const tokenData = await authenticateAgent(c, agentId);
    if (!tokenData) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    if (!execConnections.has(execId)) {
      execConnections.set(execId, new Set());
    }
    const execConns = execConnections.get(execId)!;

    return streamSSE(c, async (stream) => {
      execConns.add(stream);

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ execId, timestamp: Date.now() }),
      });

      stream.onAbort(() => {
        execConns.delete(stream);
        if (execConns.size === 0) {
          execConnections.delete(execId);
        }
      });

      while (true) {
        await stream.sleep(1000);
      }
    });
  });

  logger.info("Hono Agent API routes registered");

  return app;
}
