import { randomUUID } from "node:crypto";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
  type AgentConfigStore,
  createLogger,
  createRootSpan,
  generateWorkerToken,
  type McpServerConfig,
  type NetworkConfig,
  normalizeDomainPatterns,
  verifyWorkerToken,
} from "@lobu/core";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bindRequestAbortToStream } from "../../../events/sse-abort-bridge.js";
import { z } from "zod";
import { DEFAULT_AGENT_ID } from "../../../auth/default-provisioning.js";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import { getRevokedTokenStore } from "../../auth/revoked-token-store.js";
import {
  createApiAuthMiddleware,
  TOKEN_EXPIRATION_MS,
} from "../../auth/api-auth-middleware.js";
import type { ExternalAuthClient } from "../../auth/external/client.js";
import type { AgentSettingsStore } from "../../auth/settings/agent-settings-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { QueueProducer } from "../../infrastructure/queue/queue-producer.js";
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
  provider: z.literal("claude").default("claude").optional(),
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

// Validators below short-circuit on the first failure and the public API
// surfaces only that message as the flat `error` string — so each returns
// `string | null` (message, or null when the value is valid).

function validateDomainPattern(pattern: string): string | null {
  if (!pattern || typeof pattern !== "string") {
    return "Domain pattern must be a non-empty string";
  }
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed === "*") {
    return "Bare wildcard '*' is not allowed";
  }
  if (trimmed.includes("://")) {
    return `Domain pattern cannot contain protocol: ${pattern}`;
  }
  if (trimmed.includes("/")) {
    return `Domain pattern cannot contain path: ${pattern}`;
  }
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
    if (!domains) continue;
    for (const domain of domains) {
      const error = validateDomainPattern(domain!);
      if (error) return error;
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
    resolvedAgentId: string,
    sessionForTenantCheck?: { organizationId?: string } | null
  ): Promise<Response | null> {
    const deny = () =>
      c.json({ success: false, error: "Forbidden" }, 403) as Response;

    // Tenant guard: agent-id-string ownership is per (platform, userId,
    // agentId) — but the agentId string can repeat across tenants (the
    // global `DEFAULT_AGENT_ID` constant, or two orgs that happen to share
    // an id). If a session belongs to org A and the caller's auth context
    // says org B, deny BEFORE any ownership check — otherwise org B would
    // pass ownership against its own agent-X and reach org A's session
    // routed by the same agent-X. Returning the same `Forbidden` shape as
    // ownership keeps the response uniform (no enumeration oracle on which
    // check failed). Routes that load a session before calling this MUST
    // pass it in; createAgent has no pre-existing session and passes null.
    if (sessionForTenantCheck?.organizationId) {
      const callerOrgId =
        (c.get("organizationId") as string | undefined) ??
        c.get("authContext")?.organizationId;
      if (
        callerOrgId &&
        sessionForTenantCheck.organizationId !== callerOrgId
      ) {
        return deny();
      }
    }

    // Defense-in-depth for the tenant guard above. That guard only fires when
    // the auth method populated an org (PAT bridge / worker token / external
    // OAuth all set one). The settings-session COOKIE path authenticates a
    // userId but carries NO org, so the guard above is a no-op for it — yet
    // `verifyOwnedAgentAccess` authorizes on (platform, userId, agentId) and
    // returns the CALLER's org, never the session's. Without this, a cookie
    // session for org B could read org A's session via a shared agentId (the
    // global DEFAULT_AGENT_ID). So compare the org ownership actually resolved
    // to against the session's, and deny on a definite mismatch. An undefined
    // on either side falls through unchanged — this never denies a legitimate
    // same-org caller, it only closes the cross-org case the guard above misses.
    const authorizeOwnership = (access: {
      authorized: boolean;
      organizationId?: string;
    }): Response | null => {
      if (!access.authorized) return deny();
      const tenantOrg = sessionForTenantCheck?.organizationId;
      if (
        tenantOrg &&
        access.organizationId &&
        access.organizationId !== tenantOrg
      ) {
        return deny();
      }
      return null;
    };

    const bearer = tokenFromHeader(c);

    // 1. Settings session cookie (or injected auth provider for embedded mode).
    const settingsSession = await verifySettingsSession(c);
    if (settingsSession) {
      const access = await verifyOwnedAgentAccess(
        settingsSession,
        resolvedAgentId,
        ownershipAccessConfig
      );
      return authorizeOwnership(access);
    }

    if (!bearer) return deny();

    // 2. Worker token — must target its own agent.
    const workerData = verifyWorkerToken(bearer);
    if (workerData) {
      const tokenAge = Date.now() - workerData.timestamp;
      if (tokenAge > TOKEN_EXPIRATION_MS) return deny();
      if (
        workerData.jti &&
        (await getRevokedTokenStore().isRevoked(workerData.jti))
      ) {
        return deny();
      }
      const workerAgentId = workerData.agentId || workerData.userId;
      return workerAgentId && workerAgentId === resolvedAgentId ? null : deny();
    }

    // 3. External OAuth (Lobu / memory-url userinfo).
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
          return authorizeOwnership(access);
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

    const normalizedNetworkConfig = networkConfig
      ? normalizeNetworkConfig(networkConfig as NetworkConfig)
      : undefined;

    // Validate network config
    if (normalizedNetworkConfig) {
      const error = validateNetworkConfig(normalizedNetworkConfig);
      if (error) {
        return c.json({ success: false, error }, 400);
      }
    }

    // Validate MCP config
    if (mcpServers) {
      const error = validateMcpConfig(
        mcpServers as Record<string, McpServerConfig>
      );
      if (error) {
        return c.json({ success: false, error }, 400);
      }
    }

    // Resolve the target agent. Two flows, no third:
    //   - caller pinned agentId → use it (with ownership check)
    //   - no agentId → route to the org's default agent (`owletto-default`)
    // The third flow that used to live here ("ephemeral": generate a UUID
    // and auto-install providers on it) is gone — it created a phantom
    // agent per chat, never used the user's actual default agent, and the
    // saveSettings UPDATE silently no-op'd on a row that didn't exist yet.
    // Default-agent provisioning runs at signup (`ensureDefaultAgent`) and
    // already populates `installed_providers` from system-key providers,
    // so the row exists with credentials by the time chat reaches here.
    //
    // Org resolution: `createLobuAuthBridge` (outer middleware on `/lobu/*`)
    // sets `c.get("organizationId")` from the PAT — that's the common path
    // for `lobu chat -c local`. `createApiAuthMiddleware` (this app's inner
    // middleware) sets `authContext` for the worker-token and external-OAuth
    // paths. Check both.
    const callerOrgId =
      (c.get("organizationId") as string | undefined) ??
      c.get("authContext")?.organizationId;
    let agentId = requestedAgentId?.trim();
    if (!agentId) {
      if (!callerOrgId) {
        return c.json(
          {
            success: false,
            error:
              "Cannot resolve default agent: caller has no organization context",
          },
          400
        );
      }
      const defaultMeta = await ownershipMetadataStore?.getMetadata(
        DEFAULT_AGENT_ID
      );
      if (!defaultMeta || defaultMeta.organizationId !== callerOrgId) {
        return c.json(
          {
            success: false,
            error: `Default agent "${DEFAULT_AGENT_ID}" not provisioned for this organization. Run lobu apply or create an agent first.`,
          },
          404
        );
      }
      agentId = DEFAULT_AGENT_ID;
    }

    const ownershipDenial = await requireAgentOwnership(c, agentId);
    if (ownershipDenial) return ownershipDenial;

    // Stamp the worker token with the agent's owning org so the egress
    // proxy's per-tenant gates (grant/deny, judge cache, judge policy)
    // can scope decisions by org. Prefer the agent's metadata; fall back
    // to the caller's auth-context org for the default-agent route where
    // the lookup above already proved ownership.
    const metadataOrgId = ownershipMetadataStore
      ? (await ownershipMetadataStore.getMetadata(agentId))?.organizationId
      : undefined;
    const tokenOrganizationId = metadataOrgId ?? callerOrgId;

    const watcherIntent = intent?.kind === "watcher_run" ? intent : null;
    // userId backs `conversationId = ${agentId}_${userId}[_${thread}]`, which
    // is the session-store key. For pinned agents the agentId is per-org so
    // collisions are bounded to a single tenant. For the default-agent path
    // agentId is a GLOBAL constant (DEFAULT_AGENT_ID) — so the userId must
    // be unique-per-caller to keep conversationIds globally unique and
    // prevent cross-tenant session resume. Prefer the request body, then the
    // authenticated caller's userId (per-org-unique via the auth bridge),
    // then fall back to agentId (only for pinned agents where that's safe).
    const authUserId = c.get("authContext")?.userId;
    const userId = watcherIntent
      ? `watcher_${watcherIntent.watcherId}`
      : requestedUserId || authUserId || agentId;
    const effectiveThread = watcherIntent
      ? `run_${watcherIntent.runId}`
      : thread;
    const effectiveForceNew = watcherIntent ? true : forceNew;
    const effectiveDryRun = watcherIntent ? false : dryRun || false;

    // Build composite conversationId for user-specific sessions.
    // Uses _ separator (colons not allowed in BullMQ custom IDs). Watcher
    // automation gets one deterministic one-shot session per run and never
    // resumes human/API sessions such as marketing_marketing.
    //
    // Tenant-scope: include tokenOrganizationId so default-agent sessions
    // (DEFAULT_AGENT_ID is a global constant) AND pinned-agent sessions
    // (agentId is a per-org-unique row id, but two orgs can share the same
    // id string) never collide across tenants in the in-memory session
    // store. The resume guard below catches in-flight collisions; the org
    // suffix prevents `forceNew` from silently overwriting another tenant's
    // session at setSession time.
    //
    // Watcher sessions are EXEMPT: their conversationId is already globally
    // unique via the DB-serial watcherId + runId, and downstream correlation
    // relies on the exact `..._watcher_<id>_run_<id>` shape — the worker
    // session key AND the API/SSE owner-routing key (unified-thread-consumer)
    // both derive from this conversationId. Injecting `_<org>_` mid-id splits
    // `watcher_<id>` from `run_<id>`, breaking watcher→worker dispatch (caught
    // by the sdk-e2e gate). Keep the prod-proven shape for the watcher path.
    const orgScope =
      tokenOrganizationId && !watcherIntent ? `_${tokenOrganizationId}` : "";
    const conversationId = effectiveThread
      ? `${agentId}_${userId}${orgScope}_${effectiveThread}`
      : `${agentId}_${userId}${orgScope}`;
    const channelId = `api_${userId}`;
    const deploymentName = `api-${agentId.slice(0, 8)}`;

    // Try to resume existing session (unless forceNew is requested).
    // Refuse cross-tenant resume defensively: even though the userId fallback
    // above is per-org-unique for the default-agent path, a future caller that
    // bypasses the auth bridge or passes a colliding requestedUserId would
    // otherwise resume another tenant's session and leak its worker token.
    if (!effectiveForceNew) {
      const existing = await sessMgr.getSession(conversationId);
      if (
        existing &&
        existing.organizationId &&
        tokenOrganizationId &&
        existing.organizationId !== tokenOrganizationId
      ) {
        logger.warn(
          `Refusing to resume session ${conversationId} for org ${tokenOrganizationId}: belongs to org ${existing.organizationId}`
        );
        return c.json({ success: false, error: "Forbidden" }, 403);
      }
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
            organizationId: tokenOrganizationId,
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
      organizationId: tokenOrganizationId,
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
      ...(tokenOrganizationId ? { organizationId: tokenOrganizationId } : {}),
      dryRun: effectiveDryRun,
      intent: watcherIntent ?? undefined,
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
      session.agentId || sessionKey,
      session
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
      existingSession?.agentId || sessionKey,
      existingSession
    );
    if (denial) return denial;

    // Close connections + drop backlog so a later connection with the same
    // key (rare, but possible with deterministic conversationIds) can't
    // replay stale completion events from this deleted session.
    sseManager.closeAgent(sessionKey, "agent_deleted");

    // Delete the session only. Agent rows persist — they're owned by the
    // org (declared agents) or the user's personal org (the default agent).
    // The phantom-ephemeral-agent cleanup that used to run here is gone:
    // there are no phantom rows to clean up under the default-agent flow.
    await sessMgr.deleteSession(sessionKey);
    logger.info(`Deleted agent session ${sessionKey}`);

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
      session.agentId || sessionKey,
      session
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

    // Return SSE stream.
    //
    // Hono's `streamSSE` only fires `stream.onAbort()` when the underlying
    // `ReadableStream.cancel()` runs — which doesn't happen on abnormal
    // disconnects (LB idle timeout, intermediate proxy kill, client hard
    // close). On Node + current Bun, `signal.abort` is the only reliable
    // trigger. Without it the heartbeat interval keeps firing, the
    // `sseManager` retains the dead connection, and the `while !aborted`
    // loop never exits — the same retain pattern fixed for the invalidation
    // streams in #833. Refs #782.
    const requestSignal = c.req.raw.signal;

    return streamSSE(c, async (stream) => {
      // If the client already aborted between handler invocation and stream
      // body execution, bail out before registering anything.
      if (requestSignal?.aborted) {
        return;
      }

      // Idempotent cleanup latch wired up FIRST so an abort during the
      // initial writeSSE / backlog-replay window below routes through the
      // same teardown path. Without this, an abort between
      // `sseManager.addConnection` and `stream.onAbort(cleanup)` would leak
      // the registration in the manager.
      let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
      let connectionAdded = false;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (connectionAdded) {
          sseManager.removeConnection(sseKey, stream);
        }
        logger.info(`SSE connection closed for session ${sseKey}`);
      };

      stream.onAbort(cleanup);
      const detachAbortBridge = bindRequestAbortToStream(requestSignal, stream);

      sseManager.addConnection(sseKey, stream);
      connectionAdded = true;

      try {
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

        heartbeatInterval = setInterval(async () => {
          try {
            await stream.writeSSE({
              event: "ping",
              data: JSON.stringify({ timestamp: Date.now() }),
            });
          } catch {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
          }
        }, 30000);

        while (!stream.aborted && !stream.closed) {
          await stream.sleep(1000);
        }
      } finally {
        detachAbortBridge();
        cleanup();
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
      preSession?.agentId || agentId,
      preSession
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
        ...(session.organizationId
          ? { organizationId: session.organizationId }
          : {}),
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
