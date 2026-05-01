import { createBuiltinSecretRef, createLogger } from "@lobu/core";
import type { WritableSecretStore } from "../secrets/index.js";

const logger = createLogger("system-env-store");
const KEY_PREFIX = "system-env/";

/**
 * Secret-store-backed system environment variables.
 * Maintains an in-memory cache for synchronous resolution.
 */
export class SystemEnvStore {
  private cache: Map<string, string> = new Map();

  constructor(private readonly secretStore: WritableSecretStore) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.secretStore.get(
        createBuiltinSecretRef(`${KEY_PREFIX}${key}`)
      );
    } catch (error) {
      logger.error("Failed to get env var", { key, error });
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.secretStore.put(`${KEY_PREFIX}${key}`, value);
      this.cache.set(key, value);
      logger.info(`Set system env var: ${key}`);
    } catch (error) {
      logger.error("Failed to set env var", { key, error });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.secretStore.delete(`${KEY_PREFIX}${key}`);
      this.cache.delete(key);
      logger.info(`Deleted system env var: ${key}`);
    } catch (error) {
      logger.error("Failed to delete env var", { key, error });
    }
  }

  async listAll(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    try {
      const entries = await this.secretStore.list(KEY_PREFIX);
      for (const entry of entries) {
        const value = await this.secretStore.get(entry.ref);
        if (value !== null) {
          result[entry.name.slice(KEY_PREFIX.length)] = value;
        }
      }
    } catch (error) {
      logger.error("Failed to list env vars", { error });
    }

    return result;
  }

  resolve(key: string): string | undefined {
    return this.cache.get(key) ?? process.env[key] ?? undefined;
  }

  async refreshCache(): Promise<void> {
    const all = await this.listAll();
    this.cache.clear();
    for (const [key, value] of Object.entries(all)) {
      this.cache.set(key, value);
    }
    logger.debug(`Loaded ${this.cache.size} system env vars into cache`);
  }
}
