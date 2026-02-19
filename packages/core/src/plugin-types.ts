/**
 * OpenClaw plugin types for Lobu.
 *
 * Supports loading existing OpenClaw community plugins (tool and provider).
 * Memory and channel plugins are deferred to a future PR.
 */

/** Supported plugin slots */
export type PluginSlot = "tool" | "provider";

/** Configuration for a single plugin */
export interface PluginConfig {
  /** npm package name or local path (e.g., "@openclaw/voice-call", "./my-plugin") */
  source: string;
  /** Which slot this plugin fills */
  slot: PluginSlot;
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
}

/** Top-level plugins configuration stored in agent settings */
export interface PluginsConfig {
  plugins: PluginConfig[];
}

/** Metadata about a loaded plugin */
export interface PluginManifest {
  /** Source identifier (package name or path) */
  source: string;
  /** Plugin slot */
  slot: PluginSlot;
  /** Display name (from package or source) */
  name: string;
}

/**
 * A provider registration captured from pi.registerProvider().
 * The config is opaque here — it's passed directly to ModelRegistry.registerProvider().
 */
export interface ProviderRegistration {
  /** Provider name (e.g., "corporate-ai", "my-proxy") */
  name: string;
  /** Provider config (ProviderConfigInput from pi-coding-agent) */
  config: Record<string, unknown>;
}
