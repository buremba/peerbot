import type {
  AgentMcpConfig,
  GitConfig,
  NetworkConfig,
  NixConfig,
  SessionContext,
} from "@peerbot/core";

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
  threadId: string; // Primary identifier (agentId for API platform)
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
  /** Git repository configuration for workspace initialization */
  gitConfig?: GitConfig;
  /** Per-agent MCP configuration (additive to global MCPs) */
  mcpConfig?: AgentMcpConfig;
  /** Nix environment configuration for agent workspace */
  nixConfig?: NixConfig;
}

/**
 * Compute session key for Redis storage
 * For API platform: just threadId (which equals agentId)
 * For Slack/WhatsApp: channelId:threadId
 */
export function computeSessionKey(session: {
  channelId: string;
  threadId: string;
}): string {
  // For API platform, channelId starts with "api-" and we just use threadId
  if (
    session.channelId.startsWith("api-") ||
    session.channelId === session.threadId
  ) {
    return session.threadId;
  }
  // For other platforms, use channelId:threadId
  return `${session.channelId}:${session.threadId}`;
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
  /** Optional cleanup - not needed for Redis TTL-based stores */
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
    threadId?: string,
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

// ============================================================================
// Utilities
// ============================================================================

/**
 * Generate session key from context
 */
export function generateSessionKey(context: SessionContext): string {
  // Use thread ID as the session key (if in a thread)
  // Otherwise use message ID
  const id = context.threadId || context.messageId || "";

  // If we have a thread ID, use it directly as the session key
  // This ensures consistency across all worker executions in the same thread
  if (context.threadId) {
    return context.threadId;
  }

  // For direct messages (no thread), use the channel and message ID
  return `${context.channelId}-${id}`;
}
