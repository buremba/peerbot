/**
 * Settings Page Routes
 *
 * Serves the unified settings/agent-selector page via magic link.
 * Supports two entry modes:
 * - Agent-based token: shows settings directly
 * - Channel-based token: resolves agent via binding or shows agent picker
 *
 * API endpoints (agent config, schedules, etc.) remain in separate files.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger, moduleRegistry } from "@lobu/core";
import type {
  AgentMetadata,
  AgentMetadataStore,
} from "../../auth/agent-metadata-store";
import { collectProviderModelOptions } from "../../auth/provider-model-options";
import type { AgentSettingsStore } from "../../auth/settings";
import { verifySettingsToken } from "../../auth/settings/token-service";
import type { UserAgentsStore } from "../../auth/user-agents-store";
import type { ChannelBindingService } from "../../channels";
import type { ProviderMeta } from "./settings-page";
import {
  renderErrorPage,
  renderPickerPage,
  renderSettingsPage,
} from "./settings-page";

const logger = createLogger("settings-routes");

export interface SettingsPageConfig {
  agentSettingsStore: AgentSettingsStore;
  userAgentsStore: UserAgentsStore;
  agentMetadataStore: AgentMetadataStore;
  channelBindingService: ChannelBindingService;
}

function buildProviderMeta(
  m: ReturnType<typeof moduleRegistry.getModelProviderModules>[number]
): ProviderMeta {
  return {
    id: m.providerId,
    name: m.providerDisplayName,
    iconUrl: m.providerIconUrl || "",
    authType: (m.authType || "oauth") as ProviderMeta["authType"],
    supportedAuthTypes:
      (m.supportedAuthTypes as ProviderMeta["supportedAuthTypes"]) || [
        m.authType || "oauth",
      ],
    apiKeyInstructions: m.apiKeyInstructions || "",
    apiKeyPlaceholder: m.apiKeyPlaceholder || "",
    catalogDescription: m.catalogDescription || "",
  };
}

export function createSettingsPageRoutes(
  config: SettingsPageConfig
): OpenAPIHono {
  const app = new OpenAPIHono();

  // HTML Settings Page
  app.get("/settings", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.html(
        renderErrorPage("Missing token. Please use the link sent to you."),
        400
      );
    }

    const payload = verifySettingsToken(token);
    if (!payload) {
      return c.html(
        renderErrorPage(
          "Invalid or expired link. Use /configure to request a new settings link."
        ),
        401
      );
    }

    // Determine the agentId to show settings for
    let agentId = payload.agentId;

    if (!agentId && payload.channelId) {
      // Channel-based token: try to resolve via existing binding
      const binding = await config.channelBindingService.getBinding(
        payload.platform,
        payload.channelId,
        payload.teamId
      );
      if (binding) {
        agentId = binding.agentId;
      }
    }

    if (!agentId) {
      // No agent resolved: show agent picker / creation form
      const agentIds = await config.userAgentsStore.listAgents(
        payload.platform,
        payload.userId
      );

      const agents: (AgentMetadata & { channelCount: number })[] = [];
      for (const id of agentIds) {
        const metadata = await config.agentMetadataStore.getMetadata(id);
        if (metadata) {
          const bindings = await config.channelBindingService.listBindings(id);
          agents.push({ ...metadata, channelCount: bindings.length });
        }
      }

      return c.html(renderPickerPage(payload, agents, token));
    }

    // We have an agentId: render settings page
    const [settings, agentMetadata] = await Promise.all([
      config.agentSettingsStore.getSettings(agentId),
      config.agentMetadataStore.getMetadata(agentId),
    ]);

    // Build provider metadata from registry
    const allModules = moduleRegistry.getModelProviderModules();
    const allProviderMeta = allModules
      .filter((m) => m.catalogVisible !== false)
      .map(buildProviderMeta);

    // Resolve installed providers in order
    const installedIds = (settings?.installedProviders || []).map(
      (ip) => ip.providerId
    );
    const installedSet = new Set(installedIds);
    const installedProviders = installedIds
      .map((id) => allProviderMeta.find((p) => p.id === id))
      .filter((p): p is ProviderMeta => p !== undefined);

    // Catalog providers = all that are not installed
    const catalogProviders = allProviderMeta.filter(
      (p) => !installedSet.has(p.id)
    );

    const providerModelOptions = await collectProviderModelOptions(
      agentId,
      payload.userId
    );

    // Determine if agent switcher should be shown
    const showSwitcher = !!payload.channelId;

    // Get agents list for switcher (only if switcher is enabled)
    const agents: (AgentMetadata & { channelCount: number })[] = [];
    if (showSwitcher) {
      const agentIds = await config.userAgentsStore.listAgents(
        payload.platform,
        payload.userId
      );
      for (const id of agentIds) {
        const metadata = await config.agentMetadataStore.getMetadata(id);
        if (metadata) {
          const bindings = await config.channelBindingService.listBindings(id);
          agents.push({ ...metadata, channelCount: bindings.length });
        }
      }

      // Ensure the currently active agent appears in switcher even when it is
      // not part of the user's direct agent list (e.g. workspace-bound agent).
      if (
        agentMetadata &&
        !agents.some((agent) => agent.agentId === agentMetadata.agentId)
      ) {
        const bindings = await config.channelBindingService.listBindings(
          agentMetadata.agentId
        );
        agents.unshift({ ...agentMetadata, channelCount: bindings.length });
      }
    }

    // Ensure the payload has agentId for the template (may have been resolved from binding)
    const effectivePayload = { ...payload, agentId };

    return c.html(
      renderSettingsPage(effectivePayload, settings, token, {
        providers: installedProviders,
        catalogProviders,
        providerModelOptions,
        showSwitcher,
        agents,
        agentName: agentMetadata?.name,
        agentDescription: agentMetadata?.description,
        hasChannelId: !!payload.channelId,
      })
    );
  });

  // PATCH /settings/update-agent - Update agent name/description
  app.patch("/settings/update-agent", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token" }, 401);

    const payload = verifySettingsToken(token);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    let agentId = payload.agentId;
    if (!agentId && payload.channelId) {
      const binding = await config.channelBindingService.getBinding(
        payload.platform,
        payload.channelId,
        payload.teamId
      );
      if (binding) agentId = binding.agentId;
    }
    if (!agentId) return c.json({ error: "No agent resolved" }, 400);

    try {
      const body = await c.req.json<{ name?: string; description?: string }>();
      const updates: { name?: string; description?: string } = {};

      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name || name.length > 100) {
          return c.json({ error: "Name must be 1-100 characters" }, 400);
        }
        updates.name = name;
      }

      if (body.description !== undefined) {
        const desc = body.description.trim();
        if (desc.length > 200) {
          return c.json(
            { error: "Description must be at most 200 characters" },
            400
          );
        }
        updates.description = desc;
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: "No fields to update" }, 400);
      }

      await config.agentMetadataStore.updateMetadata(agentId, updates);
      logger.info(`Updated agent identity for ${agentId}`);
      return c.json({ success: true });
    } catch (error) {
      logger.error("Failed to update agent identity", { error });
      return c.json({ error: "Failed to update agent identity" }, 500);
    }
  });

  // POST /settings/switch-agent - Switch channel binding to a different agent
  app.post("/settings/switch-agent", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token" }, 401);

    const payload = verifySettingsToken(token);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    if (!payload.channelId) {
      return c.json({ error: "Token has no channel context" }, 400);
    }

    try {
      const body = await c.req.json<{ agentId: string }>();
      if (!body.agentId) return c.json({ error: "Missing agentId" }, 400);

      // Verify user owns the agent
      const owns = await config.userAgentsStore.ownsAgent(
        payload.platform,
        payload.userId,
        body.agentId
      );
      if (!owns) {
        const metadata = await config.agentMetadataStore.getMetadata(
          body.agentId
        );
        if (!metadata?.isWorkspaceAgent) {
          return c.json({ error: "Agent not found or not owned by you" }, 404);
        }
      }

      // Check channel-per-agent limit
      const maxChannels = parseInt(
        process.env.MAX_CHANNELS_PER_AGENT || "0",
        10
      );
      if (maxChannels > 0) {
        const bindings = await config.channelBindingService.listBindings(
          body.agentId
        );
        // Don't count the current binding if it's already bound to this agent
        const existingBinding = await config.channelBindingService.getBinding(
          payload.platform,
          payload.channelId,
          payload.teamId
        );
        const effectiveCount =
          existingBinding?.agentId === body.agentId
            ? bindings.length - 1
            : bindings.length;
        if (
          effectiveCount >= maxChannels &&
          existingBinding?.agentId !== body.agentId
        ) {
          return c.json(
            { error: `Channel limit reached (${maxChannels}) for this agent.` },
            429
          );
        }
      }

      // Create/update binding
      await config.channelBindingService.createBinding(
        body.agentId,
        payload.platform,
        payload.channelId,
        payload.teamId,
        { configuredBy: payload.userId }
      );

      // Update lastUsedAt
      await config.agentMetadataStore.updateMetadata(body.agentId, {
        lastUsedAt: Date.now(),
      });

      logger.info(
        `Switched ${payload.platform}/${payload.channelId} to agent ${body.agentId}`
      );

      return c.json({ success: true, agentId: body.agentId });
    } catch (error) {
      logger.error("Failed to switch agent", { error });
      return c.json({ error: "Failed to switch agent" }, 500);
    }
  });

  // POST /settings/create-agent - Create new agent and optionally bind to channel
  app.post("/settings/create-agent", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "Missing token" }, 401);

    const payload = verifySettingsToken(token);
    if (!payload) return c.json({ error: "Invalid or expired token" }, 401);

    try {
      const body = await c.req.json<{
        agentId: string;
        name: string;
        description?: string;
      }>();

      if (!body.agentId || !body.name) {
        return c.json({ error: "agentId and name are required" }, 400);
      }

      // Sanitize agentId
      const agentId = body.agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (
        agentId.length < 3 ||
        agentId.length > 40 ||
        !/^[a-z]/.test(agentId)
      ) {
        return c.json({ error: "Invalid agent ID format" }, 400);
      }

      // Check if exists
      const exists = await config.agentMetadataStore.hasAgent(agentId);
      if (exists) {
        return c.json({ error: "Agent ID already taken" }, 409);
      }

      // Check per-user limit
      const maxAgents = parseInt(process.env.MAX_AGENTS_PER_USER || "0", 10);
      if (maxAgents > 0) {
        const userAgents = await config.userAgentsStore.listAgents(
          payload.platform,
          payload.userId
        );
        if (userAgents.length >= maxAgents) {
          return c.json({ error: `Agent limit reached (${maxAgents})` }, 429);
        }
      }

      // Create agent
      await config.agentMetadataStore.createAgent(
        agentId,
        body.name,
        payload.platform,
        payload.userId,
        { description: body.description }
      );
      await config.agentSettingsStore.saveSettings(agentId, {});
      await config.userAgentsStore.addAgent(
        payload.platform,
        payload.userId,
        agentId
      );

      // Bind to channel if available
      if (payload.channelId) {
        await config.channelBindingService.createBinding(
          agentId,
          payload.platform,
          payload.channelId,
          payload.teamId,
          { configuredBy: payload.userId }
        );
      }

      logger.info(
        `Created agent ${agentId}${payload.channelId ? ` and bound to ${payload.platform}/${payload.channelId}` : ""}`
      );

      return c.json({ success: true, agentId });
    } catch (error) {
      logger.error("Failed to create agent", { error });
      return c.json({ error: "Failed to create agent" }, 500);
    }
  });

  return app;
}
