/**
 * Channel Binding Routes - Manage channel-to-agent bindings
 *
 * Routes (under /api/v1/agents/{agentId}/channels):
 * - GET / - List all bindings for an agent
 * - POST / - Create a new binding
 * - DELETE /{platform}/{channelId} - Delete a binding
 */

import { createLogger } from "@lobu/core";
import { type Context, Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store.js";
import type { SettingsTokenPayload } from "../../auth/settings/token-service.js";
import type { UserAgentsStore } from "../../auth/user-agents-store.js";
import type { ChannelBindingService } from "../../channels/binding-service.js";
import { createTokenVerifier } from "../shared/agent-ownership.js";
import { errorResponse } from "../shared/helpers.js";
import { verifySettingsSession } from "./settings-auth.js";

const logger = createLogger("channel-binding-routes");

interface ChannelBindingRoutesConfig {
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

  const verifyAuth = async (
    c: Context,
    agentId: string
  ): Promise<SettingsTokenPayload | null> => {
    return verifyToken(await verifySettingsSession(c), agentId);
  };

  // Resolve the `agentId` path param and authorize the caller in one step.
  // Returns the verified token payload, or an early-return Response (400 when
  // the param is missing, 401 when the session is not authorized for it).
  const authorize = async (
    c: Context
  ): Promise<{ agentId: string; payload: SettingsTokenPayload } | Response> => {
    const agentId = c.req.param("agentId");
    if (!agentId) {
      return errorResponse(c, "Missing agentId", 400);
    }
    const payload = await verifyAuth(c, agentId);
    if (!payload) {
      return errorResponse(c, "Unauthorized", 401);
    }
    return { agentId, payload };
  };

  // GET /api/v1/agents/{agentId}/channels - List all bindings for an agent
  router.get("/", async (c) => {
    const auth = await authorize(c);
    if (auth instanceof Response) return auth;
    const { agentId } = auth;

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
      return errorResponse(c, "Failed to list bindings", 500);
    }
  });

  // POST /api/v1/agents/{agentId}/channels - Create a new binding
  router.post("/", async (c) => {
    const auth = await authorize(c);
    if (auth instanceof Response) return auth;
    const { agentId, payload: authPayload } = auth;

    try {
      const body = await c.req.json<{
        platform: string;
        channelId: string;
        teamId?: string;
      }>();

      // Validate required fields
      if (!body.platform || !body.channelId) {
        return errorResponse(
          c,
          "Missing required fields: platform, channelId",
          400
        );
      }

      // Validate platform format (alphanumeric, lowercase)
      if (!/^[a-z][a-z0-9_-]*$/.test(body.platform)) {
        return errorResponse(
          c,
          "Invalid platform format. Must be lowercase alphanumeric.",
          400
        );
      }

      // Validate channelId format
      if (typeof body.channelId !== "string" || !body.channelId.trim()) {
        return errorResponse(c, "Invalid channelId", 400);
      }

      // Validate optional teamId
      if (
        body.teamId &&
        (typeof body.teamId !== "string" || !body.teamId.trim())
      ) {
        return errorResponse(c, "Invalid teamId", 400);
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
      return errorResponse(c, "Failed to create binding", 400);
    }
  });

  // DELETE /api/v1/agents/{agentId}/channels/{platform}/{channelId} - Delete a binding
  router.delete("/:platform/:channelId", async (c) => {
    const platform = c.req.param("platform");
    const channelId = c.req.param("channelId");
    const teamId = c.req.query("teamId"); // Optional query param for multi-tenant platforms

    // Authorize on the agentId before validating the route-specific params so
    // the 401 takes precedence over a 400, matching the prior behavior.
    const agentId = c.req.param("agentId");
    if (!agentId || !platform || !channelId) {
      return errorResponse(c, "Missing required parameters", 400);
    }

    if (!(await verifyAuth(c, agentId))) {
      return errorResponse(c, "Unauthorized", 401);
    }

    // Validate platform format
    if (!/^[a-z][a-z0-9_-]*$/.test(platform)) {
      return errorResponse(c, "Invalid platform format", 400);
    }

    try {
      const deleted = await config.channelBindingService.deleteBinding(
        agentId,
        platform,
        channelId,
        teamId || undefined
      );

      if (!deleted) {
        return errorResponse(c, "Binding not found", 404);
      }

      logger.info(`Deleted binding: ${platform}/${channelId} -> ${agentId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to delete binding", { error, agentId });
      return errorResponse(c, "Failed to delete binding", 500);
    }
  });

  return router;
}
