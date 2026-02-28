/**
 * Agent Management Routes - Create, list, and delete user agents
 *
 * Routes:
 * - POST /api/v1/agent-management/agents - Create a new agent
 * - GET /api/v1/agent-management/agents - List user's agents (requires token)
 * - DELETE /api/v1/agent-management/agents/{agentId} - Delete an agent
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import type { AgentSettingsStore } from "../../auth/settings";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import { verifySettingsSession } from "./settings-auth";

const logger = createLogger("agent-routes");

/** Environment-configurable limits */
const MAX_AGENTS_PER_USER = parseInt(
  process.env.MAX_AGENTS_PER_USER || "0",
  10
);

export interface AgentRoutesConfig {
  userAgentsStore: UserAgentsStore;
  agentMetadataStore: AgentMetadataStore;
  agentSettingsStore: AgentSettingsStore;
  channelBindingService: ChannelBindingService;
}

/**
 * Sanitize user-provided agentId.
 * Must be lowercase alphanumeric with hyphens, 3-40 chars.
 */
function sanitizeAgentId(input: string): string | null {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (cleaned.length < 3 || cleaned.length > 40) return null;
  if (!/^[a-z]/.test(cleaned)) return null;
  return cleaned;
}

export function createAgentRoutes(config: AgentRoutesConfig): Hono {
  const router = new Hono();

  // POST /api/v1/agents - Create a new agent
  router.post("/", async (c) => {
    const payload = verifySettingsSession(c);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const body = await c.req.json<{
        agentId: string;
        name: string;
        description?: string;
      }>();

      if (!body.agentId || !body.name) {
        return c.json({ error: "agentId and name are required" }, 400);
      }

      const agentId = sanitizeAgentId(body.agentId);
      if (!agentId) {
        return c.json(
          {
            error:
              "Invalid agentId. Must be 3-40 chars, lowercase alphanumeric with hyphens, starting with a letter.",
          },
          400
        );
      }

      // Check if agentId already exists
      const existing = await config.agentMetadataStore.hasAgent(agentId);
      if (existing) {
        return c.json({ error: "An agent with this ID already exists" }, 409);
      }

      // Check per-user limit
      if (MAX_AGENTS_PER_USER > 0) {
        const userAgents = await config.userAgentsStore.listAgents(
          payload.platform,
          payload.userId
        );
        if (userAgents.length >= MAX_AGENTS_PER_USER) {
          return c.json(
            {
              error: `Agent limit reached (${MAX_AGENTS_PER_USER}). Delete an existing agent first.`,
            },
            429
          );
        }
      }

      // Create metadata
      await config.agentMetadataStore.createAgent(
        agentId,
        body.name,
        payload.platform,
        payload.userId,
        { description: body.description }
      );

      // Create default settings
      await config.agentSettingsStore.saveSettings(agentId, {});

      // Associate with user
      await config.userAgentsStore.addAgent(
        payload.platform,
        payload.userId,
        agentId
      );

      logger.info(
        `Created agent ${agentId} for user ${payload.platform}/${payload.userId}`
      );

      return c.json({
        agentId,
        name: body.name,
        settingsUrl: `/settings?agentId=${encodeURIComponent(agentId)}`,
      });
    } catch (error) {
      logger.error("Failed to create agent", { error });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to create agent",
        },
        500
      );
    }
  });

  // GET /api/v1/agents - List user's agents
  router.get("/", async (c) => {
    const payload = verifySettingsSession(c);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    try {
      const agentIds = await config.userAgentsStore.listAgents(
        payload.platform,
        payload.userId
      );

      const agents = [];
      for (const agentId of agentIds) {
        const metadata = await config.agentMetadataStore.getMetadata(agentId);
        if (metadata) {
          const bindings =
            await config.channelBindingService.listBindings(agentId);
          agents.push({
            agentId,
            name: metadata.name,
            description: metadata.description,
            isWorkspaceAgent: metadata.isWorkspaceAgent,
            createdAt: metadata.createdAt,
            lastUsedAt: metadata.lastUsedAt,
            channelCount: bindings.length,
          });
        }
      }

      return c.json({ agents });
    } catch (error) {
      logger.error("Failed to list agents", { error });
      return c.json({ error: "Failed to list agents" }, 500);
    }
  });

  // DELETE /api/v1/agents/{agentId} - Delete an agent
  router.delete("/:agentId", async (c) => {
    const payload = verifySettingsSession(c);
    if (!payload) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    const agentId = c.req.param("agentId");
    if (!agentId) {
      return c.json({ error: "Missing agentId" }, 400);
    }

    try {
      // Verify ownership
      const owns = await config.userAgentsStore.ownsAgent(
        payload.platform,
        payload.userId,
        agentId
      );
      if (!owns) {
        return c.json({ error: "Agent not found or not owned by you" }, 404);
      }

      // Auto-unbind all channels (Option A from plan)
      const unboundCount =
        await config.channelBindingService.deleteAllBindings(agentId);

      // Delete settings
      await config.agentSettingsStore.deleteSettings(agentId);

      // Delete metadata
      await config.agentMetadataStore.deleteAgent(agentId);

      // Remove from user's list
      await config.userAgentsStore.removeAgent(
        payload.platform,
        payload.userId,
        agentId
      );

      logger.info(
        `Deleted agent ${agentId} (unbound ${unboundCount} channels)`
      );

      return c.json({ success: true, unboundChannels: unboundCount });
    } catch (error) {
      logger.error("Failed to delete agent", { error, agentId });
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Failed to delete agent",
        },
        500
      );
    }
  });

  logger.info("Agent management routes registered");
  return router;
}
