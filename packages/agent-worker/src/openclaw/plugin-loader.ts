/**
 * OpenClaw plugin loader.
 *
 * Loads plugin modules by dynamic import and provides a compatibility shim.
 * Supports both legacy function-style plugins and object-style plugins with
 * a `register(api)` method.
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

type PluginHookName = "before_agent_start" | "agent_end";

type PluginHookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>
) => unknown | Promise<unknown>;

interface PluginService {
  id: string;
  start?: () => unknown | Promise<unknown>;
  stop?: () => unknown | Promise<unknown>;
}

/** Result of loading a single plugin */
interface LoadedPlugin {
  manifest: PluginManifest;
  /** Raw ToolDefinition objects captured from registerTool() — no bridging needed */
  tools: ToolDefinition[];
  providers: ProviderRegistration[];
  hooks: Record<PluginHookName, PluginHookHandler[]>;
  services: PluginService[];
}

/**
 * Load all enabled plugins from config.
 */
export async function loadPlugins(
  config: PluginsConfig | undefined,
  cwd?: string
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
      const loaded = await loadSinglePlugin(pluginConfig, cwd);
      if (loaded) {
        results.push(loaded);
        const parts = [];
        if (loaded.tools.length > 0)
          parts.push(`${loaded.tools.length} tool(s)`);
        if (loaded.providers.length > 0)
          parts.push(`${loaded.providers.length} provider(s)`);
        const hookCount =
          loaded.hooks.before_agent_start.length +
          loaded.hooks.agent_end.length;
        if (hookCount > 0) parts.push(`${hookCount} hook(s)`);
        if (loaded.services.length > 0)
          parts.push(`${loaded.services.length} service(s)`);
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
  config: PluginConfig,
  cwd?: string
): Promise<LoadedPlugin | null> {
  const { source, slot, config: pluginConfig } = config;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(source)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Cannot import "${source}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const pluginEntrypoint = resolvePluginEntrypoint(mod);
  if (!pluginEntrypoint) {
    logger.warn(`Plugin "${source}" has no registerable entrypoint - skipping`);
    return null;
  }

  const capturedTools: ToolDefinition[] = [];
  const capturedProviders: ProviderRegistration[] = [];
  const capturedHooks: Record<PluginHookName, PluginHookHandler[]> = {
    before_agent_start: [],
    agent_end: [],
  };
  const capturedServices: PluginService[] = [];
  const shimApi = createShimApi({
    source,
    pluginConfig: pluginConfig ?? {},
    capturedTools,
    capturedProviders,
    capturedHooks,
    capturedServices,
    cwd,
  });

  await Promise.resolve(pluginEntrypoint.register(shimApi));
  const pluginName =
    readStringProperty(pluginEntrypoint.metadata, "name") ||
    extractPluginName(source);

  return {
    manifest: {
      source,
      slot,
      name: pluginName,
    },
    tools: capturedTools,
    providers: capturedProviders,
    hooks: capturedHooks,
    services: capturedServices,
  };
}

/**
 * Resolve plugin entrypoint from module exports.
 * Supports:
 * - default export function (legacy)
 * - default export object with register(api)
 * - named register/init functions
 */
function resolvePluginEntrypoint(mod: Record<string, unknown>): {
  register: (api: unknown) => void | Promise<void>;
  metadata?: Record<string, unknown>;
} | null {
  const defaultExport = mod.default;
  if (typeof defaultExport === "function") {
    return {
      register: defaultExport as (api: unknown) => void | Promise<void>,
    };
  }

  if (isRecord(defaultExport) && typeof defaultExport.register === "function") {
    return {
      register: defaultExport.register as (
        api: unknown
      ) => void | Promise<void>,
      metadata: defaultExport,
    };
  }

  for (const name of ["register", "init"]) {
    const fn = mod[name];
    if (typeof fn === "function") {
      return {
        register: fn as (api: unknown) => void | Promise<void>,
      };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readStringProperty(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Create a shim API that captures tool/provider/hook/service registrations.
 * Non-worker capabilities are no-oped for compatibility.
 */
function createShimApi(params: {
  source: string;
  pluginConfig: Record<string, unknown>;
  capturedTools: ToolDefinition[];
  capturedProviders: ProviderRegistration[];
  capturedHooks: Record<PluginHookName, PluginHookHandler[]>;
  capturedServices: PluginService[];
  cwd?: string;
}): Record<string, unknown> {
  const {
    source,
    pluginConfig,
    capturedTools,
    capturedProviders,
    capturedHooks,
    capturedServices,
    cwd,
  } = params;
  const noop = () => {
    /* intentional no-op */
  };

  const shimLogger = {
    info(message: string, ...args: unknown[]) {
      logger.info(`[plugin:${extractPluginName(source)}] ${message}`, ...args);
    },
    warn(message: string, ...args: unknown[]) {
      logger.warn(`[plugin:${extractPluginName(source)}] ${message}`, ...args);
    },
    error(message: string, ...args: unknown[]) {
      logger.error(`[plugin:${extractPluginName(source)}] ${message}`, ...args);
    },
    debug(message: string, ...args: unknown[]) {
      logger.debug(`[plugin:${extractPluginName(source)}] ${message}`, ...args);
    },
  };

  return {
    pluginConfig,
    logger: shimLogger,

    on(eventName: unknown, handler: unknown) {
      if (
        (eventName === "before_agent_start" || eventName === "agent_end") &&
        typeof handler === "function"
      ) {
        capturedHooks[eventName].push(handler as PluginHookHandler);
        return;
      }
      logger.debug(
        `Plugin "${source}" registered unsupported hook "${String(eventName)}"`
      );
    },

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

    registerService(service: unknown) {
      if (!isRecord(service)) {
        logger.warn(`Plugin "${source}" registered invalid service`);
        return;
      }
      const id = readStringProperty(service, "id");
      if (!id) {
        logger.warn(`Plugin "${source}" registered service without valid id`);
        return;
      }
      const start =
        typeof service.start === "function"
          ? (service.start as () => unknown | Promise<unknown>)
          : undefined;
      const stop =
        typeof service.stop === "function"
          ? (service.stop as () => unknown | Promise<unknown>)
          : undefined;
      capturedServices.push({ id, start, stop });
    },

    // No-op compatibility methods (worker runtime does not expose these surfaces)
    registerCli: noop,
    registerCommand: noop,
    registerShortcut: noop,
    registerFlag: noop,
    registerChannel: noop,
    registerMessageRenderer: noop,
    sendMessage: noop,
    sendUserMessage: noop,
    appendEntry: noop,
    setSessionName: noop,
    getSessionName: () => undefined,
    setLabel: noop,
    exec: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "exec is not supported in Lobu worker plugin shim",
    }),
    getActiveTools: () => [] as string[],
    getAllTools: () => [] as Array<{ name: string; description: string }>,
    setActiveTools: noop,
    getCommands: () => [] as unknown[],
    setModel: async () => false,
    getThinkingLevel: () => "medium",
    setThinkingLevel: noop,
    events: {
      on: noop,
      off: noop,
      emit: noop,
    },

    // Expose minimal context that plugins might read
    cwd: cwd || process.cwd(),
  };
}

export async function runPluginHooks(params: {
  plugins: LoadedPlugin[];
  hook: PluginHookName;
  event: Record<string, unknown>;
  ctx: Record<string, unknown>;
}): Promise<unknown[]> {
  const { plugins, hook, event, ctx } = params;
  const results: unknown[] = [];
  for (const plugin of plugins) {
    const handlers = plugin.hooks[hook];
    if (handlers.length === 0) continue;

    for (const handler of handlers) {
      try {
        const result = await Promise.resolve(handler(event, ctx));
        results.push(result);
      } catch (err) {
        logger.error(
          `Plugin hook "${hook}" failed for "${plugin.manifest.name}": ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
  return results;
}

export async function startPluginServices(
  plugins: LoadedPlugin[]
): Promise<void> {
  for (const plugin of plugins) {
    for (const service of plugin.services) {
      if (!service.start) continue;
      try {
        await Promise.resolve(service.start());
      } catch (err) {
        logger.error(
          `Plugin service "${service.id}" failed to start (${plugin.manifest.name}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

export async function stopPluginServices(
  plugins: LoadedPlugin[]
): Promise<void> {
  for (const plugin of [...plugins].reverse()) {
    for (const service of [...plugin.services].reverse()) {
      if (!service.stop) continue;
      try {
        await Promise.resolve(service.stop());
      } catch (err) {
        logger.error(
          `Plugin service "${service.id}" failed to stop (${plugin.manifest.name}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
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
