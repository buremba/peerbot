/**
 * OpenClaw Plugin Loader
 *
 * Discovers, validates, and loads OpenClaw plugins. Provides a shim
 * OpenClawPluginApi that captures tool and memory registrations so Lobu
 * can route them to the worker's agent session.
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
  type OpenClawMemoryDef,
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
 * Creates a shim OpenClawPluginApi that captures tool and memory registrations
 * from a plugin's register() or init() call.
 */
function createPluginApiShim(
  pluginId: string,
  pluginConfig: Record<string, unknown>
): { api: Record<string, unknown>; registrations: PluginRegistrations } {
  const registrations: PluginRegistrations = {
    id: pluginId,
    tools: [],
    memory: null,
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
      tts: null,
      stt: null,
    },

    registerTool(definition: OpenClawToolDef) {
      logger.info(`Plugin ${pluginId} registered tool: ${definition.name}`);
      registrations.tools.push(definition);
    },

    // Unsupported slot registrations — log and ignore
    registerChannel() {
      logger.debug(
        `Plugin ${pluginId} tried to register channel (not supported in Lobu)`
      );
    },

    registerProvider() {
      logger.debug(
        `Plugin ${pluginId} tried to register provider (not supported in Lobu)`
      );
    },

    registerService() {
      logger.debug(
        `Plugin ${pluginId} tried to register service (not supported in Lobu)`
      );
    },

    registerGatewayMethod() {
      // no-op
    },

    registerCommand() {
      // no-op
    },

    registerCli() {
      // no-op
    },

    on() {
      // no-op
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
 * Scans @openclaw/* and @* /openclaw-* packages (community namespace).
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
    // @openclaw directory doesn't exist
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
            rpc: {},
          });

          // Capture slot-specific registrations from init result
          const slot = exported.slot || exported.kind;
          if (slot === "memory") {
            registrations.memory = result as OpenClawMemoryDef;
            registrations.slot = "memory";
          } else if (slot === "tool") {
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
    `Plugin ${pluginId} loaded: ${registrations.tools.length} tools, memory=${!!registrations.memory}`
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
 */
export async function discoverPlugins(
  options?: PluginLoaderOptions
): Promise<DiscoveredPlugin[]> {
  const baseDir = options?.baseDir || process.cwd();
  const discovered: DiscoveredPlugin[] = [];

  const fromNpm = await discoverFromNodeModules(baseDir);
  discovered.push(...fromNpm);

  for (const dir of options?.extensionDirs || []) {
    const fromDir = await discoverFromExtensions(dir);
    discovered.push(...fromDir);
  }

  logger.info(`Discovered ${discovered.length} OpenClaw plugins`);
  return discovered;
}

/**
 * Load all enabled plugins from a PluginsConfig.
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
      // Check exclusive slot constraints (memory is exclusive — one at a time)
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
  return memoryPlugins[0];
}
