/**
 * OpenClaw Plugin System Types
 *
 * Defines the interfaces for loading, configuring, and bridging OpenClaw plugins
 * into Lobu's architecture. Supports all four plugin slot types:
 * - tool: Agent capabilities (tools available during turns)
 * - memory: Context recall/save backends (exclusive slot - one active at a time)
 * - channel: Messaging platform integrations
 * - provider: AI model inference backends
 */

// ============================================================================
// Plugin Configuration (stored in AgentSettings)
// ============================================================================

/** Slot types supported by OpenClaw plugins */
export type PluginSlot = "tool" | "memory" | "channel" | "provider";

/** Individual plugin configuration in agent settings */
export interface PluginConfig {
  /** npm package name or local path (e.g., "@openclaw/msteams", "./extensions/matrix") */
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
  channels?: string[];
  providers?: string[];
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

/** Channel plugin outbound interface */
export interface OpenClawChannelOutbound {
  deliveryMode: "direct" | "buffered";
  sendText: (params: {
    text: string;
    [key: string]: unknown;
  }) => Promise<{ ok: boolean }>;
  sendMedia?: (params: { [key: string]: unknown }) => Promise<{ ok: boolean }>;
}

/** Channel plugin as registered by OpenClaw plugins */
export interface OpenClawChannelDef {
  id: string;
  meta: {
    id: string;
    label: string;
    docsPath?: string;
    blurb?: string;
    aliases?: string[];
  };
  capabilities: {
    chatTypes: Array<"direct" | "group" | "thread" | "channel">;
    reactions?: boolean;
    threads?: boolean;
    media?: boolean;
  };
  config: {
    listAccountIds: (cfg: unknown) => string[];
    resolveAccount: (cfg: unknown, accountId?: string) => unknown;
  };
  outbound: OpenClawChannelOutbound;
  startAccount?: (accountId: string) => Promise<void>;
  stopAccount?: (accountId: string) => Promise<void>;
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

/** Provider plugin interface */
export interface OpenClawProviderDef {
  id: string;
  models?: Array<{
    id: string;
    name: string;
    api?: string;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  stream?: (messages: unknown[], options?: unknown) => AsyncIterable<unknown>;
  validateAuth?: () => Promise<boolean>;
}

/** Service registration (background services, HTTP endpoints) */
export interface OpenClawServiceDef {
  type: "http" | "background";
  path?: string;
  handler?: (req: unknown, res: unknown) => Promise<void>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

/**
 * Collected registrations from an OpenClaw plugin.
 * The plugin loader calls register(api) and captures all registrations here.
 */
export interface PluginRegistrations {
  id: string;
  slot?: PluginSlot;
  tools: OpenClawToolDef[];
  channels: OpenClawChannelDef[];
  memory: OpenClawMemoryDef | null;
  provider: OpenClawProviderDef | null;
  services: OpenClawServiceDef[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  gatewayMethods: Map<string, (...args: unknown[]) => unknown>;
}

/**
 * A fully loaded plugin with its manifest and registrations.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  config: PluginConfig;
  registrations: PluginRegistrations;
}
