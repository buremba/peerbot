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
import type { DeclaredAgentRegistry } from "./declared-agent-registry";
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
    !runtimeDefault?.config
  ) {
    return plugin;
  }

  const runtimeMcpUrl = runtimeDefault.config.mcpUrl;
  const runtimeGatewayAuthUrl = runtimeDefault.config.gatewayAuthUrl;

  const storedMcpUrl = plugin.config?.mcpUrl;
  const storedGatewayAuthUrl = plugin.config?.gatewayAuthUrl;

  // Inject runtime defaults when the override omits mcpUrl / gatewayAuthUrl
  // entirely — users shouldn't need to hand-write internal gateway URLs.
  const shouldInjectMcpUrl =
    storedMcpUrl === undefined && typeof runtimeMcpUrl === "string";
  const shouldInjectGatewayAuthUrl =
    storedGatewayAuthUrl === undefined &&
    typeof runtimeGatewayAuthUrl === "string";

  // Rewrite stale internal URLs that look like they were captured from a
  // previous runtime (e.g. `http://gateway:8080/mcp/owletto`) so they match
  // the current gateway address.
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

  if (
    !shouldInjectMcpUrl &&
    !shouldInjectGatewayAuthUrl &&
    !shouldReplaceMcpUrl &&
    !shouldReplaceGatewayAuthUrl
  ) {
    return plugin;
  }

  return {
    ...plugin,
    config: {
      ...plugin.config,
      ...(shouldInjectMcpUrl || shouldReplaceMcpUrl
        ? { mcpUrl: runtimeMcpUrl }
        : {}),
      ...(shouldInjectGatewayAuthUrl || shouldReplaceGatewayAuthUrl
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
  if (settings.preApprovedTools?.length) {
    mergedOptions.preApprovedTools = settings.preApprovedTools;
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
  agentSettingsStore?: AgentSettingsStore,
  declaredAgents?: DeclaredAgentRegistry
): Promise<boolean> {
  if (!agentSettingsStore) return true;

  const declaredEntry = declaredAgents?.get(agentId);
  if (declaredEntry?.credentials.length) return true;

  const settings = await agentSettingsStore.getEffectiveSettings(agentId);
  const installedProviderIds = new Set<string>([
    ...(settings?.installedProviders ?? []).map((p) => p.providerId),
    ...(declaredEntry?.settings.installedProviders ?? []).map(
      (p) => p.providerId
    ),
  ]);

  const modules = getModelProviderModules();
  if (installedProviderIds.size === 0) {
    return modules.some((m) => m.hasSystemKey());
  }
  return modules.some(
    (m) => installedProviderIds.has(m.providerId) && m.hasSystemKey()
  );
}

/**
 * Build a MessagePayload from common fields.
 * Extracts networkConfig, nixConfig, mcpServers, preApprovedTools from
 * agentOptions before constructing the payload.
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
  const {
    networkConfig,
    nixConfig,
    mcpServers,
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
    messageId: params.messageId,
    messageText: params.messageText,
    channelId: params.channelId,
    platformMetadata: params.platformMetadata,
    agentOptions: remainingOptions,
    networkConfig,
    nixConfig,
    mcpConfig: mcpServers ? { mcpServers } : undefined,
    preApprovedTools,
  };
}

/**
 * Resolve agent ID with a deterministic 3-tier precedence:
 *   1. `binding`  — an existing `channel_binding:*` record wins.
 *   2. `template` — a connection-owned `templateAgentId` is used and the
 *      caller is expected to persist a binding so tier 1 hits next time.
 *   3. `shadow`   — `{platform}-g-{channelId}` / `{platform}-{userId}` fallback
 *      for admin-UI connections with no owning agent.
 *
 * Pure resolution: never writes a binding. The caller owns the auto-bind
 * side effect (see message-handler-bridge), so this function stays safe to
 * call from tests and from read-only code paths.
 */
export async function resolveAgentId(params: {
  platform: string;
  userId: string;
  channelId: string;
  isGroup: boolean;
  teamId?: string;
  templateAgentId?: string;
  channelBindingService?: ChannelBindingService;
}): Promise<{ agentId: string; source: "binding" | "template" | "shadow" }> {
  const {
    platform,
    userId,
    channelId,
    isGroup,
    teamId,
    templateAgentId,
    channelBindingService,
  } = params;

  if (channelBindingService) {
    const binding = await channelBindingService.getBinding(
      platform,
      channelId,
      teamId
    );
    if (binding) {
      logger.info(
        { agentId: binding.agentId, platform, channelId },
        "Routing via existing channel binding"
      );
      return { agentId: binding.agentId, source: "binding" };
    }
  }

  if (templateAgentId) {
    logger.info(
      { agentId: templateAgentId, platform, channelId },
      "Routing to connection template agent"
    );
    return { agentId: templateAgentId, source: "template" };
  }

  const agentId = platformAgentId(platform, userId, channelId, isGroup);
  logger.info(
    { agentId, platform, channelId },
    "Routing to shadow agent (no binding, no template)"
  );
  return { agentId, source: "shadow" };
}
