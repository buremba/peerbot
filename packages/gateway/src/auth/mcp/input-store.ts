import { BaseRedisStore } from "@peerbot/core";
import type { IMessageQueue } from "../../infrastructure/queue";

export interface InputValues {
  [inputId: string]: string;
}

/**
 * Storage for MCP input credentials (PATs, API keys, etc.)
 * Unlike OAuth tokens, these don't expire so we store them without TTL
 */
export class McpInputStore extends BaseRedisStore<InputValues> {
  constructor(queue: IMessageQueue) {
    super({
      redis: queue.getRedisClient(),
      keyPrefix: "mcp:inputs",
      loggerName: "mcp-input-store",
    });
  }

  /**
   * Store input values for a space and MCP server
   * No TTL - these are persistent until explicitly deleted
   */
  async setInputs(
    agentId: string,
    mcpId: string,
    inputs: InputValues
  ): Promise<void> {
    const key = this.buildKey(agentId, mcpId);
    await this.set(key, inputs);
    this.logger.info(`Stored inputs for space ${agentId}, MCP ${mcpId}`);
  }

  /**
   * Retrieve input values for a space and MCP server
   */
  async getInputs(agentId: string, mcpId: string): Promise<InputValues | null> {
    const key = this.buildKey(agentId, mcpId);
    return this.get(key);
  }

  /**
   * Delete input values for a space and MCP server
   */
  async deleteInputs(agentId: string, mcpId: string): Promise<void> {
    const key = this.buildKey(agentId, mcpId);
    await this.delete(key);
    this.logger.info(`Deleted inputs for space ${agentId}, MCP ${mcpId}`);
  }

  /**
   * Check if space has inputs stored for an MCP server
   */
  async has(agentId: string, mcpId: string): Promise<boolean> {
    const values = await this.getInputs(agentId, mcpId);
    return values !== null;
  }
}
