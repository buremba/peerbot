/**
 * Shared types for the integration system.
 *
 * OAuth credential management for third-party APIs (GitHub, Google, etc.)
 * is handled by Lobu.
 */

import type { ProviderConfigEntry } from "./provider-config-types";

// Bundled provider registry (config/providers.json)

export interface ProviderRegistryEntry {
  id: string;
  name: string;
  description?: string;
  providers: ProviderConfigEntry[];
}

export interface ProvidersConfigFile {
  providers: ProviderRegistryEntry[];
}
