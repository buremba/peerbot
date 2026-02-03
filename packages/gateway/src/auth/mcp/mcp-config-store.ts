import { type AgentMcpConfig, createLogger } from "@peerbot/core";

const logger = createLogger("mcp-config-store");

/**
 * Store for per-deployment MCP configurations.
 *
 * When a worker is deployed with custom mcpConfig, it's stored here.
 * The session-context endpoint looks up configs by deploymentName.
 *
 * Storage is in-memory with optional Redis backing for multi-instance deployments.
 */
export class McpConfigStore {
  private configs: Map<string, AgentMcpConfig> = new Map();
  private redisClient: any = null;
  private readonly REDIS_PREFIX = "peerbot:mcp:config:";
  private readonly REDIS_TTL = 24 * 60 * 60; // 24 hours

  /**
   * Initialize with optional Redis client for distributed storage
   */
  async initialize(redisClient?: any): Promise<void> {
    this.redisClient = redisClient;
    if (redisClient) {
      logger.info("McpConfigStore initialized with Redis backing");
    } else {
      logger.info("McpConfigStore initialized (in-memory only)");
    }
  }

  /**
   * Store MCP configuration for a deployment.
   *
   * @param deploymentName - Unique deployment identifier
   * @param mcpConfig - Per-agent MCP configuration
   */
  async set(deploymentName: string, mcpConfig: AgentMcpConfig): Promise<void> {
    // Store in memory
    this.configs.set(deploymentName, mcpConfig);

    // Store in Redis if available
    if (this.redisClient) {
      try {
        const key = `${this.REDIS_PREFIX}${deploymentName}`;
        await this.redisClient.set(
          key,
          JSON.stringify(mcpConfig),
          "EX",
          this.REDIS_TTL
        );
      } catch (error) {
        logger.warn(
          `Failed to store MCP config in Redis for ${deploymentName}:`,
          error
        );
      }
    }

    logger.debug(
      `Stored MCP config for ${deploymentName}: ${Object.keys(mcpConfig.mcpServers).length} servers`
    );
  }

  /**
   * Get MCP configuration for a deployment.
   *
   * @param deploymentName - Unique deployment identifier
   * @returns MCP configuration or null if not found
   */
  async get(deploymentName: string): Promise<AgentMcpConfig | null> {
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
          const config = JSON.parse(data) as AgentMcpConfig;
          // Cache in memory
          this.configs.set(deploymentName, config);
          return config;
        }
      } catch (error) {
        logger.warn(
          `Failed to get MCP config from Redis for ${deploymentName}:`,
          error
        );
      }
    }

    return null;
  }

  /**
   * Remove MCP configuration for a deployment.
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
          `Failed to delete MCP config from Redis for ${deploymentName}:`,
          error
        );
      }
    }

    logger.debug(`Deleted MCP config for ${deploymentName}`);
  }

  /**
   * Check if a deployment has custom MCP configuration.
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
export const mcpConfigStore = new McpConfigStore();
