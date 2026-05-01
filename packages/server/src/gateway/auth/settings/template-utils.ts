import type { AgentSettings } from "./index.js";

function cloneSettingValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Fields that should NOT be copied from a template agent to a derived
 * sandbox. Everything else on `AgentSettings` flows through by default, so
 * adding a new field doesn't require editing this file.
 *
 * - `updatedAt`: set fresh on save.
 * - `templateAgentId`: the derived agent tracks its own template pointer.
 * - `mcpInstallNotified`: per-agent UI state; not a config value.
 */
const NON_TEMPLATED_KEYS = new Set<keyof AgentSettings>([
  "updatedAt",
  "templateAgentId",
  "mcpInstallNotified",
]);

export function buildDefaultSettingsFromSource(
  source: AgentSettings | null
): Omit<AgentSettings, "updatedAt"> {
  if (!source) return {};

  const defaults: Partial<AgentSettings> = {};
  for (const key of Object.keys(source) as Array<keyof AgentSettings>) {
    if (NON_TEMPLATED_KEYS.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    // JSON deep-clone is fine — AgentSettings values are plain data.
    (defaults as Record<string, unknown>)[key] = cloneSettingValue(value);
  }
  return defaults as Omit<AgentSettings, "updatedAt">;
}
