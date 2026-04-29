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

export interface CachedMcpServer {
  tools: McpTool[];
  instructions?: string;
}

/**
 * In-memory MCP tool cache. Per-gateway-process; a miss recomputes by hitting
 * the MCP server's `tools/list` endpoint. The 5-minute TTL is short enough
 * that a gateway restart (or a multi-replica fan-out) doesn't serve stale
 * tool metadata. No cross-replica coherence problem since every replica
 * probes upstream itself on miss.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  info: CachedMcpServer;
  expiresAt: number;
}

export class McpToolCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(mcpId: string, agentId?: string): Promise<McpTool[] | null> {
    const info = await this.getServerInfo(mcpId, agentId);
    return info ? info.tools : null;
  }

  async set(mcpId: string, tools: McpTool[], agentId?: string): Promise<void> {
    await this.setServerInfo(mcpId, { tools }, agentId);
  }

  async getServerInfo(
    mcpId: string,
    agentId?: string
  ): Promise<CachedMcpServer | null> {
    const key = this.buildKey(mcpId, agentId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.info;
  }

  async setServerInfo(
    mcpId: string,
    info: CachedMcpServer,
    agentId?: string
  ): Promise<void> {
    const key = this.buildKey(mcpId, agentId);
    try {
      this.entries.set(key, {
        info,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    } catch (error) {
      logger.error("Failed to write tool cache", { key, error });
    }
  }

  async getInstructions(
    mcpId: string,
    agentId?: string
  ): Promise<string | undefined> {
    const info = await this.getServerInfo(mcpId, agentId);
    return info?.instructions;
  }

  private buildKey(mcpId: string, agentId?: string): string {
    if (agentId) {
      return `mcp:tools:${agentId}:${mcpId}`;
    }
    return `mcp:tools:${mcpId}`;
  }
}
