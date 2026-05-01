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
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChannelBindingService } from "../../channels/index.js";
import { createTokenVerifier } from "../shared/token-verifier.js";
import { verifySettingsSession } from "./settings-auth.js";

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

  const verifyToken = createTokenVerifier(config);

  const verifyAuth = async (c: any, agentId: string) => {
    return verifyToken(verifySettingsSession(c), agentId);
  };

  // GET /api/v1/agents/{agentId}/channels - List all bindings for an agent
  router.get("/", async (c) => {
    const agentId = c.req.param("agentId");

    if (!agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    if (!(await verifyAuth(c, agentId))) {
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

    const authPayload = await verifyAuth(c, agentId);
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
          error: "Failed to create binding",
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

    if (!(await verifyAuth(c, agentId))) {
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
        return c.json({ error: "Binding not found" }, 404);
      }

      logger.info(`Deleted binding: ${platform}/${channelId} -> ${agentId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete binding", { error, agentId });
      return c.json({ error: "Failed to delete binding" }, 500);
    }
  });

  return router;
}
