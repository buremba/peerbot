import { readFile } from "node:fs/promises";
import type {
  ProviderConfigEntry,
  ProviderRegistryEntry,
  ProvidersConfigFile,
} from "@lobu/core";
import { createLogger } from "@lobu/core";

const logger = createLogger("provider-registry-service");

const ENV_SUBSTITUTION_BLOCKLIST = new Set([
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  // Kept defense-in-depth: even though the runtime no longer uses Redis, an
  // operator may still set REDIS_PASSWORD in their environment for unrelated
  // tooling and we don't want it surfacing through provider-config substitution.
  "REDIS_PASSWORD",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "SENTRY_DSN",
]);

function isBlockedEnvSubstitution(varName: string): boolean {
  return ENV_SUBSTITUTION_BLOCKLIST.has(varName) || /(^|_)PASSWORD$/i.test(varName);
}

export class ProviderRegistryService {
  private configUrl?: string;
  private loaded?: ProvidersConfigFile;
  private rawLoaded?: ProvidersConfigFile;
  private loadAttempted = false;

  constructor(
    configUrl?: string,
    preloadedProviders?: ProviderRegistryEntry[]
  ) {
    this.configUrl = configUrl;
    if (preloadedProviders) {
      const config: ProvidersConfigFile = { providers: preloadedProviders };
      this.loaded = config;
      this.rawLoaded = config;
      logger.info(
        `Loaded ${preloadedProviders.length} bundled provider(s) (injected)`
      );
    }
  }

  async getProviderConfigs(): Promise<Record<string, ProviderConfigEntry>> {
    const config = await this.loadConfig();
    if (!config) return {};
    const result: Record<string, ProviderConfigEntry> = {};
    for (const entry of config.providers) {
      for (const provider of entry.providers || []) {
        result[entry.id] = provider;
      }
    }
    return result;
  }

  async getRawProviderEntries(): Promise<ProviderRegistryEntry[]> {
    await this.loadConfig();
    return this.rawLoaded?.providers || [];
  }

  reload(newUrl?: string): void {
    this.loaded = undefined;
    this.rawLoaded = undefined;
    this.loadAttempted = false;
    if (newUrl !== undefined) {
      this.configUrl = newUrl;
    }
  }

  private async loadConfig(): Promise<ProvidersConfigFile | null> {
    if (this.loaded) return this.loaded;
    if (this.loadAttempted || !this.configUrl) return null;
    this.loadAttempted = true;
    try {
      let raw: string;
      if (
        this.configUrl.startsWith("http://") ||
        this.configUrl.startsWith("https://")
      ) {
        const response = await fetch(this.configUrl);
        if (!response.ok) {
          logger.error(`Failed to fetch providers config: ${response.status}`);
          return null;
        }
        raw = await response.text();
      } else {
        raw = await readFile(this.configUrl, "utf-8");
      }
      const resolved = resolveProviderRegistryFromRaw(raw);
      if (!resolved) return null;
      this.rawLoaded = resolved.raw;
      this.loaded = resolved.resolved;
      logger.info(`Loaded ${this.loaded.providers.length} bundled provider(s)`);
      return this.loaded;
    } catch (error) {
      logger.debug("Providers config not available", { error });
      return null;
    }
  }
}

export function resolveProviderRegistryFromRaw(raw: string): {
  raw: ProvidersConfigFile;
  resolved: ProvidersConfigFile;
} | null {
  let rawParsed: ProvidersConfigFile;
  try {
    rawParsed = JSON.parse(raw) as ProvidersConfigFile;
  } catch {
    logger.error("Invalid providers JSON");
    return null;
  }

  const substituted = raw.replace(/\$\{env:([^}]+)\}/g, (_match, varName) => {
    if (isBlockedEnvSubstitution(varName)) {
      logger.warn(`Blocked env substitution for sensitive var: ${varName}`);
      return "";
    }
    return process.env[varName] || "";
  });

  let parsed: ProvidersConfigFile;
  try {
    parsed = JSON.parse(substituted) as ProvidersConfigFile;
  } catch {
    logger.error("Invalid providers JSON after env substitution");
    return null;
  }

  if (!Array.isArray(parsed.providers)) {
    logger.error("Invalid providers config: missing 'providers' array");
    return null;
  }

  return { raw: rawParsed, resolved: parsed };
}
