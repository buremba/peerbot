/**
 * OpenClaw plugin types for Lobu.
 *
 * `PluginSlot` / `PluginConfig` / `PluginsConfig` are re-exported from the
 * AgentSettings TypeBox schema (./contracts/agent-settings.ts) — the single
 * source, so `AgentSettings.pluginsConfig` and the public `PluginsConfig`
 * can't drift. The hand-written interfaces that used to live here were
 * structurally identical but a separate definition surface.
 *
 * `PluginManifest` and `ProviderRegistration` are NOT in the agent-settings
 * schema (they're runtime/catalog concerns, not stored agent config) — they
 * stay defined here.
 */

// Re-export the stored plugin shapes from the schema (single source).
export type {
  PluginConfig,
  PluginSlot,
  PluginsConfig,
} from "./contracts/agent-settings";

/** Metadata about a loaded plugin */
export interface PluginManifest {
  /** Source identifier (package name or path) */
  source: string;
  /** Plugin slot */
  slot: import("./contracts/agent-settings").PluginSlot;
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
