import { BaseCredentialStore } from "@peerbot/core";
import type Redis from "ioredis";

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: number; // Unix timestamp in milliseconds
  scopes: string[];
}

/**
 * Store and retrieve Claude OAuth credentials from Redis
 * Pattern: claude:credential:{agentId}
 */
export class ClaudeCredentialStore extends BaseCredentialStore<ClaudeCredentials> {
  constructor(redis: Redis) {
    super({
      redis,
      keyPrefix: "claude:credential",
      loggerName: "claude-credential-store",
    });
  }

  /**
   * Store Claude credentials for a space
   */
  async setCredentials(
    agentId: string,
    credentials: ClaudeCredentials
  ): Promise<void> {
    const key = this.buildKey(agentId);
    await this.set(key, credentials);

    this.logger.info(`Stored Claude credentials for space ${agentId}`, {
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      scopes: credentials.scopes,
    });
  }

  /**
   * Get Claude credentials for a space
   * Returns null if not found or if credentials are missing required fields
   */
  async getCredentials(agentId: string): Promise<ClaudeCredentials | null> {
    const key = this.buildKey(agentId);
    const credentials = await this.get(key);

    if (!credentials) {
      this.logger.debug(`No Claude credentials found for space ${agentId}`);
    }

    return credentials;
  }

  /**
   * Delete Claude credentials for a space
   */
  async deleteCredentials(agentId: string): Promise<void> {
    const key = this.buildKey(agentId);
    await this.delete(key);
    this.logger.info(`Deleted Claude credentials for space ${agentId}`);
  }

  /**
   * Check if space has Claude credentials
   */
  async hasCredentials(agentId: string): Promise<boolean> {
    const key = this.buildKey(agentId);
    return this.exists(key);
  }
}
