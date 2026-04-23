import { randomBytes } from "node:crypto";
import {
  createLogger,
  getdelJsonValue,
  setJsonValue,
  type Logger,
} from "@lobu/core";
import type Redis from "ioredis";

/**
 * Generic OAuth state store for CSRF protection
 * Pattern: {keyPrefix}:{state}
 * TTL: 5 minutes
 */
export class OAuthStateStore<T extends object> {
  private static readonly TTL_SECONDS = 5 * 60; // 5 minutes
  protected logger: Logger;

  constructor(
    private redis: Redis,
    private keyPrefix: string,
    loggerName: string
  ) {
    this.logger = createLogger(loggerName);
  }

  /**
   * Create a new OAuth state with data
   * Returns the state string to use in OAuth flow
   */
  async create(data: T): Promise<string> {
    const state = this.generateState();
    const key = this.getKey(state);

    const stateData = {
      ...data,
      createdAt: Date.now(),
    };

    await setJsonValue(this.redis, key, stateData, OAuthStateStore.TTL_SECONDS);

    const userId =
      typeof (data as { userId?: unknown }).userId === "string"
        ? (data as { userId: string }).userId
        : undefined;
    this.logger.info(
      userId ? `Created OAuth state for user ${userId}` : "Created OAuth state",
      { state }
    );
    return state;
  }

  /**
   * Validate and consume an OAuth state
   * Returns the state data if valid, null if invalid or expired
   * Deletes the state after retrieval (one-time use)
   */
  async consume(state: string): Promise<(T & { createdAt: number }) | null> {
    const key = this.getKey(state);

    // Get and delete in one operation
    const stateData = await getdelJsonValue<T & { createdAt: number }>(
      this.redis,
      key
    );

    if (!stateData) {
      this.logger.warn(`Invalid or expired OAuth state: ${state}`);
      return null;
    }

    const stateDataWithUser = stateData as unknown as { userId?: unknown };
    const userId =
      typeof stateDataWithUser.userId === "string"
        ? stateDataWithUser.userId
        : undefined;
    this.logger.info(
      userId
        ? `Consumed OAuth state for user ${userId}`
        : "Consumed OAuth state",
      { state }
    );
    return stateData;
  }

  /**
   * Generate a cryptographically secure random state string
   */
  private generateState(): string {
    return randomBytes(32).toString("base64url");
  }

  private getKey(state: string): string {
    return `${this.keyPrefix}:${state}`;
  }
}

// ============================================================================
// Provider OAuth State Types and Factory
// ============================================================================

/**
 * Context for routing auth completion back to the originating platform.
 */
export interface OAuthPlatformContext {
  platform: string;
  channelId: string; // chatJid for WhatsApp, channel for Slack
  conversationId?: string;
}

export interface ProviderOAuthStateData {
  userId: string;
  agentId: string;
  codeVerifier: string;
  context?: OAuthPlatformContext;
}

/**
 * Create a provider OAuth state store for PKCE flow
 */
export function createOAuthStateStore(
  providerId: string,
  redis: Redis
): OAuthStateStore<ProviderOAuthStateData> {
  return new OAuthStateStore(
    redis,
    `${providerId}:oauth_state`,
    `${providerId}-oauth-state`
  );
}

interface SlackInstallStateData {
  redirectUri: string;
}

export function createSlackInstallStateStore(
  redis: Redis
): OAuthStateStore<SlackInstallStateData> {
  return new OAuthStateStore(redis, "slack:oauth:state", "slack-install-state");
}

export type ProviderOAuthStateStore = OAuthStateStore<ProviderOAuthStateData>;
