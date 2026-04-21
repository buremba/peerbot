/**
 * Agent Management Routes - Create, list, update, and delete user agents
 *
 * Routes:
 * - POST /api/v1/agents - Create a new agent
 * - GET /api/v1/agents - List user's agents (requires token)
 * - PATCH /api/v1/agents/{agentId} - Update agent name/description
 * - DELETE /api/v1/agents/{agentId} - Delete an agent
 */

import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import type { AgentMetadataStore } from "../../auth/agent-metadata-store";
import type { AgentSettings, AgentSettingsStore } from "../../auth/settings";
import { buildDefaultSettingsFromSource } from "../../auth/settings/template-utils";
import type { SettingsTokenPayload } from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import {
  resolveSettingsLookupUserId,
  verifyOwnedAgentAccess,
} from "../shared/agent-ownership";
import { errorResponse, requireSession } from "../shared/helpers";

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

async function listOwnedAgentIds(
  payload: SettingsTokenPayload,
  config: Pick<AgentRoutesConfig, "userAgentsStore" | "agentMetadataStore">
): Promise<string[]> {
  const lookupUserId = resolveSettingsLookupUserId(payload);
  const agentIds = new Set(
    await config.userAgentsStore.listAgents(payload.platform, lookupUserId)
  );

  if (payload.platform === "external") {
    const allAgents = await config.agentMetadataStore.listAllAgents();
    for (const agent of allAgents) {
      if (agent.owner.userId === lookupUserId) {
        agentIds.add(agent.agentId);
      }
    }
  }

  return [...agentIds];
}

/**
 * Sanitize user-provided agentId.
 * Lowercase alphanumeric with hyphens, 3-60 chars, must start with a letter.
 */
function sanitizeAgentId(input: string): string | null {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (cleaned.length < 3 || cleaned.length > 60) return null;
  if (!/^[a-z]/.test(cleaned)) return null;
  return cleaned;
}

export function createAgentRoutes(config: AgentRoutesConfig): Hono {
  const router = new Hono();

  // POST /api/v1/agents - Create a new agent
  router.post("/", async (c) => {
    const payload = requireSession(c);
    if (payload instanceof Response) return payload;

    try {
      const lookupUserId = resolveSettingsLookupUserId(payload);
      const body = await c.req.json<{
        agentId: string;
        name: string;
        description?: string;
        channelId?: string;
      }>();

      if (!body.agentId || !body.name) {
        return errorResponse(c, "agentId and name are required", 400);
      }

      const agentId = sanitizeAgentId(body.agentId);
      if (!agentId) {
        return errorResponse(
          c,
          "Invalid agentId. Must be 3-40 chars, lowercase alphanumeric with hyphens, starting with a letter.",
          400
        );
      }

      // Check if agentId already exists
      const existing = await config.agentMetadataStore.hasAgent(agentId);
      if (existing) {
        return errorResponse(c, "An agent with this ID already exists", 409);
      }

      // Check per-user limit (admins bypass)
      if (!payload.isAdmin && MAX_AGENTS_PER_USER > 0) {
        const userAgents = await listOwnedAgentIds(payload, config);
        if (userAgents.length >= MAX_AGENTS_PER_USER) {
          return errorResponse(
            c,
            `Agent limit reached (${MAX_AGENTS_PER_USER}). Delete an existing agent first.`,
            429
          );
        }
      }

      // Create metadata
      await config.agentMetadataStore.createAgent(
        agentId,
        body.name,
        payload.platform,
        lookupUserId,
        { description: body.description }
      );

      // Create default settings, seeded from the current workspace/channel agent when available.
      let defaultSettings: Omit<AgentSettings, "updatedAt"> = {};
      try {
        let sourceAgentId = payload.agentId;
        if (!sourceAgentId && body.channelId) {
          const binding = await config.channelBindingService.getBinding(
            payload.platform,
            body.channelId,
            payload.teamId
          );
          sourceAgentId = binding?.agentId;
        }

        if (sourceAgentId) {
          const sourceSettings =
            await config.agentSettingsStore.getSettings(sourceAgentId);
          defaultSettings = buildDefaultSettingsFromSource(sourceSettings);
        }
      } catch (error) {
        logger.warn("Failed to derive source defaults for new agent", {
          error,
        });
      }
      await config.agentSettingsStore.saveSettings(agentId, defaultSettings);

      // Associate with user
      await config.userAgentsStore.addAgent(
        payload.platform,
        lookupUserId,
        agentId
      );

      // Auto-bind to channel if channelId provided (from session context)
      if (body.channelId) {
        await config.channelBindingService.createBinding(
          agentId,
          payload.platform,
          body.channelId,
          payload.teamId,
          { configuredBy: payload.userId }
        );
      }

      logger.info(
        `Created agent ${agentId} for user ${payload.platform}/${payload.userId}${body.channelId ? ` (bound to ${body.channelId})` : ""}`
      );

      return c.json({
        agentId,
        name: body.name,
        settingsUrl: `/api/v1/agents/${encodeURIComponent(agentId)}/config`,
      });
    } catch (error) {
      logger.error("Failed to create agent", { error });
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // GET /api/v1/agents - List user's agents
  router.get("/", async (c) => {
    const payload = requireSession(c);
    if (payload instanceof Response) return payload;

    try {
      const agentIds = await listOwnedAgentIds(payload, config);

      const agents = [];
      for (const agentId of agentIds) {
        const metadata = await config.agentMetadataStore.getMetadata(agentId);
        if (metadata) {
          // Skip sandbox agents (auto-created under a connection)
          if (metadata.parentConnectionId) continue;

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
      return errorResponse(c, "Failed to list agents", 500);
    }
  });

  // PATCH /api/v1/agents/{agentId} - Update agent name/description
  router.patch("/:agentId", async (c) => {
    const payload = requireSession(c);
    if (payload instanceof Response) return payload;

    const agentId = c.req.param("agentId");
    if (!agentId) {
      return errorResponse(c, "Missing agentId", 400);
    }

    try {
      // Verify ownership (admins bypass)
      if (!payload.isAdmin) {
        const access = await verifyOwnedAgentAccess(payload, agentId, {
          userAgentsStore: config.userAgentsStore,
          agentMetadataStore: config.agentMetadataStore,
        });
        if (!access.authorized) {
          return errorResponse(c, "Agent not found or not owned by you", 404);
        }
      }

      const body = await c.req.json<{ name?: string; description?: string }>();
      const updates: { name?: string; description?: string } = {};

      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name || name.length > 100) {
          return errorResponse(c, "Name must be 1-100 characters", 400);
        }
        updates.name = name;
      }

      if (body.description !== undefined) {
        const desc = body.description.trim();
        if (desc.length > 200) {
          return errorResponse(
            c,
            "Description must be at most 200 characters",
            400
          );
        }
        updates.description = desc;
      }

      if (Object.keys(updates).length === 0) {
        return errorResponse(c, "No fields to update", 400);
      }

      await config.agentMetadataStore.updateMetadata(agentId, updates);
      logger.info(`Updated agent identity for ${agentId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to update agent", { error, agentId });
      return errorResponse(c, "Internal server error", 500);
    }
  });

  // DELETE /api/v1/agents/{agentId} - Delete an agent
  router.delete("/:agentId", async (c) => {
    const payload = requireSession(c);
    if (payload instanceof Response) return payload;

    const agentId = c.req.param("agentId");
    if (!agentId) {
      return errorResponse(c, "Missing agentId", 400);
    }

    try {
      // Verify ownership (admins bypass)
      let ownerPlatform: string | undefined;
      let ownerUserId: string | undefined;
      if (!payload.isAdmin) {
        const access = await verifyOwnedAgentAccess(payload, agentId, {
          userAgentsStore: config.userAgentsStore,
          agentMetadataStore: config.agentMetadataStore,
        });
        if (!access.authorized) {
          return errorResponse(c, "Agent not found or not owned by you", 404);
        }
        ownerPlatform = access.ownerPlatform;
        ownerUserId = access.ownerUserId;
      }

      // Auto-unbind all channels
      const unboundCount =
        await config.channelBindingService.deleteAllBindings(agentId);

      // Delete settings
      await config.agentSettingsStore.deleteSettings(agentId);

      // Delete metadata
      await config.agentMetadataStore.deleteAgent(agentId);

      // Remove from user's list
      await config.userAgentsStore.removeAgent(
        payload.platform,
        resolveSettingsLookupUserId(payload),
        agentId
      );
      if (
        ownerPlatform &&
        ownerUserId &&
        (ownerPlatform !== payload.platform || ownerUserId !== payload.userId)
      ) {
        await config.userAgentsStore.removeAgent(
          ownerPlatform,
          ownerUserId,
          agentId
        );
      }

      logger.info(
        `Deleted agent ${agentId} (unbound ${unboundCount} channels)`
      );

      return c.json({ success: true, unboundChannels: unboundCount });
    } catch (error) {
      logger.error("Failed to delete agent", { error, agentId });
      return errorResponse(c, "Internal server error", 500);
    }
  });

  logger.debug("Agent management routes registered");
  return router;
}
