/**
 * Channel Binding Routes - Manage channel-to-agent bindings
 *
 * Routes (under /api/v1/agents/{agentId}/channels):
 * - GET / - List all bindings for an agent
 * - POST / - Create a new binding
 * - DELETE /{platform}/{channelId} - Delete a binding
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import {
  type SettingsTokenPayload,
  verifySettingsToken,
} from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";

const logger = createLogger("channel-binding-routes");

export interface ChannelBindingRoutesConfig {
  channelBindingService: ChannelBindingService;
  userAgentsStore?: UserAgentsStore;
  agentMetadataStore?: AgentMetadataStore;
}

/**
 * Create channel binding routes
 * These are mounted under /api/v1/agents/{agentId}/channels
 */
export function createChannelBindingRoutes(
  config: ChannelBindingRoutesConfig
): Hono {
  const router = new Hono();

  const verifyToken = async (
    token: string | undefined,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    if (!token) return null;
    const payload = verifySettingsToken(token);
    if (!payload) return null;

    if (payload.agentId) {
      if (payload.agentId !== agentId) return null;
    } else if (config.userAgentsStore) {
      const owns = await config.userAgentsStore.ownsAgent(
        payload.platform,
        payload.userId,
        agentId
      );
      if (!owns) {
        if (config.agentMetadataStore) {
          const metadata = await config.agentMetadataStore.getMetadata(agentId);
          if (!metadata?.isWorkspaceAgent) return null;
        } else {
          return null;
        }
      }
    } else {
      return null;
    }

    return payload;
  };

  // GET /api/v1/agents/{agentId}/channels - List all bindings for an agent
  router.get("/", async (c) => {
    const agentId = c.req.param("agentId");

    if (!agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    if (!(await verifyToken(c.req.query("token"), agentId))) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      const bindings = await config.channelBindingService.listBindings(agentId);

      return c.json({
        agentId,
        bindings: bindings.map((b) => ({
          platform: b.platform,
          channelId: b.channelId,
          teamId: b.teamId,
          createdAt: b.createdAt,
        })),
      });
    } catch (error) {
      logger.error("Failed to list bindings", { error, agentId });
      return c.json({ error: "Failed to list bindings" }, 500);
    }
  });

  // POST /api/v1/agents/{agentId}/channels - Create a new binding
  router.post("/", async (c) => {
    const agentId = c.req.param("agentId");

    if (!agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    const authPayload = await verifyToken(c.req.query("token"), agentId);
    if (!authPayload) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      const body = await c.req.json<{
        platform: string;
        channelId: string;
        teamId?: string;
      }>();

      // Validate required fields
      if (!body.platform || !body.channelId) {
        return c.json(
          { error: "Missing required fields: platform, channelId" },
          400
        );
      }

      // Validate platform format (alphanumeric, lowercase)
      if (!/^[a-z][a-z0-9_-]*$/.test(body.platform)) {
        return c.json(
          { error: "Invalid platform format. Must be lowercase alphanumeric." },
          400
        );
      }

      // Validate channelId format
      if (typeof body.channelId !== "string" || !body.channelId.trim()) {
        return c.json({ error: "Invalid channelId" }, 400);
      }

      // Validate optional teamId
      if (
        body.teamId &&
        (typeof body.teamId !== "string" || !body.teamId.trim())
      ) {
        return c.json({ error: "Invalid teamId" }, 400);
      }

      await config.channelBindingService.createBinding(
        agentId,
        body.platform,
        body.channelId.trim(),
        body.teamId?.trim(),
        { configuredBy: authPayload.userId }
      );

      logger.info(
        `Created binding: ${body.platform}/${body.channelId} -> ${agentId}`
      );

      return c.json({
        success: true,
        agentId,
        platform: body.platform,
        channelId: body.channelId,
        teamId: body.teamId,
      });
    } catch (error) {
      logger.error("Failed to create binding", { error, agentId });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to create binding",
        },
        400
      );
    }
  });

  // DELETE /api/v1/agents/{agentId}/channels/{platform}/{channelId} - Delete a binding
  router.delete("/:platform/:channelId", async (c) => {
    const agentId = c.req.param("agentId");
    const platform = c.req.param("platform");
    const channelId = c.req.param("channelId");
    const teamId = c.req.query("teamId"); // Optional query param for multi-tenant platforms

    if (!agentId || !platform || !channelId) {
      return c.json({ error: "Missing required parameters" }, 400);
    }

    if (!(await verifyToken(c.req.query("token"), agentId))) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Validate platform format
    if (!/^[a-z][a-z0-9_-]*$/.test(platform)) {
      return c.json({ error: "Invalid platform format" }, 400);
    }

    try {
      const deleted = await config.channelBindingService.deleteBinding(
        agentId,
        platform,
        channelId,
        teamId || undefined
      );

      if (!deleted) {
        return c.json(
          { error: "Binding not found or belongs to a different agent" },
          404
        );
      }

      logger.info(`Deleted binding: ${platform}/${channelId} from ${agentId}`);

      return c.json({
        success: true,
        agentId,
        platform,
        channelId,
      });
    } catch (error) {
      logger.error("Failed to delete binding", {
        error,
        agentId,
        platform,
        channelId,
      });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to delete binding",
        },
        400
      );
    }
  });

  logger.info("Channel binding routes registered");
  return router;
}
