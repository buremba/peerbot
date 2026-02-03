import type Redis from "ioredis";
import { OAuthStateStore } from "../oauth/state-store";

/**
 * Context for routing auth completion back to the originating platform.
 */
export interface OAuthPlatformContext {
  platform: string;
  channelId: string; // chatJid for WhatsApp, channel for Slack
  threadId?: string;
}

interface ClaudeOAuthStateData {
  userId: string;
  agentId: string;
  codeVerifier: string;
  context?: OAuthPlatformContext;
}

interface OAuthState extends ClaudeOAuthStateData {
  createdAt: number;
}

/**
 * Store and retrieve Claude OAuth state for CSRF protection and PKCE
 * Pattern: claude:oauth_state:{state}
 * TTL: 5 minutes
 *
 * Wraps generic OAuthStateStore with Claude-specific API
 */
export class ClaudeOAuthStateStore {
  private store: OAuthStateStore<ClaudeOAuthStateData>;

  constructor(redis: Redis) {
    this.store = new OAuthStateStore(
      redis,
      "claude:oauth_state",
      "claude-oauth-state-store"
    );
  }

  /**
   * Create a new OAuth state with PKCE code verifier
   * Returns the state string to use in OAuth flow
   */
  async create(
    userId: string,
    agentId: string,
    codeVerifier: string,
    context?: OAuthPlatformContext
  ): Promise<string> {
    return this.store.create({ userId, agentId, codeVerifier, context });
  }

  /**
   * Validate and consume an OAuth state
   * Returns the state data if valid, null if invalid or expired
   * Deletes the state after retrieval (one-time use)
   */
  async consume(state: string): Promise<OAuthState | null> {
    return this.store.consume(state);
  }
}
