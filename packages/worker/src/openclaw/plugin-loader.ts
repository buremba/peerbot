/**
 * OpenClaw plugin loader.
 *
 * Loads OpenClaw community plugins by dynamic-importing their package,
 * providing a shim ExtensionAPI that captures registerTool() and
 * registerProvider() calls. Event hooks and other registrations are no-oped.
 *
 * Tool definitions are captured as-is (full ToolDefinition from pi-coding-agent)
 * so signal, ctx, onUpdate all pass through to the plugin's execute function.
 */

import {
  createLogger,
  type PluginConfig,
  type PluginManifest,
  type PluginsConfig,
  type ProviderRegistration,
} from "@lobu/core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

const logger = createLogger("openclaw-plugin-loader");

/** Result of loading a single plugin */
export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Raw ToolDefinition objects captured from registerTool() — no bridging needed */
  tools: ToolDefinition[];
  providers: ProviderRegistration[];
}

/**
 * Load all enabled plugins from config.
 */
export async function loadPlugins(
  config: PluginsConfig | undefined
): Promise<LoadedPlugin[]> {
  if (!config?.plugins?.length) {
    return [];
  }

  const enabledPlugins = config.plugins.filter((p) => p.enabled !== false);
  if (enabledPlugins.length === 0) {
    return [];
  }

  logger.info(`Loading ${enabledPlugins.length} plugin(s)`);

  const results: LoadedPlugin[] = [];

  for (const pluginConfig of enabledPlugins) {
    try {
      const loaded = await loadSinglePlugin(pluginConfig);
      if (loaded) {
        results.push(loaded);
        const parts = [];
        if (loaded.tools.length > 0)
          parts.push(`${loaded.tools.length} tool(s)`);
        if (loaded.providers.length > 0)
          parts.push(`${loaded.providers.length} provider(s)`);
        logger.info(
          `Loaded plugin "${loaded.manifest.name}" with ${parts.join(", ") || "no registrations"}`
        );
      }
    } catch (err) {
      logger.error(
        `Failed to load plugin "${pluginConfig.source}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return results;
}

/**
 * Load a single plugin by resolving its module and invoking its factory.
 */
async function loadSinglePlugin(
  config: PluginConfig
): Promise<LoadedPlugin | null> {
  const { source, slot } = config;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(source)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Cannot import "${source}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const factory = resolveFactory(mod);
  if (!factory) {
    logger.warn(`Plugin "${source}" has no extension factory - skipping`);
    return null;
  }

  const capturedTools: ToolDefinition[] = [];
  const capturedProviders: ProviderRegistration[] = [];
  const shimApi = createShimApi(capturedTools, capturedProviders);

  await Promise.resolve(factory(shimApi));

  return {
    manifest: {
      source,
      slot,
      name: extractPluginName(source),
    },
    tools: capturedTools,
    providers: capturedProviders,
  };
}

/**
 * Resolve the extension factory from a module's exports.
 * Looks for: default export, `register`, or `init`.
 */
function resolveFactory(
  mod: Record<string, unknown>
): ((api: unknown) => void | Promise<void>) | null {
  const defaultExport = mod.default;
  if (typeof defaultExport === "function") {
    return defaultExport as (api: unknown) => void | Promise<void>;
  }

  for (const name of ["register", "init"]) {
    const fn = mod[name];
    if (typeof fn === "function") {
      return fn as (api: unknown) => void | Promise<void>;
    }
  }

  return null;
}

/**
 * Create a shim ExtensionAPI that captures tool and provider registrations
 * and no-ops everything else.
 *
 * Tool definitions are captured as raw ToolDefinition objects (the same type
 * pi-coding-agent uses) so execute(toolCallId, params, signal, onUpdate, ctx)
 * passes through unchanged.
 */
function createShimApi(
  capturedTools: ToolDefinition[],
  capturedProviders: ProviderRegistration[]
): Record<string, unknown> {
  const noop = () => {
    /* intentional no-op */
  };

  return {
    // Capture tool registrations as-is (full ToolDefinition passthrough)
    registerTool(toolDef: Record<string, unknown>) {
      if (
        typeof toolDef.name !== "string" ||
        typeof toolDef.description !== "string" ||
        typeof toolDef.execute !== "function"
      ) {
        logger.warn(
          "Plugin registered invalid tool - missing name, description, or execute"
        );
        return;
      }

      // Store the full ToolDefinition object — name, label, description,
      // parameters, execute, renderCall, renderResult all preserved.
      capturedTools.push(toolDef as unknown as ToolDefinition);
    },

    // Capture provider registrations (passed through to ModelRegistry)
    registerProvider(name: unknown, config: unknown) {
      if (typeof name !== "string" || !name.trim()) {
        logger.warn("Plugin registered provider with invalid name");
        return;
      }
      if (typeof config !== "object" || config === null) {
        logger.warn(`Plugin registered provider "${name}" with invalid config`);
        return;
      }

      capturedProviders.push({
        name: name.trim(),
        config: config as Record<string, unknown>,
      });
    },

    // No-op all event hooks
    on: noop,

    // No-op other registration methods
    registerCommand: noop,
    registerShortcut: noop,
    registerFlag: noop,
    registerChannel: noop,

    // Expose minimal context that plugins might read
    cwd: process.cwd(),
  };
}

/**
 * Extract a display name from a plugin source string.
 * "@openclaw/voice-call" -> "voice-call"
 * "./my-plugin" -> "my-plugin"
 */
function extractPluginName(source: string): string {
  const scopeMatch = source.match(/^@[^/]+\/(.+)$/);
  if (scopeMatch?.[1]) {
    return scopeMatch[1];
  }

  const parts = source.split("/");
  return parts[parts.length - 1] || source;
}
