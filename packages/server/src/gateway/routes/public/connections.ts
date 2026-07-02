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
import { type Context, Hono } from "hono";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChatInstanceManager } from "../../connections/chat-instance-manager.js";
import type { PlatformConnection } from "../../connections/types.js";
import {
  PlatformAdapterConfigSchema,
  SupportedPlatformSchema,
} from "../schemas/platform-config.js";
import { verifyOwnedAgentAccess } from "../shared/agent-ownership.js";
import { requireSession } from "../shared/helpers.js";
import {
  ErrorResponseSchema,
  errorResponses,
} from "../shared/openapi-responses.js";
import { listConnectionFeeds } from "../../../feeds/connection-feeds.js";

const logger = createLogger("connection-routes");
const TAG = "Connections";
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

/**
 * Shared scaffolding for the dev-only local-test endpoints: refuse in
 * production, then return the active connections on a locally-testable
 * platform. Returns `null` to signal the production refusal (the caller maps
 * it to a 404). Status-based, not warm-instance-based: connections hydrate
 * lazily, so an active row with no local instance is still usable.
 */
async function getActiveLocalTestConnections(
  manager: ChatInstanceManager
): Promise<PlatformConnection[] | null> {
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  const supported = new Set<string>(LOCAL_TEST_PLATFORMS);
  const connections = await manager.listConnections();
  return connections.filter(
    (connection) =>
      connection.status === "active" && supported.has(connection.platform)
  );
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
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      403: "Forbidden",
    }),
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
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      403: "Forbidden",
      404: "Connection not found",
    }),
  },
});

const FeedSpecSchema = z.object({
  id: z.string(),
  feedKey: z.string(),
  kind: z.enum(["collected", "streaming", "virtual"]),
  connectionId: z.string(),
  label: z.string(),
  status: z.enum(["active", "paused", "error"]),
  virtual: z.boolean(),
  lastSyncAt: z.string().nullable(),
  itemsCollected: z.number(),
  targetAgentId: z.string().nullable().optional(),
});

const ListConnectionFeedsRoute = createRoute({
  method: "get",
  path: "/api/v1/connections/{id}/feeds",
  tags: [TAG],
  summary: "List a connection's feeds",
  description:
    "Lists every feed (all kinds) on a connection, fenced to its organization.",
  request: {
    params: ConnectionIdParamsSchema,
  },
  responses: {
    200: {
      description: "Feeds",
      content: {
        "application/json": {
          schema: z.object({ feeds: z.array(FeedSpecSchema) }),
        },
      },
    },
    ...errorResponses(ErrorResponseSchema, {
      401: "Unauthorized",
      403: "Forbidden",
      404: "Connection not found",
    }),
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

    // Resolve the `connections` row (chat platforms + ingest-only webhook
    // connections). A miss is NOT necessarily a 404: the id may name a CONNECTOR
    // connection (`connections` table) that registered a provider webhook at
    // connect time — `handleIngestWebhook` bridges to that row. So fall through
    // to the ingest handler on a miss and let it decide (404 only when neither
    // table has a webhook-bearing row).
    const connection = await manager.getConnection(connectionId);

    // Info-level so platform webhook traffic (Slack interactivity, Telegram
    // updates, etc.) is visible in production logs without flipping LOG_LEVEL.
    // Never log the request URL/query on this route — webhook ingest
    // connections may carry their auth token in `?token=`.
    logger.info(
      { connectionId, platform: connection?.platform ?? "connector-webhook" },
      "Inbound platform webhook"
    );

    try {
      // Ingest-only webhook connections (#1235) and connector-owned webhooks
      // both have no Chat SDK instance to warm — branch before handleWebhook's
      // lazy hydration path. Pass the socket peer address so the per-source
      // pre-auth rate limit keys on the real client even without TRUSTED_PROXY
      // (getClientIP only trusts X-Forwarded-For behind a trusted proxy).
      if (!connection || connection.platform === "webhook") {
        return await manager.handleIngestWebhook(
          connectionId,
          c.req.raw,
          c.var.peerRemoteAddress
        );
      }
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

  const listLocalTestPlatforms = async (c: Context): Promise<Response> => {
    const connections = await getActiveLocalTestConnections(manager);
    if (!connections) {
      return c.json({ error: "Not found" }, 404);
    }

    const platforms = [
      ...new Set(connections.map((connection) => connection.platform)),
    ];

    return c.json(platforms);
  };

  const listLocalTestTargets = async (c: Context): Promise<Response> => {
    const connections = await getActiveLocalTestConnections(manager);
    if (!connections) {
      return c.json({ error: "Not found" }, 404);
    }

    const targets = new Map<
      string,
      { platform: string; defaultTarget?: string; agentId?: string }
    >();

    for (const connection of connections) {
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

  app.openapi(ListConnectionFeedsRoute, async (c): Promise<any> => {
    const session = await requireSession(c);
    if (session instanceof Response) return session;

    const { id } = c.req.valid("param");
    const connection = await manager.getConnection(id);
    if (!connection) {
      return c.json({ error: "Connection not found" }, 404);
    }
    // Same ACL as GetConnection: owned-agent access, else admin-only for an
    // unbound connection (a global lookup with no per-agent ACL).
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
      return c.json({ error: "Forbidden" }, 403);
    }

    if (!connection.organizationId) {
      return c.json({ feeds: [] });
    }
    const feeds = await listConnectionFeeds(connection.organizationId, id);
    return c.json({ feeds });
  });

  // Revoke a MANAGED install (e.g. an "Add to Slack" workspace). Unlike the
  // generic connection delete, this purges the install + its bot token via the
  // provider store and tombstones the unified `connections` row. A managed
  // install is unbound (no owning agent), so — mirroring the unbound-read gate
  // above — it requires an admin/settings-admin session. `:id` is the
  // `connections` bigint id (what the UI holds), not a runtime id.
  app.post("/api/v1/connections/:id/revoke", async (c): Promise<Response> => {
    const session = await requireSession(c);
    if (session instanceof Response) return session;
    if (!session.isAdmin && session.settingsMode !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const connectionId = Number(c.req.param("id"));
    if (!Number.isFinite(connectionId)) {
      return c.json({ error: "Invalid connection id" }, 400);
    }
    try {
      const result = await manager.revokeManagedConnection(connectionId);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === "Connection not found" ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  return app;
}
