/**
 * Connection routes + webhook endpoint.
 *
 * Webhook: POST /api/v1/webhooks/:connectionId
 * Read-only (auth: settings session cookie):
 *   GET    /api/v1/connections
 *   GET    /api/v1/connections/:id
 *   GET    /api/v1/connections/:id/sandboxes
 */

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { AgentConfigStore } from "@lobu/core";
import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager";
import { verifyAgentAccess } from "./agent-access";
import { verifySettingsSession } from "./settings-auth";

const logger = createLogger("connection-routes");
const TAG = "Connections";
const ErrorResponseSchema = z.object({ error: z.string() });
const FlexibleObjectSchema = z.record(z.string(), z.unknown());

const UserConfigScopeSchema = z.enum([
  "model",
  "view-model",
  "system-prompt",
  "skills",
  "schedules",
  "permissions",
  "packages",
]);

const ConnectionSettingsSchema = z.object({
  allowFrom: z.array(z.string()).optional().openapi({
    description:
      "User IDs allowed to interact with this connection. Omit to allow all; empty array blocks all.",
  }),
  allowGroups: z.boolean().optional().openapi({
    description: "Whether group messages are allowed (default true).",
  }),
  userConfigScopes: z.array(UserConfigScopeSchema).optional().openapi({
    description:
      "Scopes that end users are allowed to customize. Empty = no restrictions.",
  }),
});

const LOCAL_TEST_PLATFORMS = ["slack", "telegram", "whatsapp"] as const;

async function getLocalTestDefaultTarget(
  manager: ChatInstanceManager,
  connectionId: string
): Promise<string | undefined> {
  const redis = manager.getServices().getQueue().getRedisClient();
  const prefix = `chat:history:${connectionId}:`;
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      20
    );
    cursor = nextCursor;

    const match = keys[0];
    if (match) {
      return match.slice(prefix.length);
    }
  } while (cursor !== "0");

  return undefined;
}

// --- Per-platform config Zod schemas (with OpenAPI annotations + platform discriminator) ---
// Field definitions mirror @lobu/core platform schemas; gateway adds .openapi()
// and the `platform` literal discriminator for the API layer.

const TelegramConfigSchema = z.object({
  platform: z.literal("telegram"),
  botToken: z.string().optional().openapi({
    description:
      "Telegram bot token from BotFather. Falls back to TELEGRAM_BOT_TOKEN env var.",
  }),
  mode: z.enum(["auto", "webhook", "polling"]).optional().openapi({
    description: "Runtime mode: auto (default), webhook, or polling.",
  }),
  secretToken: z.string().optional().openapi({
    description:
      "Webhook secret token for x-telegram-bot-api-secret-token verification.",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
  apiBaseUrl: z
    .string()
    .optional()
    .openapi({ description: "Custom Telegram API base URL." }),
});

const SlackConfigSchema = z.object({
  platform: z.literal("slack"),
  botToken: z.string().optional().openapi({
    description: "Bot token (xoxb-...). Required for single-workspace mode.",
  }),
  botUserId: z.string().optional().openapi({
    description: "Bot user ID (fetched automatically if omitted).",
  }),
  signingSecret: z
    .string()
    .optional()
    .openapi({ description: "Signing secret for webhook verification." }),
  clientId: z.string().optional().openapi({
    description: "Slack app client ID (required for OAuth / multi-workspace).",
  }),
  clientSecret: z.string().optional().openapi({
    description:
      "Slack app client secret (required for OAuth / multi-workspace).",
  }),
  encryptionKey: z.string().optional().openapi({
    description:
      "Base64-encoded 32-byte AES-256-GCM key for encrypting stored bot tokens.",
  }),
  installationKeyPrefix: z.string().optional().openapi({
    description:
      "State key prefix for workspace installations (default: slack:installation).",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const DiscordConfigSchema = z.object({
  platform: z.literal("discord"),
  botToken: z
    .string()
    .optional()
    .openapi({ description: "Discord bot token." }),
  applicationId: z
    .string()
    .optional()
    .openapi({ description: "Discord application ID." }),
  publicKey: z.string().optional().openapi({
    description: "Application public key for webhook signature verification.",
  }),
  mentionRoleIds: z.array(z.string()).optional().openapi({
    description:
      "Role IDs that trigger mention handlers (in addition to direct mentions).",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const WhatsAppConfigSchema = z.object({
  platform: z.literal("whatsapp"),
  accessToken: z.string().optional().openapi({
    description: "System User access token for WhatsApp Cloud API.",
  }),
  phoneNumberId: z
    .string()
    .optional()
    .openapi({ description: "WhatsApp Business phone number ID." }),
  appSecret: z.string().optional().openapi({
    description:
      "Meta App Secret for webhook HMAC-SHA256 signature verification.",
  }),
  verifyToken: z
    .string()
    .optional()
    .openapi({ description: "Verify token for webhook challenge-response." }),
  apiVersion: z
    .string()
    .optional()
    .openapi({ description: "Meta Graph API version (default: v21.0)." }),
  userName: z.string().optional().openapi({ description: "Bot display name." }),
});

const TeamsConfigSchema = z.object({
  platform: z.literal("teams"),
  appId: z.string().optional().openapi({ description: "Microsoft App ID." }),
  appPassword: z
    .string()
    .optional()
    .openapi({ description: "Microsoft App Password." }),
  appTenantId: z
    .string()
    .optional()
    .openapi({ description: "Microsoft App Tenant ID." }),
  appType: z
    .enum(["MultiTenant", "SingleTenant"])
    .optional()
    .openapi({ description: "Microsoft App Type." }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const GoogleChatConfigSchema = z.object({
  platform: z.literal("gchat"),
  credentials: z.string().optional().openapi({
    description:
      "Service account credentials JSON string. Defaults to GOOGLE_CHAT_CREDENTIALS env var.",
  }),
  useApplicationDefaultCredentials: z.boolean().optional().openapi({
    description:
      "Use Application Default Credentials (ADC) instead of service account JSON.",
  }),
  endpointUrl: z.string().optional().openapi({
    description:
      "HTTP endpoint URL for button click actions. Required for HTTP endpoint apps.",
  }),
  googleChatProjectNumber: z.string().optional().openapi({
    description:
      "Google Cloud project number for verifying webhook JWTs. Defaults to GOOGLE_CHAT_PROJECT_NUMBER env var.",
  }),
  impersonateUser: z.string().optional().openapi({
    description:
      "User email for domain-wide delegation. Defaults to GOOGLE_CHAT_IMPERSONATE_USER env var.",
  }),
  pubsubAudience: z.string().optional().openapi({
    description:
      "Expected audience for Pub/Sub push JWT verification. Defaults to GOOGLE_CHAT_PUBSUB_AUDIENCE env var.",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const PlatformAdapterConfigSchema = z.discriminatedUnion("platform", [
  TelegramConfigSchema,
  SlackConfigSchema,
  DiscordConfigSchema,
  WhatsAppConfigSchema,
  TeamsConfigSchema,
  GoogleChatConfigSchema,
]);

/** Derived from the discriminated union — no separate list to maintain. */
const SUPPORTED_PLATFORMS = PlatformAdapterConfigSchema.options.map(
  (s) => s.shape.platform.value
) as [string, ...string[]];
const SupportedPlatformSchema = z.enum(SUPPORTED_PLATFORMS);

const PlatformConnectionSchema = z.object({
  id: z.string(),
  platform: SupportedPlatformSchema,
  templateAgentId: z.string().optional(),
  config: PlatformAdapterConfigSchema,
  settings: ConnectionSettingsSchema,
  metadata: FlexibleObjectSchema,
  status: z.enum(["active", "stopped", "error"]),
  errorMessage: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ConnectionIdParamsSchema = z.object({
  id: z.string(),
});

const ListConnectionsQuerySchema = z.object({
  platform: SupportedPlatformSchema.optional(),
  templateAgentId: z.string().optional(),
});

const ListConnectionsRoute = createRoute({
  method: "get",
  path: "/api/v1/connections",
  tags: [TAG],
  summary: "List platform connections",
  description:
    "Lists Chat SDK-backed connections visible to the current settings session.",
  request: {
    query: ListConnectionsQuerySchema,
  },
  responses: {
    200: {
      description: "Connections",
      content: {
        "application/json": {
          schema: z.object({
            connections: z.array(PlatformConnectionSchema),
          }),
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Forbidden",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

const GetConnectionRoute = createRoute({
  method: "get",
  path: "/api/v1/connections/{id}",
  tags: [TAG],
  summary: "Get a platform connection",
  request: {
    params: ConnectionIdParamsSchema,
  },
  responses: {
    200: {
      description: "Connection",
      content: {
        "application/json": {
          schema: PlatformConnectionSchema,
        },
      },
    },
    401: {
      description: "Unauthorized",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    403: {
      description: "Forbidden",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Connection not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
});

export function createConnectionWebhookRoutes(
  manager: ChatInstanceManager
): Hono {
  const router = new Hono();

  router.post("/api/v1/webhooks/:connectionId", async (c) => {
    const connectionId = c.req.param("connectionId");
    if (!connectionId) {
      return c.json({ error: "Missing connectionId" }, 400);
    }

    // Verify connection exists before processing
    const connection = await manager.getConnection(connectionId);
    if (!connection) {
      logger.warn({ connectionId }, "Webhook received for unknown connection");
      return c.json({ error: "Connection not found" }, 404);
    }

    logger.debug(
      { connectionId, platform: connection.platform },
      "Processing webhook"
    );

    try {
      const response = await manager.handleWebhook(connectionId, c.req.raw);
      return response;
    } catch (error) {
      logger.error({ connectionId, error: String(error) }, "Webhook error");
      return c.json({ error: "Webhook processing failed" }, 500);
    }
  });

  return router;
}

export function createConnectionCrudRoutes(
  manager: ChatInstanceManager,
  accessConfig: {
    userAgentsStore: UserAgentsStore;
    agentMetadataStore: Pick<AgentConfigStore, "getMetadata" | "listSandboxes">;
  }
): OpenAPIHono {
  const app = new OpenAPIHono();

  const listLocalTestPlatforms = async (c: any): Promise<any> => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }

    const supported = new Set<string>(LOCAL_TEST_PLATFORMS);
    const connections = await manager.listConnections();
    const platforms = [
      ...new Set(
        connections
          .filter(
            (connection) =>
              connection.status === "active" &&
              manager.has(connection.id) &&
              supported.has(connection.platform)
          )
          .map((connection) => connection.platform)
      ),
    ];

    return c.json(platforms);
  };

  const listLocalTestTargets = async (c: any): Promise<any> => {
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: "Not found" }, 404);
    }

    const supported = new Set<string>(LOCAL_TEST_PLATFORMS);
    const connections = await manager.listConnections();
    const targets = new Map<
      string,
      { platform: string; defaultTarget?: string }
    >();

    for (const connection of connections) {
      if (
        connection.status !== "active" ||
        !manager.has(connection.id) ||
        !supported.has(connection.platform)
      ) {
        continue;
      }

      if (!targets.has(connection.platform)) {
        targets.set(connection.platform, {
          platform: connection.platform,
          defaultTarget: await getLocalTestDefaultTarget(
            manager,
            connection.id
          ),
        });
      }
    }

    return c.json([...targets.values()]);
  };

  app.get("/internal/connections/platforms", listLocalTestPlatforms);
  app.get("/internal/connections/test-targets", listLocalTestTargets);

  // Internal endpoint for server-to-server connection listing (no auth required)
  const listAllConnections = async (c: any) => {
    const { platform, templateAgentId } = c.req.query();
    const connections = await manager.listConnections({
      platform: platform || undefined,
      templateAgentId: templateAgentId || undefined,
    });
    return c.json({ connections });
  };
  app.get("/internal/connections", listAllConnections);

  app.openapi(ListConnectionsRoute, async (c): Promise<any> => {
    const session = verifySettingsSession(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { platform, templateAgentId } = c.req.valid("query");
    let connections;

    if (templateAgentId) {
      if (!(await verifyAgentAccess(session, templateAgentId, accessConfig))) {
        return c.json({ error: "Forbidden" }, 403);
      }

      connections = await manager.listConnections({
        platform: platform || undefined,
        templateAgentId,
      });
    } else {
      if (!session.isAdmin && session.settingsMode !== "admin") {
        return c.json({ error: "Forbidden" }, 403);
      }
      connections = await manager.listConnections({
        platform: platform || undefined,
      });
    }

    return c.json({ connections });
  });

  app.openapi(GetConnectionRoute, async (c): Promise<any> => {
    const session = verifySettingsSession(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const { id } = c.req.valid("param");
    const connection = await manager.getConnection(id);
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }
    if (
      connection.templateAgentId &&
      !(await verifyAgentAccess(
        session,
        connection.templateAgentId,
        accessConfig
      ))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.json(connection);
  });

  // GET /api/v1/connections/:id/sandboxes — list sandbox agents for a connection
  app.get("/api/v1/connections/:id/sandboxes", async (c): Promise<any> => {
    const session = verifySettingsSession(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const id = c.req.param("id");
    const connection = await manager.getConnection(id);
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }
    if (
      connection.templateAgentId &&
      !(await verifyAgentAccess(
        session,
        connection.templateAgentId,
        accessConfig
      ))
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    if (
      !connection.templateAgentId &&
      !session.isAdmin &&
      session.settingsMode !== "admin"
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const sandboxes = await accessConfig.agentMetadataStore.listSandboxes(id);
    return c.json({
      sandboxes: sandboxes.map((s) => ({
        agentId: s.agentId,
        name: s.name,
        description: s.description || "",
        owner: s.owner,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt ?? null,
      })),
    });
  });

  return app;
}
