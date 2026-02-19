/**
 * OpenClaw Plugin Loader
 *
 * Discovers, validates, and loads OpenClaw plugins. Provides a shim
 * OpenClawPluginApi that captures all registrations (tools, channels,
 * memory, providers, services) so Lobu can route them to the appropriate
 * subsystems.
 *
 * Discovery sources:
 * - node_modules/@openclaw/*
 * - node_modules/@* /openclaw-*  (community namespace)
 * - Configured local paths (extensions/ directory)
 * - Per-agent plugin config from settings
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createLogger,
  type LoadedPlugin,
  type OpenClawChannelDef,
  type OpenClawMemoryDef,
  type OpenClawProviderDef,
  type OpenClawServiceDef,
  type OpenClawToolDef,
  type PluginConfig,
  type PluginManifest,
  type PluginRegistrations,
  type PluginsConfig,
} from "@lobu/core";

const logger = createLogger("plugin-loader");

// ============================================================================
// Plugin API Shim
// ============================================================================

/**
 * Creates a shim OpenClawPluginApi that captures all registrations
 * from a plugin's register() or init() call.
 */
function createPluginApiShim(
  pluginId: string,
  pluginConfig: Record<string, unknown>
): { api: Record<string, unknown>; registrations: PluginRegistrations } {
  const registrations: PluginRegistrations = {
    id: pluginId,
    tools: [],
    channels: [],
    memory: null,
    provider: null,
    services: [],
    commands: new Map(),
    gatewayMethods: new Map(),
  };

  const api = {
    logger: {
      info: (...args: unknown[]) =>
        logger.info(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) =>
        logger.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) =>
        logger.error(`[plugin:${pluginId}]`, ...args),
      debug: (...args: unknown[]) =>
        logger.debug(`[plugin:${pluginId}]`, ...args),
    },

    config: pluginConfig,

    runtime: {
      // Stub runtime utilities -- plugins can check capabilities
      tts: null,
      stt: null,
    },

    registerTool(definition: OpenClawToolDef) {
      logger.info(`Plugin ${pluginId} registered tool: ${definition.name}`);
      registrations.tools.push(definition);
    },

    registerChannel(opts: { plugin: OpenClawChannelDef }) {
      logger.info(`Plugin ${pluginId} registered channel: ${opts.plugin.id}`);
      registrations.channels.push(opts.plugin);
      registrations.slot = "channel";
    },

    registerProvider(config: OpenClawProviderDef) {
      logger.info(`Plugin ${pluginId} registered provider: ${config.id}`);
      registrations.provider = config;
      registrations.slot = "provider";
    },

    registerService(config: OpenClawServiceDef) {
      logger.info(`Plugin ${pluginId} registered service: ${config.type}`);
      registrations.services.push(config);
    },

    registerGatewayMethod(
      name: string,
      handler: (...args: unknown[]) => unknown
    ) {
      logger.info(`Plugin ${pluginId} registered gateway method: ${name}`);
      registrations.gatewayMethods.set(name, handler);
    },

    registerCommand(options: {
      name: string;
      handler: (...args: unknown[]) => unknown;
    }) {
      logger.info(`Plugin ${pluginId} registered command: ${options.name}`);
      registrations.commands.set(options.name, options.handler);
    },

    registerCli() {
      logger.debug(
        `Plugin ${pluginId} registered CLI (ignored in Lobu context)`
      );
    },

    // Event subscription (no-op in shim -- lifecycle hooks handled separately)
    on(event: string) {
      logger.debug(`Plugin ${pluginId} subscribed to event: ${event}`);
    },
  };

  return { api, registrations };
}

// ============================================================================
// Plugin Discovery
// ============================================================================

interface DiscoveredPlugin {
  packagePath: string;
  packageJson: Record<string, unknown>;
  manifest?: PluginManifest;
  entryPoints: string[];
}

/**
 * Read and parse openclaw.plugin.json if it exists.
 */
async function readPluginManifest(
  dir: string
): Promise<PluginManifest | undefined> {
  try {
    const manifestPath = path.join(dir, "openclaw.plugin.json");
    const content = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(content) as PluginManifest;
  } catch {
    return undefined;
  }
}

/**
 * Discover OpenClaw plugins from a node_modules directory.
 * Scans @openclaw/_ and @_/openclaw-_ packages (community namespace).
 */
async function discoverFromNodeModules(
  baseDir: string
): Promise<DiscoveredPlugin[]> {
  const nodeModules = path.join(baseDir, "node_modules");
  const discovered: DiscoveredPlugin[] = [];

  try {
    await fs.stat(nodeModules);
  } catch {
    return discovered;
  }

  // Scan @openclaw/* packages
  const openclawDir = path.join(nodeModules, "@openclaw");
  try {
    const entries = await fs.readdir(openclawDir);
    for (const entry of entries) {
      const plugin = await tryLoadPluginPackage(path.join(openclawDir, entry));
      if (plugin) discovered.push(plugin);
    }
  } catch {
    // @openclaw directory doesn't exist -- that's fine
  }

  // Scan @*/openclaw-* packages (community namespace)
  try {
    const scopes = await fs.readdir(nodeModules);
    for (const scope of scopes) {
      if (!scope.startsWith("@") || scope === "@openclaw") continue;
      try {
        const scopeDir = path.join(nodeModules, scope);
        const packages = await fs.readdir(scopeDir);
        for (const pkg of packages) {
          if (!pkg.startsWith("openclaw-")) continue;
          const plugin = await tryLoadPluginPackage(path.join(scopeDir, pkg));
          if (plugin) discovered.push(plugin);
        }
      } catch {
        // skip unreadable scope dir
      }
    }
  } catch {
    // node_modules not readable
  }

  return discovered;
}

/**
 * Discover plugins from a local extensions directory.
 */
async function discoverFromExtensions(
  extensionsDir: string
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];

  try {
    const entries = await fs.readdir(extensionsDir);
    for (const entry of entries) {
      const plugin = await tryLoadPluginPackage(
        path.join(extensionsDir, entry)
      );
      if (plugin) discovered.push(plugin);
    }
  } catch {
    // Extensions directory doesn't exist
  }

  return discovered;
}

/**
 * Try to load a plugin from a directory.
 * Returns null if not a valid OpenClaw plugin.
 */
async function tryLoadPluginPackage(
  dir: string
): Promise<DiscoveredPlugin | null> {
  try {
    const pkgPath = path.join(dir, "package.json");
    const content = await fs.readFile(pkgPath, "utf-8");
    const packageJson = JSON.parse(content);

    // Check for openclaw.extensions field
    const openclawConfig = packageJson.openclaw;
    if (
      !openclawConfig?.extensions ||
      !Array.isArray(openclawConfig.extensions)
    ) {
      return null;
    }

    const manifest = await readPluginManifest(dir);

    return {
      packagePath: dir,
      packageJson,
      manifest,
      entryPoints: openclawConfig.extensions as string[],
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Plugin Loading
// ============================================================================

/**
 * Load a single plugin by importing its entry points and calling register/init.
 */
async function loadPlugin(
  discovered: DiscoveredPlugin,
  pluginConfig: PluginConfig
): Promise<LoadedPlugin | null> {
  const pluginId =
    discovered.manifest?.id ||
    (discovered.packageJson.name as string) ||
    path.basename(discovered.packagePath);

  logger.info(`Loading plugin: ${pluginId} from ${discovered.packagePath}`);

  const { api, registrations } = createPluginApiShim(
    pluginId,
    pluginConfig.config || {}
  );

  for (const entryPoint of discovered.entryPoints) {
    const entryPath = path.resolve(discovered.packagePath, entryPoint);

    try {
      const module = await import(entryPath);
      const exported = module.default || module;

      if (typeof exported === "function") {
        // Function form: register(api)
        await exported(api);
      } else if (typeof exported === "object" && exported !== null) {
        if (typeof exported.register === "function") {
          // Object form with register method
          await exported.register(api);
        } else if (typeof exported.init === "function") {
          // PluginDefinition form with init method
          const result = await exported.init(pluginConfig.config || {}, {
            logger: api.logger,
            configDir: process.env.HOME || "/tmp",
            workspaceDir: process.cwd(),
            rpc: {}, // Stub -- will be wired at runtime
          });

          // Capture slot-specific registrations from init result
          if (exported.slot === "memory" || exported.kind === "memory") {
            registrations.memory = result as OpenClawMemoryDef;
            registrations.slot = "memory";
          } else if (
            exported.slot === "provider" ||
            exported.kind === "provider"
          ) {
            registrations.provider = result as OpenClawProviderDef;
            registrations.slot = "provider";
          } else if (
            exported.slot === "channel" ||
            exported.kind === "channel"
          ) {
            // Channel plugins return { start, stop, send } from init
            if (result && typeof result === "object") {
              const channelResult = result as {
                start?: () => Promise<void>;
                stop?: () => Promise<void>;
                send?: (envelope: unknown) => Promise<void>;
              };
              registrations.channels.push({
                id: exported.id || pluginId,
                meta: {
                  id: exported.id || pluginId,
                  label: exported.metadata?.name || pluginId,
                  docsPath: "",
                },
                capabilities: { chatTypes: ["direct", "group"] },
                config: {
                  listAccountIds: () => ["default"],
                  resolveAccount: () => ({}),
                },
                outbound: {
                  deliveryMode: "direct",
                  sendText: async (params) => {
                    if (channelResult.send) {
                      await channelResult.send(params);
                    }
                    return { ok: true };
                  },
                },
                startAccount: channelResult.start
                  ? async () => channelResult.start!()
                  : undefined,
                stopAccount: channelResult.stop
                  ? async () => channelResult.stop!()
                  : undefined,
              });
              registrations.slot = "channel";
            }
          } else if (exported.slot === "tool") {
            // Tool plugins return tool definitions from init
            if (Array.isArray(result)) {
              for (const tool of result) {
                registrations.tools.push(tool as OpenClawToolDef);
              }
            }
            registrations.slot = "tool";
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to load plugin entry point ${entryPath}:`, {
        error,
      });
      return null;
    }
  }

  // Infer slot from manifest if not set during registration
  if (!registrations.slot && discovered.manifest?.kind) {
    registrations.slot = discovered.manifest.kind;
  }

  const manifest: PluginManifest = discovered.manifest || {
    id: pluginId,
    name: (discovered.packageJson.name as string) || pluginId,
    description: (discovered.packageJson.description as string) || undefined,
  };

  logger.info(
    `Plugin ${pluginId} loaded: ${registrations.tools.length} tools, ${registrations.channels.length} channels, memory=${!!registrations.memory}, provider=${!!registrations.provider}`
  );

  return {
    manifest,
    config: pluginConfig,
    registrations,
  };
}

// ============================================================================
// Public API
// ============================================================================

export interface PluginLoaderOptions {
  /** Base directory for node_modules discovery */
  baseDir?: string;
  /** Additional directories to scan for plugins */
  extensionDirs?: string[];
}

/**
 * Discover all available OpenClaw plugins (without loading them).
 * Returns plugin IDs and metadata for configuration UI.
 */
export async function discoverPlugins(
  options?: PluginLoaderOptions
): Promise<DiscoveredPlugin[]> {
  const baseDir = options?.baseDir || process.cwd();
  const discovered: DiscoveredPlugin[] = [];

  // Discover from node_modules
  const fromNpm = await discoverFromNodeModules(baseDir);
  discovered.push(...fromNpm);

  // Discover from extension directories
  for (const dir of options?.extensionDirs || []) {
    const fromDir = await discoverFromExtensions(dir);
    discovered.push(...fromDir);
  }

  logger.info(`Discovered ${discovered.length} OpenClaw plugins`);
  return discovered;
}

/**
 * Load all enabled plugins from a PluginsConfig.
 * Returns loaded plugins organized by slot type.
 */
export async function loadPlugins(
  pluginsConfig: PluginsConfig,
  options?: PluginLoaderOptions
): Promise<LoadedPlugin[]> {
  const discovered = await discoverPlugins(options);
  const loaded: LoadedPlugin[] = [];

  for (const [pluginId, config] of Object.entries(pluginsConfig.plugins)) {
    if (!config.enabled) {
      logger.debug(`Skipping disabled plugin: ${pluginId}`);
      continue;
    }

    // Find the discovered plugin matching this config
    const found = discovered.find((d) => {
      const id =
        d.manifest?.id || d.packageJson.name || path.basename(d.packagePath);
      return id === pluginId || id === config.source;
    });

    if (!found) {
      // Try loading directly from source path
      if (config.source) {
        const directPlugin = await tryLoadPluginPackage(
          path.resolve(options?.baseDir || process.cwd(), config.source)
        );
        if (directPlugin) {
          const plugin = await loadPlugin(directPlugin, config);
          if (plugin) loaded.push(plugin);
          continue;
        }
      }

      logger.warn(`Plugin not found: ${pluginId} (source: ${config.source})`);
      continue;
    }

    const plugin = await loadPlugin(found, config);
    if (plugin) {
      // Check exclusive slot constraints
      if (pluginsConfig.slots && plugin.registrations.slot) {
        const slotAssignment = pluginsConfig.slots[plugin.registrations.slot];
        if (slotAssignment && slotAssignment !== pluginId) {
          logger.info(
            `Skipping plugin ${pluginId} -- slot ${plugin.registrations.slot} assigned to ${slotAssignment}`
          );
          continue;
        }
      }

      loaded.push(plugin);
    }
  }

  logger.info(`Loaded ${loaded.length} plugins`);
  return loaded;
}

/**
 * Filter loaded plugins by slot type.
 */
export function getPluginsBySlot(
  plugins: LoadedPlugin[],
  slot: string
): LoadedPlugin[] {
  return plugins.filter((p) => p.registrations.slot === slot);
}

/**
 * Get all tool definitions from loaded plugins.
 */
export function getPluginTools(plugins: LoadedPlugin[]): OpenClawToolDef[] {
  return plugins.flatMap((p) => p.registrations.tools);
}

/**
 * Get the active memory plugin (only one allowed).
 */
export function getActiveMemoryPlugin(
  plugins: LoadedPlugin[]
): LoadedPlugin | undefined {
  const memoryPlugins = getPluginsBySlot(plugins, "memory");
  return memoryPlugins[0]; // First one wins (slot assignment handled during loading)
}
