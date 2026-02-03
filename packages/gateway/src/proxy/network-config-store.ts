import { createLogger, type NetworkConfig } from "@peerbot/core";
import { resolveNetworkConfig } from "../config/network-allowlist";

const logger = createLogger("network-config-store");

/**
 * Resolved network configuration with both allowed and denied domains
 */
export interface ResolvedNetworkConfig {
  allowedDomains: string[];
  deniedDomains: string[];
}

/**
 * Store for per-deployment network configurations.
 *
 * When a worker is deployed with custom networkConfig, it's stored here.
 * The HTTP proxy looks up configs by deploymentName to apply per-worker rules.
 *
 * Storage is in-memory with optional Redis backing for multi-instance deployments.
 */
export class NetworkConfigStore {
  private configs: Map<string, ResolvedNetworkConfig> = new Map();
  private redisClient: any = null;
  private readonly REDIS_PREFIX = "peerbot:network:";
  private readonly REDIS_TTL = 24 * 60 * 60; // 24 hours

  /**
   * Initialize with optional Redis client for distributed storage
   */
  async initialize(redisClient?: any): Promise<void> {
    this.redisClient = redisClient;
    if (redisClient) {
      logger.info("NetworkConfigStore initialized with Redis backing");
    } else {
      logger.info("NetworkConfigStore initialized (in-memory only)");
    }
  }

  /**
   * Store network configuration for a deployment.
   * Resolves the config with global defaults before storing.
   *
   * @param deploymentName - Unique deployment identifier
   * @param networkConfig - Per-agent network configuration (optional)
   */
  async set(
    deploymentName: string,
    networkConfig?: NetworkConfig
  ): Promise<void> {
    // Resolve with global defaults
    const resolved = resolveNetworkConfig(networkConfig);

    // Store in memory
    this.configs.set(deploymentName, resolved);

    // Store in Redis if available
    if (this.redisClient) {
      try {
        const key = `${this.REDIS_PREFIX}${deploymentName}`;
        await this.redisClient.set(
          key,
          JSON.stringify(resolved),
          "EX",
          this.REDIS_TTL
        );
      } catch (error) {
        logger.warn(
          `Failed to store network config in Redis for ${deploymentName}:`,
          error
        );
      }
    }

    logger.debug(
      `Stored network config for ${deploymentName}: allowed=${resolved.allowedDomains.length}, denied=${resolved.deniedDomains.length}`
    );
  }

  /**
   * Get network configuration for a deployment.
   * Returns global defaults if no custom config is found.
   *
   * @param deploymentName - Unique deployment identifier
   * @returns Resolved network configuration
   */
  async get(deploymentName: string): Promise<ResolvedNetworkConfig> {
    // Check memory first
    const cached = this.configs.get(deploymentName);
    if (cached) {
      return cached;
    }

    // Check Redis if available
    if (this.redisClient) {
      try {
        const key = `${this.REDIS_PREFIX}${deploymentName}`;
        const data = await this.redisClient.get(key);
        if (data) {
          const resolved = JSON.parse(data) as ResolvedNetworkConfig;
          // Cache in memory
          this.configs.set(deploymentName, resolved);
          return resolved;
        }
      } catch (error) {
        logger.warn(
          `Failed to get network config from Redis for ${deploymentName}:`,
          error
        );
      }
    }

    // Return global defaults if no custom config found
    return resolveNetworkConfig(undefined);
  }

  /**
   * Remove network configuration for a deployment.
   *
   * @param deploymentName - Unique deployment identifier
   */
  async delete(deploymentName: string): Promise<void> {
    this.configs.delete(deploymentName);

    if (this.redisClient) {
      try {
        const key = `${this.REDIS_PREFIX}${deploymentName}`;
        await this.redisClient.del(key);
      } catch (error) {
        logger.warn(
          `Failed to delete network config from Redis for ${deploymentName}:`,
          error
        );
      }
    }

    logger.debug(`Deleted network config for ${deploymentName}`);
  }

  /**
   * Check if a deployment has custom network configuration.
   *
   * @param deploymentName - Unique deployment identifier
   * @returns True if custom config exists
   */
  has(deploymentName: string): boolean {
    return this.configs.has(deploymentName);
  }

  /**
   * Get statistics about stored configs
   */
  getStats(): { configCount: number } {
    return {
      configCount: this.configs.size,
    };
  }

  /**
   * Clear all stored configurations (for testing)
   */
  clear(): void {
    this.configs.clear();
  }
}

// Singleton instance
export const networkConfigStore = new NetworkConfigStore();
