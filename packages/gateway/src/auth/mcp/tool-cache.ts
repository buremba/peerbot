import { createLogger } from "@lobu/core";

const logger = createLogger("mcp-tool-cache");

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const CACHE_TTL_SECONDS = 300; // 5 minutes

export class McpToolCache {
  constructor(private readonly redisClient: any) {}

  async get(mcpId: string, agentId?: string): Promise<McpTool[] | null> {
    const key = this.buildKey(mcpId, agentId);
    try {
      const cached = await this.redisClient.get(key);
      if (cached) {
        return JSON.parse(cached) as McpTool[];
      }
      return null;
    } catch (error) {
      logger.error("Failed to read tool cache", { key, error });
      return null;
    }
  }

  async set(mcpId: string, tools: McpTool[], agentId?: string): Promise<void> {
    const key = this.buildKey(mcpId, agentId);
    try {
      await this.redisClient.set(
        key,
        JSON.stringify(tools),
        "EX",
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      logger.error("Failed to write tool cache", { key, error });
    }
  }

  private buildKey(mcpId: string, agentId?: string): string {
    if (agentId) {
      return `mcp:tools:${agentId}:${mcpId}`;
    }
    return `mcp:tools:${mcpId}`;
  }
}
