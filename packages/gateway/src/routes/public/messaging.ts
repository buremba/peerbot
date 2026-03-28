#!/usr/bin/env bun

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@lobu/core";
import { z } from "zod";
import { createApiAuthMiddleware } from "../../auth/api-auth-middleware";
import type { CliTokenService } from "../../auth/cli/token-service";
import type { PlatformRegistry } from "../../platform";

const logger = createLogger("messaging-routes");

// ============================================================================
// Request/Response Schemas
// ============================================================================

const SlackRoutingInfoSchema = z.object({
  channel: z.string().describe("Slack channel ID"),
  thread: z.string().optional().describe("Thread timestamp for replies"),
  team: z.string().optional().describe("Slack team ID"),
});

const SendMessageRequestSchema = z
  .object({
    agentId: z.string().describe("Agent ID to send message to"),
    message: z.string().describe("Message content"),
    platform: z
      .string()
      .optional()
      .default("api")
      .describe("Target platform (api, slack, telegram)"),
    slack: SlackRoutingInfoSchema.optional().describe(
      "Slack-specific routing info (required when platform=slack)"
    ),
    // Undocumented fields may be passed for internal/hidden platform support.
  })
  .passthrough();

const SendMessageResponseSchema = z.object({
  success: z.boolean(),
  agentId: z.string(),
  messageId: z.string(),
  eventsUrl: z.string().optional(),
  queued: z.boolean(),
});

const ErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  details: z.string().optional(),
  availablePlatforms: z.array(z.string()).optional(),
});

// ============================================================================
// Route Definitions
// ============================================================================

const sendMessageRoute = createRoute({
  method: "post",
  path: "/api/v1/messaging/send",
  tags: ["Messages"],
  summary: "Send a message via platform API",
  description:
    "Send a message to an agent. Supports JSON body or multipart form data for file uploads.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: SendMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Message sent successfully",
      content: {
        "application/json": {
          schema: SendMessageResponseSchema,
        },
      },
    },
    400: {
      description: "Bad request - missing required fields",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    401: {
      description: "Unauthorized - missing or invalid token",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    404: {
      description: "Platform not found",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    500: {
      description: "Internal server error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
    501: {
      description: "Platform does not support sendMessage",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
});

// ============================================================================
// Route Handlers
// ============================================================================

interface SendMessageRequest {
  agentId: string;
  message: string;
  platform?: string;
  slack?: {
    channel: string;
    thread?: string;
    team?: string;
  };
  // Intentionally undocumented (hidden feature).
  whatsapp?: {
    chat: string;
  };
}

/**
 * Create messaging routes (OpenAPI)
 */
export function createMessagingRoutes(
  platformRegistry: PlatformRegistry,
  auth?: { adminPassword?: string; cliTokenService?: CliTokenService }
): OpenAPIHono {
  const app = new OpenAPIHono();

  // Public messaging must not accept worker tokens, because this route can
  // post messages into user-facing platform connections.
  app.use(
    "/api/v1/messaging/*",
    createApiAuthMiddleware({
      ...(auth ?? {}),
      allowWorkerToken: false,
      allowSettingsSession: false,
    })
  );

  app.openapi(sendMessageRoute, async (c): Promise<any> => {
    try {
      // Platform token still comes from the Authorization header for the adapter call
      const authHeader = c.req.header("authorization");
      const token = authHeader ? authHeader.substring(7) : "";

      // Handle multipart form data for file uploads
      const contentType = c.req.header("content-type") || "";
      let body: SendMessageRequest;
      let files: Array<{ buffer: Buffer; filename: string }> | undefined;

      if (contentType.includes("multipart/form-data")) {
        const formData = await c.req.formData();
        body = {
          agentId: formData.get("agentId") as string,
          message: formData.get("message") as string,
          platform: (formData.get("platform") as string) || "api",
        };

        // Handle nested objects from form data
        const slackChannel = formData.get("slack.channel") as string;
        if (slackChannel) {
          body.slack = {
            channel: slackChannel,
            thread: formData.get("slack.thread") as string | undefined,
            team: formData.get("slack.team") as string | undefined,
          };
        }

        // Intentionally undocumented (hidden feature): WhatsApp routing info
        const whatsappChat = formData.get("whatsapp.chat") as string;
        if (whatsappChat) {
          body.whatsapp = { chat: whatsappChat };
        }

        // Extract files with size validation
        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
        const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total
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
          if (fileResults.length > 0) {
            files = fileResults;
          }
        }
      } else {
        body = c.req.valid("json");
      }

      const { agentId, message, platform = "api" } = body;

      if (!agentId) {
        return c.json({ success: false, error: "agentId is required" }, 400);
      }

      if (!message) {
        return c.json({ success: false, error: "message is required" }, 400);
      }

      // Get platform adapter first to use its routing info extractor
      const adapter = platformRegistry.get(platform);

      // Extract platform-specific routing info using adapter's method if available
      let channelId = agentId;
      let conversationId: string | undefined =
        platform === "api" ? agentId : undefined;
      let teamId = "api";

      if (adapter?.extractRoutingInfo) {
        const routingInfo = adapter.extractRoutingInfo(
          body as unknown as Record<string, unknown>
        );
        if (routingInfo) {
          channelId = routingInfo.channelId;
          conversationId =
            routingInfo.conversationId ||
            (platform === "api" ? agentId : undefined);
          teamId = routingInfo.teamId || "api";
        } else if (platform !== "api") {
          // Platform-specific fields required but not provided
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
        `Sending message via ${platform}: agentId=${agentId}, channelId=${channelId}${files && files.length > 0 ? `, files=${files.length}` : ""}`
      );
      if (!adapter) {
        const availablePlatforms = platformRegistry.getAvailablePlatforms();
        return c.json(
          {
            success: false,
            error: `Platform "${platform}" not found`,
            availablePlatforms,
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

      const options: {
        agentId: string;
        channelId: string;
        conversationId?: string;
        teamId: string;
        files?: Array<{ buffer: Buffer; filename: string }>;
      } = {
        agentId,
        channelId,
        conversationId,
        teamId,
      };

      if (files && files.length > 0) {
        options.files = files;
      }

      const result = await adapter.sendMessage(token, message, options);

      logger.info(
        `Message sent: agentId=${agentId}, messageId=${result.messageId}`
      );

      return c.json({
        success: true,
        agentId,
        messageId: result.messageId,
        eventsUrl: result.eventsUrl,
        queued: result.queued || false,
      });
    } catch (error) {
      logger.error("Failed to send message:", error);
      return c.json(
        {
          success: false,
          error: "Internal server error",
        },
        500
      );
    }
  });

  logger.debug("Messaging routes registered");
  return app;
}
