#!/usr/bin/env bun

import { createLogger } from "@lobu/core";
import type { ConversationStateStore } from "../connections/conversation-state-store.js";
import {
  computeSessionKey,
  type ISessionManager,
  type SessionStore,
  type ThreadSession,
} from "../session.js";

const logger = createLogger("session-manager");

/**
 * Session storage backed by the shared conversation state layer.
 * Thread sessions and chat history share the same StateAdapter-backed
 * storage abstraction.
 */
export class StateAdapterSessionStore implements SessionStore {
  constructor(private readonly conversations: ConversationStateStore) {}

  async get(sessionKey: string): Promise<ThreadSession | null> {
    try {
      return await this.conversations.getSession(sessionKey);
    } catch (error) {
      logger.error(`Failed to get session ${sessionKey}:`, error);
      return null;
    }
  }

  async set(sessionKey: string, session: ThreadSession): Promise<void> {
    await this.conversations.setSession(sessionKey, session);
    logger.debug(`Stored session ${sessionKey}`);
  }

  async delete(sessionKey: string): Promise<void> {
    await this.conversations.deleteSession(sessionKey);
    logger.debug(`Deleted session ${sessionKey}`);
  }

  async getByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    try {
      return await this.conversations.getSessionByThread(channelId, threadTs);
    } catch (error) {
      logger.error(
        `Failed to get session by thread ${channelId}:${threadTs}:`,
        error
      );
      return null;
    }
  }

  /** Optional cleanup - state adapter TTL handles this automatically */
  async cleanup?(): Promise<number> {
    logger.debug("StateAdapter TTL handles automatic cleanup");
    return 0;
  }
}

/**
 * Session manager that abstracts session storage
 * Provides thread ownership validation and session lifecycle management
 */
export class SessionManager implements ISessionManager {
  private store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  /**
   * Create a new session
   */
  async createSession(
    channelId: string,
    userId: string,
    conversationId?: string,
    threadCreator?: string
  ): Promise<ThreadSession> {
    const effectiveConversationId = conversationId || userId;
    const session: ThreadSession = {
      conversationId: effectiveConversationId,
      channelId,
      userId,
      threadCreator: threadCreator || userId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    const sessionKey = computeSessionKey(session);
    await this.store.set(sessionKey, session);
    return session;
  }

  /**
   * Update session
   */
  async updateSession(
    sessionKey: string,
    updates: Partial<ThreadSession>
  ): Promise<void> {
    const session = await this.getSession(sessionKey);
    if (session) {
      const updated = { ...session, ...updates };
      await this.store.set(sessionKey, updated);
    }
  }

  /**
   * Get session by session key
   */
  async getSession(sessionKey: string): Promise<ThreadSession | null> {
    return await this.store.get(sessionKey);
  }

  /**
   * Create or update a session
   */
  async setSession(session: ThreadSession): Promise<void> {
    const sessionKey = computeSessionKey(session);
    await this.store.set(sessionKey, session);
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionKey: string): Promise<void> {
    await this.store.delete(sessionKey);
  }

  /**
   * Find session by thread
   */
  async findSessionByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    return await this.store.getByThread(channelId, threadTs);
  }

  /**
   * Validate thread ownership
   * Returns true if the user is the thread creator or no session exists
   */
  async validateThreadOwnership(
    channelId: string,
    threadTs: string,
    userId: string
  ): Promise<{ allowed: boolean; owner?: string }> {
    const session = await this.findSessionByThread(channelId, threadTs);

    if (!session) {
      return { allowed: true }; // No session, allow creation
    }

    if (!session.threadCreator) {
      return { allowed: true }; // No owner set, allow
    }

    if (session.threadCreator === userId) {
      return { allowed: true, owner: session.threadCreator };
    }

    return { allowed: false, owner: session.threadCreator };
  }

  /**
   * Update session activity timestamp
   */
  async touchSession(sessionKey: string): Promise<void> {
    const session = await this.getSession(sessionKey);
    if (session) {
      session.lastActivity = Date.now();
      await this.setSession(session);
    }
  }

  /**
   * Cleanup expired sessions (for in-memory stores)
   * Note: state-adapter-backed stores handle this automatically via TTL
   */
  async cleanupExpired(ttl: number): Promise<number> {
    return (await this.store.cleanup?.(ttl)) || 0;
  }
}
