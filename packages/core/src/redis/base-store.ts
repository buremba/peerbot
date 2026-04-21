import type Redis from "ioredis";
import { createLogger, type Logger } from "../logger";
import { safeJsonParse, safeJsonStringify } from "../utils/json";

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RedisStoreConfig {
  redis: Redis;
  keyPrefix: string;
  loggerName: string;
}

/**
 * Base class for all Redis-backed stores
 * Provides common CRUD operations with JSON serialization
 */
export abstract class BaseRedisStore<T> {
  protected logger: Logger;
  protected redis: Redis;
  protected keyPrefix: string;

  constructor(config: RedisStoreConfig) {
    this.redis = config.redis;
    this.keyPrefix = config.keyPrefix;
    this.logger = createLogger(config.loggerName);
  }

  /**
   * Build Redis key from parts
   */
  protected buildKey(...parts: string[]): string {
    return [this.keyPrefix, ...parts].join(":");
  }

  /**
   * Get value from Redis
   * Returns null if not found or validation fails
   */
  protected async get(key: string): Promise<T | null> {
    try {
      const data = await this.redis.get(key);
      if (!data) {
        return null;
      }

      const value = this.deserialize(data);

      // Validate after deserialization
      if (!this.validate(value)) {
        this.logger.warn("Invalid data after deserialization", { key });
        return null;
      }

      return value;
    } catch (error) {
      this.logger.error("Failed to get from Redis", {
        error: errMsg(error),
        key,
      });
      return null;
    }
  }

  /**
   * Set value in Redis
   */
  protected async set(
    key: string,
    value: T,
    ttlSeconds?: number
  ): Promise<void> {
    try {
      const data = this.serialize(value);
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, data);
      } else {
        await this.redis.set(key, data);
      }
    } catch (error) {
      this.logger.error("Failed to set in Redis", {
        error: errMsg(error),
        key,
      });
      throw error;
    }
  }

  /**
   * Delete value from Redis
   */
  protected async delete(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.error("Failed to delete from Redis", {
        error: errMsg(error),
        key,
      });
    }
  }

  /**
   * Scan for all keys matching a prefix (cursor-based, production-safe).
   * Returns full key strings matching `{prefix}*`.
   */
  protected async scanByPrefix(prefix: string): Promise<string[]> {
    const results: string[] = [];
    let cursor = "0";
    try {
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          100
        );
        cursor = nextCursor;
        results.push(...keys);
      } while (cursor !== "0");
    } catch (error) {
      this.logger.error("Failed to scan by prefix", {
        error: errMsg(error),
        prefix,
      });
    }
    return results;
  }

  /**
   * Check if key exists in Redis
   */
  protected async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      this.logger.error("Failed to check existence in Redis", {
        error: errMsg(error),
        key,
      });
      return false;
    }
  }

  /**
   * Serialize value to string
   * Override for custom serialization
   */
  protected serialize(value: T): string {
    const result = safeJsonStringify(value);
    if (result === null) {
      throw new Error("Failed to serialize value to JSON");
    }
    return result;
  }

  /**
   * Deserialize string to value
   * Override for custom deserialization
   */
  protected deserialize(data: string): T {
    const result = safeJsonParse<T>(data);
    if (result === null) {
      throw new Error("Failed to deserialize JSON data");
    }
    return result;
  }

  /**
   * Validate value after deserialization
   * Override to add custom validation logic
   * Return false to reject invalid data
   */
  protected validate(_value: T): boolean {
    return true;
  }
}
