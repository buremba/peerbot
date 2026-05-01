import type { AgentMcpConfig, NetworkConfig, NixConfig } from "@lobu/core";

/**
 * Platform-agnostic session types and utilities
 * These types are used by all chat platforms for session tracking
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Thread session data structure
 * Tracks the state of a conversation thread across any platform
 */
export interface ThreadSession {
  conversationId: string; // Primary identifier (agentId for API platform)
  channelId: string;
  userId: string;
  threadCreator?: string; // Track the original thread creator
  jobName?: string;
  lastActivity: number;
  createdAt: number;
  botResponseId?: string; // Bot's response message ID for updates
  turnCount?: number; // Track conversation turns to prevent infinite loops
  status?: string; // Session status (created, active, completed, error)
  // API session parameters
  workingDirectory?: string;
  provider?: string;
  /** Model to use for the agent (e.g., claude-sonnet-4-20250514) */
  model?: string;
  /** Per-agent network configuration for sandbox isolation */
  networkConfig?: NetworkConfig;
  /** Per-agent MCP configuration (additive to global MCPs) */
  mcpConfig?: AgentMcpConfig;
  /** Nix environment configuration for agent workspace */
  nixConfig?: NixConfig;
  /** Original agent ID (before composite session key generation) */
  agentId?: string;
  /** Process without persisting history */
  dryRun?: boolean;
  /** Internal automation intent for one-shot system sessions. */
  intent?: { kind: "watcher_run"; runId: number; watcherId: number };
  /**
   * True when the session was created without a caller-supplied agentId and
   * the gateway auto-provisioned both the agent and its settings. Only
   * ephemeral sessions should have their settings torn down on DELETE —
   * tearing down a shared/named agent's settings corrupts every other
   * session that reuses it.
   */
  isEphemeral?: boolean;
}

/**
 * Compute session key for the session store.
 * For API platform: just conversationId (which equals agentId)
 * For Slack/WhatsApp: channelId:conversationId
 */
export function computeSessionKey(session: {
  channelId: string;
  conversationId: string;
}): string {
  // For API platform, channelId starts with "api-" or "api_" and we just use conversationId
  if (
    session.channelId.startsWith("api-") ||
    session.channelId.startsWith("api_") ||
    session.channelId === session.conversationId
  ) {
    return session.conversationId;
  }
  // For other platforms, use channelId:conversationId
  return `${session.channelId}:${session.conversationId}`;
}

/**
 * Session store interface
 * Platform adapters use this to store and retrieve session data
 */
export interface SessionStore {
  get(sessionKey: string): Promise<ThreadSession | null>;
  set(sessionKey: string, session: ThreadSession): Promise<void>;
  delete(sessionKey: string): Promise<void>;
  getByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null>;
  /** Optional cleanup; only needed for stores without intrinsic TTL. */
  cleanup?(ttl: number): Promise<number>;
}

/**
 * Session manager interface
 * Provides high-level session management operations
 */
export interface ISessionManager {
  createSession(
    channelId: string,
    userId: string,
    conversationId?: string,
    threadCreator?: string
  ): Promise<ThreadSession>;
  getSession(sessionKey: string): Promise<ThreadSession | null>;
  findSessionByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null>;
  updateSession(
    sessionKey: string,
    updates: Partial<ThreadSession>
  ): Promise<void>;
  setSession(session: ThreadSession): Promise<void>;
  deleteSession(sessionKey: string): Promise<void>;
  validateThreadOwnership(
    channelId: string,
    threadTs: string,
    userId: string
  ): Promise<{ allowed: boolean; owner?: string }>;
  touchSession(sessionKey: string): Promise<void>;
  cleanupExpired(ttl: number): Promise<number>;
}
