/**
 * Shared platform helpers.
 * Extracts common logic duplicated across Slack, Telegram, and WhatsApp message handlers.
 */

import {
  createLogger,
  type MessagePayload,
  type PluginConfig,
  type PluginsConfig,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings/agent-settings-store.js";
import { resolveEffectiveModelRef } from "../auth/settings/model-selection.js";
import type { ChannelBindingService } from "../channels/binding-service.js";
import { buildMemoryPlugins, getInternalGatewayUrl } from "../config/index.js";

const logger = createLogger("platform-helpers");
const LOBU_PLUGIN_SOURCE = "@lobu/openclaw-plugin";

function readLobuRuntimeDefaults(): PluginConfig | null {
  const configuredPlugin = buildMemoryPlugins().find(
    (plugin) =>
      plugin.source === LOBU_PLUGIN_SOURCE && plugin.slot === "memory"
  );
  if (configuredPlugin) {
    return configuredPlugin;
  }

  const gatewayUrl = getInternalGatewayUrl();
  return {
    source: LOBU_PLUGIN_SOURCE,
    slot: "memory",
    enabled: true,
    config: {
      mcpUrl: `${gatewayUrl}/mcp/lobu-memory`,
      gatewayAuthUrl: gatewayUrl,
    },
  };
}

function normalizeLobuPluginConfig(
  plugin: PluginConfig,
  runtimeDefault: PluginConfig | null
): PluginConfig {
  if (
    plugin.source !== LOBU_PLUGIN_SOURCE ||
    plugin.slot !== "memory" ||
    !runtimeDefault?.config
  ) {
    return plugin;
  }

  return {
    ...plugin,
    config: {
      ...plugin.config,
      mcpUrl: runtimeDefault.config.mcpUrl,
      gatewayAuthUrl: runtimeDefault.config.gatewayAuthUrl,
    },
  };
}

function normalizePluginsConfig(
  pluginsConfig: PluginsConfig | undefined
): PluginsConfig | undefined {
  if (!pluginsConfig?.plugins?.length) {
    return pluginsConfig;
  }

  const runtimeDefault = readLobuRuntimeDefaults();
  let changed = false;
  const plugins = pluginsConfig.plugins.map((plugin) => {
    const normalized = normalizeLobuPluginConfig(plugin, runtimeDefault);
    if (normalized !== plugin) {
      changed = true;
    }
    return normalized;
  });

  return changed ? { ...pluginsConfig, plugins } : pluginsConfig;
}

/**
 * Resolve agent options by merging base options with per-agent settings.
 * Priority: agent settings > config defaults.
 */
export async function resolveAgentOptions(
  agentId: string,
  baseOptions: Record<string, any>,
  agentSettingsStore?: AgentSettingsStore
): Promise<Record<string, any>> {
  if (!agentSettingsStore) {
    return { ...baseOptions };
  }

  const settings = await agentSettingsStore.getSettings(agentId);
  if (!settings) {
    return { ...baseOptions };
  }

  const effectiveProviders = settings.installedProviders || [];

  const mergedOptions: Record<string, any> = { ...baseOptions };
  const effectiveModelRef = resolveEffectiveModelRef(settings);
  logger.info(
    {
      agentId,
      configuredModel: settings.model,
      effectiveModel: effectiveModelRef,
    },
    "Applying agent settings"
  );

  if (effectiveModelRef) {
    mergedOptions.model = effectiveModelRef;
  } else if (effectiveProviders.length > 0) {
    // Auto mode with installed providers: let worker resolve default model.
    delete mergedOptions.model;
  }

  if (settings.networkConfig) {
    mergedOptions.networkConfig = settings.networkConfig;
  }
  if (settings.guardrailsInline?.length) {
    mergedOptions.guardrailsInline = settings.guardrailsInline;
  }
  if (settings.nixConfig) {
    mergedOptions.nixConfig = settings.nixConfig;
  }
  if (settings.toolsConfig) {
    mergedOptions.toolsConfig = settings.toolsConfig;
  }
  if (settings.preApprovedTools?.length) {
    mergedOptions.preApprovedTools = settings.preApprovedTools;
  }
  if (settings.pluginsConfig) {
    mergedOptions.pluginsConfig = normalizePluginsConfig(
      settings.pluginsConfig
    );
  }
  // Apply default memory plugins if no pluginsConfig from settings or baseOptions
  if (!mergedOptions.pluginsConfig) {
    mergedOptions.pluginsConfig = { plugins: buildMemoryPlugins() };
  }
  if (settings.verboseLogging !== undefined) {
    mergedOptions.verboseLogging = settings.verboseLogging;
  }

  return mergedOptions;
}

/**
 * Build a MessagePayload from common fields.
 * Extracts networkConfig, guardrailsInline, nixConfig, preApprovedTools from
 * agentOptions before constructing the payload.
 */
export function buildMessagePayload(params: {
  platform: string;
  userId: string;
  botId: string;
  conversationId: string;
  teamId: string;
  agentId: string;
  organizationId?: string;
  messageId: string;
  messageText: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  agentOptions: Record<string, any>;
}): MessagePayload {
  const {
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
    ...remainingOptions
  } = params.agentOptions;

  return {
    platform: params.platform,
    userId: params.userId,
    botId: params.botId,
    conversationId: params.conversationId,
    teamId: params.teamId,
    agentId: params.agentId,
    organizationId: params.organizationId,
    messageId: params.messageId,
    messageText: params.messageText,
    channelId: params.channelId,
    platformMetadata: params.platformMetadata,
    agentOptions: remainingOptions,
    networkConfig,
    guardrailsInline,
    nixConfig,
    preApprovedTools,
  };
}

/**
 * Resolve agent ID for an inbound platform event:
 *   1. existing `agent_channel_bindings` row wins;
 *   2. otherwise fall back to the connection's owning `agentId`.
 *
 * Returns `null` when neither resolves — the caller should drop the message.
 * Pure resolution: never writes a binding.
 *
 * `crossOrg` is for hosted preview connections only: the bot lives in one org
 * but `/lobu link <code>` binds agents from OTHER orgs, so the lookup must be
 * org-agnostic and the binding's own `organizationId` is returned for routing.
 * Leave it false for normal bots, where org-scoping is the multi-tenant guard.
 */
export async function resolveAgentId(params: {
  platform: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  channelBindingService?: ChannelBindingService;
  crossOrg?: boolean;
}): Promise<{
  agentId: string;
  source: "binding" | "connection";
  organizationId?: string;
} | null> {
  const {
    platform,
    channelId,
    teamId,
    agentId,
    organizationId,
    channelBindingService,
    crossOrg,
  } = params;

  if (channelBindingService) {
    // Bindings are org-scoped (a channel_id can be bound independently by
    // multiple tenants), so the read MUST be scoped to the inbound
    // connection's org — otherwise getBinding falls back to an org-less query
    // and can route a message to another tenant's agent. Preview connections
    // are the deliberate exception: they fan out across orgs (see crossOrg).
    const binding = crossOrg
      ? await channelBindingService.getBindingAnyOrg(platform, channelId, teamId)
      : await channelBindingService.getBinding(
          platform,
          channelId,
          teamId,
          organizationId
        );
    if (binding) {
      logger.info(
        {
          agentId: binding.agentId,
          platform,
          channelId,
          bindingOrg: binding.organizationId,
        },
        "Routing via existing channel binding"
      );
      return {
        agentId: binding.agentId,
        source: "binding",
        organizationId: binding.organizationId,
      };
    }
  }

  if (agentId) {
    logger.info(
      { agentId, platform, channelId },
      "Routing to connection's owning agent"
    );
    return { agentId, source: "connection", organizationId };
  }

  return null;
}
