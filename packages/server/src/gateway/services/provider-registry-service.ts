import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ProviderConfigEntry,
  ProviderRegistryEntry,
  ProvidersConfigFile,
} from "@lobu/core";
import { createLogger } from "@lobu/core";

const logger = createLogger("provider-registry-service");

/**
 * Resolve the path/URL of the bundled providers registry.
 *
 * Tries, first-that-exists:
 *  1. `LOBU_PROVIDER_REGISTRY_PATH` — always wins. `http(s)://` URLs pass
 *     through untouched (loadConfig fetches them).
 *  2. `<cwd>/config/providers.json` — preserves the historical behavior of
 *     invoking the gateway from the monorepo root.
 *  3. Bundle-relative `providers.json` — sits next to `server.bundle.mjs` /
 *     `start-local.bundle.mjs` (also copied into `packages/cli/dist/`).
 *
 * No fuzzy ancestor walk-up: a project subdir resolves to the bundled file,
 * which is the correct default for both published CLIs and `lobu run`.
 */
export function resolveProviderRegistryPath(): string | undefined {
  const explicit = process.env.LOBU_PROVIDER_REGISTRY_PATH?.trim();
  if (explicit) return explicit;

  const cwdPath = path.resolve(process.cwd(), "config/providers.json");
  if (existsSync(cwdPath)) return cwdPath;

  const bundleDir = path.dirname(fileURLToPath(import.meta.url));
  // From the bundled server: dist/server.bundle.mjs → dist/providers.json.
  // From source (tsc dist): dist/gateway/services → walk up to dist, then to
  // the package root where the monorepo config dir is reachable via repo root.
  const bundleSibling = path.join(bundleDir, "providers.json");
  if (existsSync(bundleSibling)) return bundleSibling;

  return undefined;
}

const ENV_SUBSTITUTION_BLOCKLIST = new Set([
  "ENCRYPTION_KEY",
  "DATABASE_URL",
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
