import { createLogger } from "@lobu/core";
import { getOrgId } from "../../../lobu/stores/org-context.js";

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

  get(mcpId: string, agentId?: string): McpTool[] | null {
    const info = this.getServerInfo(mcpId, agentId);
    return info ? info.tools : null;
  }

  set(mcpId: string, tools: McpTool[], agentId?: string): void {
    this.setServerInfo(mcpId, { tools }, agentId);
  }

  getServerInfo(
    mcpId: string,
    agentId?: string
  ): CachedMcpServer | null {
    const key = this.buildKey(mcpId, agentId);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.info;
  }

  setServerInfo(
    mcpId: string,
    info: CachedMcpServer,
    agentId?: string
  ): void {
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

  getInstructions(
    mcpId: string,
    agentId?: string
  ): string | undefined {
    const info = this.getServerInfo(mcpId, agentId);
    return info?.instructions;
  }

  /**
   * Cache keys are org-scoped. The McpToolCache is a process-wide singleton
   * shared by every org, but agentId is NOT globally unique (agents PK is
   * (organization_id, id) and ids are human slugs), so two orgs with the same
   * agentId+mcpId would otherwise collide — letting org A's tool annotations
   * auto-approve org B's destructive tool call. Every get/set runs inside
   * `runWithOrganizationContext`, so we derive the org from that context
   * rather than threading it through every signature (which could be forgotten
   * at a call site).
   */
  private buildKey(mcpId: string, agentId?: string): string {
    const orgId = getOrgId();
    if (agentId) {
      return `mcp:tools:${orgId}:${agentId}:${mcpId}`;
    }
    return `mcp:tools:${orgId}:${mcpId}`;
  }
}
