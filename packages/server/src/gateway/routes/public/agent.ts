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
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import {
  createApiAuthMiddleware,
  TOKEN_EXPIRATION_MS,
} from "../../auth/api-auth-middleware.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import type { AgentSettingsStore } from "../../auth/settings/agent-settings-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer.js";
import { getModelProviderModules } from "../../modules/module-system.js";
import type { PlatformRegistry } from "../../platform.js";
import { resolveAgentOptions } from "../../services/platform-helpers.js";
import type { SseManager } from "../../services/sse-manager.js";
import type { ISessionManager, ThreadSession } from "../../session.js";
import { verifyOwnedAgentAccess } from "../shared/agent-ownership.js";
import { errorResponse } from "../shared/helpers.js";
import { verifySettingsSession } from "./settings-auth.js";

const logger = createLogger("agent-api");

// =============================================================================
// Constants
// =============================================================================

const MAX_CONNECTIONS_PER_AGENT = 5;
const MAX_TOTAL_CONNECTIONS = 1000;

// =============================================================================
// Zod Schemas
// =============================================================================

const NetworkConfigSchema = z.object({
  allowedDomains: z.array(z.string()).optional(),
  deniedDomains: z.array(z.string()).optional(),
});

const McpServerConfigSchema = z.object({
  url: z.string().optional(),
  type: z.enum(["sse", "streamable-http", "stdio"]).optional(),
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

const WatcherRunIntentSchema = z.object({
  kind: z.literal("watcher_run"),
  runId: z.number().int().positive(),
  watcherId: z.number().int().positive(),
});

const CreateAgentRequestSchema = z.object({
  provider: z.string().default("claude").optional(),
  model: z.string().optional(),
  agentId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  thread: z.string().optional(),
  forceNew: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  intent: WatcherRunIntentSchema.optional(),
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

/**
 * Structured validation error. Each entry identifies the offending field path
 * (e.g. `networkConfig.allowedDomains[0]`, `mcpServers.foo.url`) plus a human
 * message. Callers format these via `formatValidationError` at the response
 * boundary so the wire representation stays a single flat string.
 */
type ValidationError = { path: string; message: string }[];

/**
 * Collapse a structured ValidationError into the flat `error` string the
 * public API contract expects. We surface the first failure's message
 * verbatim — historically these validators short-circuited on the first
 * error and callers displayed only that message, so preserving this keeps
 * the HTTP response body unchanged.
 */
function formatValidationError(err: ValidationError): string {
  const first = err[0];
  if (!first) return "Validation failed";
  return first.message;
}

function validateDomainPattern(pattern: string, path: string): ValidationError {
  if (!pattern || typeof pattern !== "string") {
    return [{ path, message: "Domain pattern must be a non-empty string" }];
  }
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed === "*") {
    return [{ path, message: "Bare wildcard '*' is not allowed" }];
  }
  if (trimmed.includes("://")) {
    return [
      { path, message: `Domain pattern cannot contain protocol: ${pattern}` },
    ];
  }
  if (trimmed.includes("/")) {
    return [
      { path, message: `Domain pattern cannot contain path: ${pattern}` },
    ];
  }
  if (trimmed.includes(":") && !trimmed.includes("[")) {
    return [
      { path, message: `Domain pattern cannot contain port: ${pattern}` },
    ];
  }
  if (trimmed.startsWith("*.") || trimmed.startsWith(".")) {
    const domain = trimmed.startsWith("*.")
      ? trimmed.substring(2)
      : trimmed.substring(1);
    if (!domain.includes(".")) {
      return [{ path, message: `Wildcard pattern too broad: ${pattern}` }];
    }
  } else if (!trimmed.includes(".")) {
    return [{ path, message: `Invalid domain pattern: ${pattern}` }];
  }
  return [];
}

function validateNetworkConfig(config: NetworkConfig): ValidationError {
  const fields: Array<[string, string[] | undefined]> = [
    ["networkConfig.allowedDomains", config.allowedDomains],
    ["networkConfig.deniedDomains", config.deniedDomains],
  ];
  for (const [fieldPath, domains] of fields) {
    if (!domains) continue;
    for (let i = 0; i < domains.length; i++) {
      const errors = validateDomainPattern(domains[i]!, `${fieldPath}[${i}]`);
      if (errors.length > 0) return errors;
    }
  }
  return [];
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
): ValidationError {
  const basePath = `mcpServers.${id}`;
  if (!config.url && !config.command) {
    return [
      {
        path: basePath,
        message: `MCP ${id}: must specify either 'url' or 'command'`,
      },
    ];
  }
  if (
    config.url &&
    !config.url.startsWith("http://") &&
    !config.url.startsWith("https://")
  ) {
    return [
      {
        path: `${basePath}.url`,
        message: `MCP ${id}: url must be http:// or https://`,
      },
    ];
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
      return [
        {
          path: `${basePath}.command`,
          message: `MCP ${id}: command '${baseCommand}' is not allowed`,
        },
      ];
    }
  }
  return [];
}

function validateMcpConfig(
  mcpServers: Record<string, McpServerConfig>
): ValidationError {
  for (const [id, config] of Object.entries(mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return [
        { path: `mcpServers.${id}`, message: `MCP ID '${id}' is invalid` },
      ];
    }
    const errors = validateMcpServerConfig(id, config);
    if (errors.length > 0) return errors;
  }
  return [];
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
  sseManager: SseManager;
  publicGatewayUrl: string;
  externalAuthClient?: ExternalAuthClient;
  agentSettingsStore?: AgentSettingsStore;
  agentConfigStore?: Pick<
    AgentConfigStore,
    "getSettings" | "listAgents" | "getMetadata"
  >;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: Pick<AgentMetadataStore, "getMetadata">;
  platformRegistry?: PlatformRegistry;
  approveToolCall?: (
    requestId: string,
    decision: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export function createAgentApi(config: AgentApiConfig): OpenAPIHono {
  const {
    queueProducer,
    externalAuthClient,
    agentSettingsStore,
    agentConfigStore,
    userAgentsStore,
    agentMetadataStore,
    platformRegistry,
  } = config;
  const sessMgr = config.sessionManager;
  const sseManager = config.sseManager;
  const pubUrl = config.publicGatewayUrl;
  const app = new OpenAPIHono();

  // Unified auth middleware for all agent API routes
  app.use(
    "/api/v1/agents/*",
    createApiAuthMiddleware({
      externalAuthClient,
      allowSettingsSession: true,
    })
  );

  // =============================================================================
  // Ownership Verification
  // =============================================================================

  // Accept either an AgentMetadataStore or an AgentConfigStore exposing
  // getMetadata for ownership resolution. When both are provided, try the
  // metadata store first (in-memory layer) and fall through to the config
  // store (Postgres, authoritative) — needed in embedded mode where agent
  // rows live in Postgres but the in-memory layer is not hydrated.
  const ownershipMetadataStore:
    | { getMetadata: AgentMetadataStore["getMetadata"] }
    | undefined =
    agentMetadataStore && agentConfigStore
      ? {
          async getMetadata(agentId) {
            const fromCache = await agentMetadataStore.getMetadata(agentId);
            if (fromCache) return fromCache;
            return agentConfigStore.getMetadata(agentId);
          },
        }
      : (agentMetadataStore ?? agentConfigStore);

  const ownershipAccessConfig = {
    userAgentsStore,
    agentMetadataStore: ownershipMetadataStore,
  } as const;

  function tokenFromHeader(c: Context): string | null {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7);
    return token.length > 0 ? token : null;
  }

  /**
   * Verify that the caller is authorized to act on `resolvedAgentId`.
   *
   * The agent API middleware accepts three auth methods (worker token,
   * external OAuth, settings session). Each needs its own ownership rule:
   *
   *   - worker token         → scoped to its own agentId
   *   - settings session     → verifyOwnedAgentAccess (handles admin bypass,
   *                            agent-scoped sessions, and UserAgentsStore
   *                            / AgentMetadataStore lookups)
   *   - external OAuth       → treated as an external-platform identity and
   *                            run through verifyOwnedAgentAccess
   *
   * Returns a Response when the caller is not authorized (the handler
   * should early-return it). Returns null on success.
   */
  async function requireAgentOwnership(
    c: Context,
    resolvedAgentId: string
  ): Promise<Response | null> {
    const deny = () =>
      c.json({ success: false, error: "Forbidden" }, 403) as Response;

    const bearer = tokenFromHeader(c);

    // 1. Settings session cookie (or injected auth provider for embedded mode).
    const settingsSession = verifySettingsSession(c);
    if (settingsSession) {
      const access = await verifyOwnedAgentAccess(
        settingsSession,
        resolvedAgentId,
        ownershipAccessConfig
      );
      return access.authorized ? null : deny();
    }

    if (!bearer) return deny();

    // 2. Worker token — must target its own agent.
    const workerData = verifyWorkerToken(bearer);
    if (workerData) {
      const tokenAge = Date.now() - workerData.timestamp;
      if (tokenAge > TOKEN_EXPIRATION_MS) return deny();
      const workerAgentId = workerData.agentId || workerData.userId;
      return workerAgentId && workerAgentId === resolvedAgentId ? null : deny();
    }

    // 3. External OAuth (Owletto / memory-url userinfo).
    if (externalAuthClient) {
      try {
        const userInfo = (await externalAuthClient.fetchUserInfo(bearer)) as {
          sub?: string;
          email?: string;
          name?: string;
        };
        if (userInfo?.sub) {
          const synthesized: SettingsTokenPayload = {
            userId: userInfo.sub,
            platform: "external",
            oauthUserId: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name,
            exp: Date.now() + TOKEN_EXPIRATION_MS,
          };
          const access = await verifyOwnedAgentAccess(
            synthesized,
            resolvedAgentId,
            ownershipAccessConfig
          );
          return access.authorized ? null : deny();
        }
      } catch {
        // fall through to deny
      }
    }

    return deny();
  }

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
      intent,
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
      const errors = validateNetworkConfig(normalizedNetworkConfig);
      if (errors.length > 0) {
        return c.json(
          { success: false, error: formatValidationError(errors) },
          400
        );
      }
    }

    // Validate MCP config
    if (mcpServers) {
      const errors = validateMcpConfig(
        mcpServers as Record<string, McpServerConfig>
      );
      if (errors.length > 0) {
        return c.json(
          { success: false, error: formatValidationError(errors) },
          400
        );
      }
    }

    const isEphemeral = !requestedAgentId?.trim();
    const agentId = requestedAgentId?.trim() || randomUUID();

    // If the caller pinned a specific agentId, require ownership so a signed-in
    // user cannot open a session against another tenant's agent.
    if (!isEphemeral) {
      const denial = await requireAgentOwnership(c, agentId);
      if (denial) return denial;
    }

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
          : null;
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
          : null;
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

    const watcherIntent = intent?.kind === "watcher_run" ? intent : null;
    const userId = watcherIntent
      ? `watcher_${watcherIntent.watcherId}`
      : requestedUserId || agentId;
    const effectiveThread = watcherIntent
      ? `run_${watcherIntent.runId}`
      : thread;
    const effectiveForceNew = watcherIntent ? true : forceNew;
    const effectiveDryRun = watcherIntent ? false : dryRun || false;

    // Build composite conversationId for user-specific sessions.
    // Uses _ separator (colons not allowed in BullMQ custom IDs). Watcher
    // automation gets one deterministic one-shot session per run and never
    // resumes human/API sessions such as marketing_marketing.
    const conversationId = effectiveThread
      ? `${agentId}_${userId}_${effectiveThread}`
      : `${agentId}_${userId}`;
    const channelId = `api_${userId}`;
    const deploymentName = `api-${agentId.slice(0, 8)}`;

    // Try to resume existing session (unless forceNew is requested)
    if (!effectiveForceNew) {
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
      dryRun: effectiveDryRun,
      intent: watcherIntent ?? undefined,
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

    const denial = await requireAgentOwnership(
      c,
      session.agentId || sessionKey
    );
    if (denial) return denial;

    const hasActiveConnection = sseManager.hasActiveConnection(sessionKey);

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

    // Resolve the real agentId BEFORE any mutation so ownership can be
    // checked against the actual agent (the path param is a sessionKey).
    const existingSession = await sessMgr.getSession(sessionKey);
    const denial = await requireAgentOwnership(
      c,
      existingSession?.agentId || sessionKey
    );
    if (denial) return denial;

    // Close connections + drop backlog so a later connection with the same
    // key (rare, but possible with deterministic conversationIds) can't
    // replay stale completion events from this deleted session.
    sseManager.closeAgent(sessionKey, "agent_deleted");

    // Reuse the session we loaded for ownership verification above.
    const realAgentId = existingSession?.agentId || sessionKey;
    const wasEphemeral = existingSession?.isEphemeral === true;

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

    // Gate BEFORE opening the stream or replaying the backlog — otherwise a
    // cross-tenant caller would receive another agent's buffered events.
    const denial = await requireAgentOwnership(
      c,
      session.agentId || sessionKey
    );
    if (denial) return denial;

    // Check connection limits
    if (sseManager.totalConnections() >= MAX_TOTAL_CONNECTIONS) {
      return c.json(
        { success: false, error: "Server connection limit reached" },
        429
      );
    }

    // Use conversationId as the SSE connection key (matches broadcast calls)
    const sseKey = session.conversationId;
    if (sseManager.connectionCount(sseKey) >= MAX_CONNECTIONS_PER_AGENT) {
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
      sseManager.addConnection(sseKey, stream);

      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({
          agentId: session.agentId || sessionKey,
          timestamp: Date.now(),
        }),
      });

      for (const entry of sseManager.getRecentEvents(sseKey)) {
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
        sseManager.removeConnection(sseKey, stream);
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

    // Gate ownership BEFORE parsing body / uploading files. The path param is
    // usually a sessionKey (conversationId); resolve to the real agentId when
    // a session exists.
    const preSession = await sessMgr.getSession(agentId);
    const ownershipDenial = await requireAgentOwnership(
      c,
      preSession?.agentId || agentId
    );
    if (ownershipDenial) return ownershipDenial;

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
    const session = preSession;
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
          source: session.intent?.kind === "watcher_run" ? "watcher-run" : "direct-api",
          traceparent: traceparent || undefined,
          dryRun: session.dryRun || false,
          intent: session.intent,
        },
        agentOptions: remainingOptions,
        networkConfig: session.networkConfig || settingsNetwork,
        mcpConfig: settingsMcpServers
          ? { mcpServers: settingsMcpServers }
          : session.mcpConfig,
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
        return errorResponse(c, "Missing requestId or decision", 400);
      }
      const validDecisions = ["1h", "24h", "always", "deny"];
      if (!validDecisions.includes(decision)) {
        return errorResponse(
          c,
          `Invalid decision. Must be one of: ${validDecisions.join(", ")}`,
          400
        );
      }
      const result = await approveHandler(requestId, decision);
      if (!result.success) {
        return errorResponse(c, result.error || "Approval failed", 400);
      }
      return c.json({ success: true });
    });
  }

  logger.debug("Hono Agent API routes registered");

  return app;
}
