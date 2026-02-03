import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { OAuthStateStore as BaseOAuthStateStore } from "../oauth/state-store";

interface McpOAuthStateData {
  userId: string;
  agentId: string;
  mcpId: string;
  nonce: string;
  redirectPath?: string;
}

interface OAuthStateData extends McpOAuthStateData {
  createdAt: number;
}

/**
 * Secure storage for OAuth state parameters to prevent CSRF attacks
 * States expire after 5 minutes
 *
 * Wraps generic OAuthStateStore with MCP-specific API
 */
export class McpOAuthStateStore {
  private store: BaseOAuthStateStore<McpOAuthStateData>;

  constructor(redis: Redis) {
    this.store = new BaseOAuthStateStore(
      redis,
      "mcp:oauth:state",
      "mcp-oauth-state"
    );
  }

  /**
   * Generate a secure state parameter and store the associated data
   * Returns the state string to be used in OAuth redirect
   */
  async create(data: Omit<McpOAuthStateData, "nonce">): Promise<string> {
    const stateData: McpOAuthStateData = {
      ...data,
      nonce: randomBytes(16).toString("hex"),
    };

    return this.store.create(stateData);
  }

  /**
   * Retrieve and validate state data
   * Automatically deletes the state after retrieval (one-time use)
   */
  async consume(state: string): Promise<OAuthStateData | null> {
    return this.store.consume(state);
  }
}
