/**
 * Shared platform helpers.
 * Extracts common logic duplicated across Slack, Telegram, and WhatsApp message handlers.
 */

import {
  createLogger,
  type PluginConfig,
  type PluginsConfig,
} from "@lobu/core";
import type { AgentSettingsStore } from "../auth/settings";
import { resolveEffectiveModelRef } from "../auth/settings/model-selection";
import type { ChannelBindingService } from "../channels";
import { buildMemoryPlugins, getInternalGatewayUrl } from "../config";
import type { MessagePayload } from "../infrastructure/queue/queue-producer";
import { getModelProviderModules } from "../modules/module-system";
import { platformAgentId } from "../spaces";

const logger = createLogger("platform-helpers");
const OWLETTO_PLUGIN_SOURCE = "@lobu/owletto-openclaw";

function readOwlettoRuntimeDefaults(): PluginConfig | null {
  const configuredPlugin = buildMemoryPlugins().find(
    (plugin) =>
      plugin.source === OWLETTO_PLUGIN_SOURCE && plugin.slot === "memory"
  );
  if (configuredPlugin) {
    return configuredPlugin;
  }

  const gatewayUrl = getInternalGatewayUrl();
  return {
    source: OWLETTO_PLUGIN_SOURCE,
    slot: "memory",
    enabled: true,
    config: {
      mcpUrl: `${gatewayUrl}/mcp/owletto`,
      gatewayAuthUrl: gatewayUrl,
    },
  };
}

function normalizeOwlettoPluginConfig(
  plugin: PluginConfig,
  runtimeDefault: PluginConfig | null
): PluginConfig {
  if (
    plugin.source !== OWLETTO_PLUGIN_SOURCE ||
    plugin.slot !== "memory" ||
    !runtimeDefault?.config ||
    !plugin.config
  ) {
    return plugin;
  }

  const storedMcpUrl = plugin.config.mcpUrl;
  const storedGatewayAuthUrl = plugin.config.gatewayAuthUrl;
  const runtimeMcpUrl = runtimeDefault.config.mcpUrl;
  const runtimeGatewayAuthUrl = runtimeDefault.config.gatewayAuthUrl;

  const shouldReplaceMcpUrl =
    typeof storedMcpUrl === "string" &&
    typeof runtimeMcpUrl === "string" &&
    runtimeMcpUrl !== storedMcpUrl &&
    /^https?:\/\/gateway(?::\d+)?\/mcp\/owletto\/?$/.test(storedMcpUrl);
  const shouldReplaceGatewayAuthUrl =
    typeof storedGatewayAuthUrl === "string" &&
    typeof runtimeGatewayAuthUrl === "string" &&
    runtimeGatewayAuthUrl !== storedGatewayAuthUrl &&
    /^https?:\/\/gateway(?::\d+)?\/?$/.test(storedGatewayAuthUrl);

  if (!shouldReplaceMcpUrl && !shouldReplaceGatewayAuthUrl) {
    return plugin;
  }

  return {
    ...plugin,
    config: {
      ...plugin.config,
      ...(shouldReplaceMcpUrl ? { mcpUrl: runtimeMcpUrl } : {}),
      ...(shouldReplaceGatewayAuthUrl
        ? { gatewayAuthUrl: runtimeGatewayAuthUrl }
        : {}),
    },
  };
}

function normalizePluginsConfig(
  pluginsConfig: PluginsConfig | undefined
): PluginsConfig | undefined {
  if (!pluginsConfig?.plugins?.length) {
    return pluginsConfig;
  }

  const runtimeDefault = readOwlettoRuntimeDefaults();
  let changed = false;
  const plugins = pluginsConfig.plugins.map((plugin) => {
    const normalized = normalizeOwlettoPluginConfig(plugin, runtimeDefault);
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

  const settings = await agentSettingsStore.getEffectiveSettings(agentId);
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
  if (settings.nixConfig) {
    mergedOptions.nixConfig = settings.nixConfig;
  }
  if (settings.toolsConfig) {
    mergedOptions.toolsConfig = settings.toolsConfig;
  }
  if (settings.mcpServers) {
    mergedOptions.mcpServers = settings.mcpServers;
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

export async function hasConfiguredProvider(
  agentId: string,
  agentSettingsStore?: AgentSettingsStore
): Promise<boolean> {
  if (!agentSettingsStore) {
    return true;
  }

  const settings = await agentSettingsStore.getEffectiveSettings(agentId);
  const installedProviderIds = new Set(
    (settings?.installedProviders || []).map((provider) => provider.providerId)
  );

  if ((settings?.authProfiles?.length || 0) > 0) {
    return true;
  }

  const modules = getModelProviderModules();
  if (installedProviderIds.size > 0) {
    return modules.some(
      (module) =>
        installedProviderIds.has(module.providerId) && module.hasSystemKey()
    );
  }

  return modules.some((module) => module.hasSystemKey());
}

/**
 * Build a MessagePayload from common fields.
 * Extracts networkConfig, nixConfig, mcpServers from agentOptions before constructing the payload.
 */
export function buildMessagePayload(params: {
  platform: string;
  userId: string;
  botId: string;
  conversationId: string;
  teamId: string;
  agentId: string;
  messageId: string;
  messageText: string;
  channelId: string;
  platformMetadata: Record<string, any>;
  agentOptions: Record<string, any>;
}): MessagePayload {
  const { networkConfig, nixConfig, mcpServers, ...remainingOptions } =
    params.agentOptions;

  return {
    platform: params.platform,
    userId: params.userId,
    botId: params.botId,
    conversationId: params.conversationId,
    teamId: params.teamId,
    agentId: params.agentId,
    messageId: params.messageId,
    messageText: params.messageText,
    channelId: params.channelId,
    platformMetadata: params.platformMetadata,
    agentOptions: remainingOptions,
    networkConfig,
    nixConfig,
    mcpConfig: mcpServers ? { mcpServers } : undefined,
  };
}

/**
 * Resolve agent ID. Deterministic for all platforms.
 * Channel binding is checked first for Slack (multi-tenant), then falls back to platformAgentId.
 */
export async function resolveAgentId(params: {
  platform: string;
  userId: string;
  channelId: string;
  isGroup: boolean;
  teamId?: string;
  channelBindingService?: ChannelBindingService;
  sendConfigPrompt?: () => Promise<boolean>;
}): Promise<{ agentId: string; promptSent: boolean }> {
  const {
    platform,
    userId,
    channelId,
    isGroup,
    teamId,
    channelBindingService,
    sendConfigPrompt,
  } = params;

  // Check channel binding first (Slack multi-tenant)
  if (channelBindingService) {
    const binding = await channelBindingService.getBinding(
      platform,
      channelId,
      teamId
    );
    if (binding) {
      logger.info({ agentId: binding.agentId, channelId }, "Using bound agent");
      return { agentId: binding.agentId, promptSent: false };
    }

    if (sendConfigPrompt) {
      const sent = await sendConfigPrompt();
      if (sent) return { agentId: "", promptSent: true };
    }
  }

  const agentId = platformAgentId(platform, userId, channelId, isGroup);
  logger.info(
    { agentId, platform, channelId },
    "Deterministic agent ID resolved"
  );
  return { agentId, promptSent: false };
}
