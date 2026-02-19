/**
 * OpenClaw Plugin System Types
 *
 * Defines the interfaces for loading, configuring, and bridging OpenClaw plugins
 * into Lobu's architecture. Supports two plugin slot types:
 * - tool: Agent capabilities (tools available during turns)
 * - memory: Context recall/save backends (exclusive slot - one active at a time)
 */

// ============================================================================
// Plugin Configuration (stored in AgentSettings)
// ============================================================================

/** Slot types supported by OpenClaw plugins */
export type PluginSlot = "tool" | "memory";

/** Individual plugin configuration in agent settings */
export interface PluginConfig {
  /** npm package name or local path (e.g., "@openclaw/tool-websearch", "./extensions/memory-rag") */
  source: string;
  /** Whether this plugin is currently enabled */
  enabled: boolean;
  /** Plugin-specific configuration values (validated against plugin's configSchema) */
  config?: Record<string, unknown>;
}

/** Plugins configuration for agent settings */
export interface PluginsConfig {
  /** Installed plugins keyed by plugin ID */
  plugins: Record<string, PluginConfig>;
  /** Exclusive slot assignments (e.g., { memory: "memory-core" }) */
  slots?: Record<string, string>;
}

// ============================================================================
// Plugin Manifest (read from plugin package)
// ============================================================================

/** Plugin manifest from openclaw.plugin.json or package.json */
export interface PluginManifest {
  id: string;
  name?: string;
  description?: string;
  kind?: PluginSlot;
  configSchema?: Record<string, unknown>;
  skills?: string[];
}

// ============================================================================
// Plugin API (shim provided to plugins during registration)
// ============================================================================

/** Tool definition as registered by OpenClaw plugins */
export interface OpenClawToolDef {
  name: string;
  description: string;
  parameters: unknown; // TypeBox schema
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

/** Memory plugin interface */
export interface OpenClawMemoryDef {
  indexChunk?: (
    path: string,
    content: string,
    metadata?: unknown
  ) => Promise<void>;
  search?: (
    query: string,
    options?: unknown
  ) => Promise<OpenClawMemoryResult[]>;
  recall?: (query: string) => Promise<string>;
  save?: (content: string, metadata?: unknown) => Promise<void>;
}

export interface OpenClawMemoryResult {
  text: string;
  path?: string;
  score?: number;
  metadata?: unknown;
}

/**
 * Collected registrations from an OpenClaw plugin.
 * The plugin loader calls register(api) and captures all registrations here.
 */
export interface PluginRegistrations {
  id: string;
  slot?: PluginSlot;
  tools: OpenClawToolDef[];
  memory: OpenClawMemoryDef | null;
}

/**
 * A fully loaded plugin with its manifest and registrations.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  config: PluginConfig;
  registrations: PluginRegistrations;
}
