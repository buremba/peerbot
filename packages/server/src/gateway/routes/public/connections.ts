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
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import {
  PlatformAdapterConfigSchema,
  SupportedPlatformSchema,
} from "../schemas/platform-config.js";
import { verifyOwnedAgentAccess } from "../shared/agent-ownership.js";
import { requireSession } from "../shared/helpers.js";

const logger = createLogger("connection-routes");
const TAG = "Connections";
const ErrorResponseSchema = z.object({ error: z.string() });
const FlexibleObjectSchema = z.record(z.string(), z.unknown());

const UserConfigScopeSchema = z.enum([
  "model",
  "view-model",
  "system-prompt",
  "skills",
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
  const channels = await manager.listHistoryChannels(connectionId);
  return channels[0];
}

// Per-platform config Zod schemas live in ../schemas/platform-config.ts —
// the single registry for platform config validation + OpenAPI docs.

const PlatformConnectionSchema = z.object({
  id: z.string(),
  platform: SupportedPlatformSchema,
  agentId: z.string().optional(),
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
  agentId: z.string().optional(),
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

    // Info-level so platform webhook traffic (Slack interactivity, Telegram
    // updates, etc.) is visible in production logs without flipping LOG_LEVEL.
    logger.info(
      { connectionId, platform: connection.platform },
      "Inbound platform webhook"
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
    agentMetadataStore: Pick<AgentConfigStore, "getMetadata">;
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
      { platform: string; defaultTarget?: string; agentId?: string }
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
          // Expose the owning agent so test scripts can route to the
          // configured agent instead of a placeholder like `test-slack`.
          agentId: connection.agentId,
        });
      }
    }

    return c.json([...targets.values()]);
  };

  app.get("/internal/connections/platforms", listLocalTestPlatforms);
  app.get("/internal/connections/test-targets", listLocalTestTargets);

  app.openapi(ListConnectionsRoute, async (c): Promise<any> => {
    const session = await requireSession(c);
    if (session instanceof Response) return session;

    const { platform, agentId } = c.req.valid("query");
    let connections;

    if (agentId) {
      const access = await verifyOwnedAgentAccess(
        session,
        agentId,
        accessConfig
      );
      if (!access.authorized) {
        return c.json({ error: "Forbidden" }, 403);
      }

      connections = await manager.listConnections({
        platform: platform || undefined,
        agentId,
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
    const session = await requireSession(c);
    if (session instanceof Response) return session;

    const { id } = c.req.valid("param");
    const connection = await manager.getConnection(id);
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }
    if (connection.agentId) {
      const access = await verifyOwnedAgentAccess(
        session,
        connection.agentId,
        accessConfig
      );
      if (!access.authorized) {
        return c.json({ error: "Forbidden" }, 403);
      }
    } else if (!session.isAdmin && session.settingsMode !== "admin") {
      // An unbound connection (no owning agent) carries no per-agent ACL, and
      // `manager.getConnection` is a global lookup. Without this gate any
      // authenticated settings session could read another tenant's unbound
      // connection — including its `config` secrets (botToken, signingSecret,
      // clientSecret, credentials). Mirror the admin requirement the list
      // route applies to unscoped reads.
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.json(connection);
  });

  return app;
}
