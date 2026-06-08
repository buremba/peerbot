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
import { isRecord } from "../shared/type-guards";

const logger = createLogger("openclaw-plugin-loader");

type PluginHookName =
  | "before_agent_start"
  | "agent_end"
  | "before_tool_call"
  | "after_tool_call";

const PLUGIN_HOOK_NAMES: readonly PluginHookName[] = [
  "before_agent_start",
  "agent_end",
  "before_tool_call",
  "after_tool_call",
];

function isPluginHookName(value: unknown): value is PluginHookName {
  return (
    typeof value === "string" &&
    (PLUGIN_HOOK_NAMES as readonly string[]).includes(value)
  );
}

type PluginHookHandler = (
  event: Record<string, unknown>,
  ctx: Record<string, unknown>
) => unknown | Promise<unknown>;

/**
 * Subset of OpenClaw's `PluginHookBeforeToolCallResult` that this shim honors.
 * `requireApproval` is captured but mapped to a soft block (see
 * {@link wrapToolsWithPluginToolHooks}) — OpenClaw's documented fallback when
 * the host cannot drive native platform approval.
 */
interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: { title?: string; description?: string };
}

function emptyHooks(): Record<PluginHookName, PluginHookHandler[]> {
  return {
    before_agent_start: [],
    agent_end: [],
    before_tool_call: [],
    after_tool_call: [],
  };
}

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
        const hookCount = Object.values(loaded.hooks).reduce(
          (n, handlers) => n + handlers.length,
          0
        );
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

  const mod = await import(source).catch((err) => {
    throw new Error(
      `Cannot import "${source}": ${err instanceof Error ? err.message : String(err)}`
    );
  });

  const pluginEntrypoint = resolvePluginEntrypoint(
    mod as Record<string, unknown>
  );
  if (!pluginEntrypoint) {
    logger.warn(`Plugin "${source}" has no registerable entrypoint - skipping`);
    return null;
  }

  const capturedTools: ToolDefinition[] = [];
  const capturedProviders: ProviderRegistration[] = [];
  const capturedHooks: Record<PluginHookName, PluginHookHandler[]> =
    emptyHooks();
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
    // No-op stub for shim plugin APIs that this loader does not implement.
  };

  const prefix = `[plugin:${extractPluginName(source)}]`;
  const shimLogger = {
    info: (message: string, ...args: unknown[]) =>
      logger.info(`${prefix} ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) =>
      logger.warn(`${prefix} ${message}`, ...args),
    error: (message: string, ...args: unknown[]) =>
      logger.error(`${prefix} ${message}`, ...args),
    debug: (message: string, ...args: unknown[]) =>
      logger.debug(`${prefix} ${message}`, ...args),
  };

  return {
    pluginConfig,
    logger: shimLogger,

    on(eventName: unknown, handler: unknown) {
      if (isPluginHookName(eventName) && typeof handler === "function") {
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

type LooseToolResult = { content: unknown[]; details: unknown };
type LooseToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown
) => Promise<LooseToolResult>;

/** Minimal structural shape this wrapper needs from a tool. */
interface WrappableTool {
  name: string;
  execute: (...args: never[]) => Promise<unknown>;
}

/**
 * Wrap each tool so plugin `before_tool_call` / `after_tool_call` hooks run
 * around its execution. Tools execute in-process and never traverse the gateway
 * MCP proxy, so this wrapper is the only place those OpenClaw hooks can fire.
 *
 * Generic over the tool type so it wraps both built-in tools (`AgentTool`) and
 * plugin/MCP custom tools (`ToolDefinition`) — OpenClaw fires `before_tool_call`
 * for every tool, including bash/read/edit/write, so a plugin policy hook must
 * see them all.
 *
 * `before_tool_call` runs sequentially and honors:
 *  - `params` — shallow-merged into the tool args before execution
 *  - `block` + `blockReason` — the tool is NOT executed; the reason is returned
 *    to the agent. `block: true` is terminal (skips lower-priority handlers).
 *  - `requireApproval` — mapped to a soft block using the description/title.
 *    This is OpenClaw's documented fallback when the host cannot drive native
 *    platform approval; `block` takes precedence over it. (Live platform
 *    approval is intentionally out of scope here.)
 * A handler that throws fails closed (blocks the call).
 *
 * `after_tool_call` is a fire-and-forget notification (returns void upstream).
 *
 * Tools are returned unchanged when no plugin registered tool hooks.
 */
export function wrapToolsWithPluginToolHooks<T extends WrappableTool>(
  tools: T[],
  plugins: LoadedPlugin[],
  ctx: Record<string, unknown>
): T[] {
  const beforeHandlers = plugins.flatMap((p) => p.hooks.before_tool_call);
  const afterHandlers = plugins.flatMap((p) => p.hooks.after_tool_call);
  if (beforeHandlers.length === 0 && afterHandlers.length === 0) {
    return tools;
  }

  return tools.map((tool) => {
    const toolName = tool.name;
    const originalExecute = tool.execute.bind(tool) as LooseToolExecute;

    const wrappedExecute: LooseToolExecute = async (
      toolCallId,
      params,
      signal,
      onUpdate,
      execCtx
    ) => {
      let mergedParams: Record<string, unknown> = { ...(params ?? {}) };
      let blockReason: string | undefined;
      let approvalReason: string | undefined;

      for (const handler of beforeHandlers) {
        let result: unknown;
        try {
          result = await Promise.resolve(
            handler({ toolName, params: mergedParams, toolCallId }, ctx)
          );
        } catch (err) {
          // Fail closed: a throwing pre-tool hook blocks the call.
          blockReason = `before_tool_call hook threw: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
        if (!result || typeof result !== "object") continue;
        const r = result as BeforeToolCallResult;
        if (r.params && typeof r.params === "object") {
          mergedParams = { ...mergedParams, ...r.params };
        }
        if (r.block === true) {
          blockReason = r.blockReason?.trim() || "Blocked by plugin policy.";
          break; // block is terminal — skip lower-priority handlers
        }
        if (r.requireApproval && approvalReason === undefined) {
          const ra = r.requireApproval;
          approvalReason =
            ra.description?.trim() ||
            ra.title?.trim() ||
            "This tool call requires human approval.";
          // not terminal: a later handler may still hard-block
        }
      }

      // `block` takes precedence over `requireApproval`.
      const denyReason = blockReason ?? approvalReason;
      if (denyReason !== undefined) {
        logger.info(
          `Plugin before_tool_call blocked "${toolName}": ${denyReason}`
        );
        return {
          content: [{ type: "text" as const, text: `⛔ ${denyReason}` }],
          details: undefined,
        };
      }

      const execResult = await originalExecute(
        toolCallId,
        mergedParams,
        signal,
        onUpdate,
        execCtx
      );

      // after_tool_call is a fire-and-forget notification: it must not delay
      // the tool result, and a handler that throws (sync or async) must never
      // fail a tool that already ran. Dispatch detached in a microtask (so
      // synchronous throws become catchable rejections) and don't await.
      for (const handler of afterHandlers) {
        Promise.resolve()
          .then(() =>
            handler(
              {
                toolName,
                params: mergedParams,
                toolCallId,
                result: execResult,
              },
              ctx
            )
          )
          .catch((err) =>
            logger.error(
              `after_tool_call hook failed for "${toolName}": ${err instanceof Error ? err.message : String(err)}`
            )
          );
      }

      return execResult;
    };

    return {
      ...tool,
      execute: wrappedExecute,
    } as unknown as T;
  });
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
