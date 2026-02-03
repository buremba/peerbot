#!/usr/bin/env bun

import { createLogger, DEFAULTS, REDIS_KEYS } from "@peerbot/core";
import type Redis from "ioredis";
import type { IMessageQueue } from "../infrastructure/queue";
import {
  computeSessionKey,
  type ISessionManager,
  type SessionStore,
  type ThreadSession,
} from "../session";

const logger = createLogger("session-manager");

/**
 * Redis-based session storage
 * Sessions are stored with automatic TTL expiration
 */
export class RedisSessionStore implements SessionStore {
  private readonly SESSION_PREFIX = REDIS_KEYS.SESSION;
  private readonly THREAD_INDEX_PREFIX = "thread_index:";
  private readonly DEFAULT_TTL_SECONDS = DEFAULTS.SESSION_TTL_SECONDS;
  private redis: Redis;

  constructor(queue: IMessageQueue) {
    // Get Redis client from queue connection pool
    this.redis = queue.getRedisClient();
  }

  private getSessionKey(sessionKey: string): string {
    return `${this.SESSION_PREFIX}${sessionKey}`;
  }

  private getThreadIndexKey(channelId: string, threadTs: string): string {
    return `${this.THREAD_INDEX_PREFIX}${channelId}:${threadTs}`;
  }

  async get(sessionKey: string): Promise<ThreadSession | null> {
    try {
      const key = this.getSessionKey(sessionKey);
      const data = await this.redis.get(key);

      if (!data) {
        return null;
      }

      // Parse JSON
      return JSON.parse(data) as ThreadSession;
    } catch (error) {
      logger.error(`Failed to get session ${sessionKey}:`, error);
      return null;
    }
  }

  async set(sessionKey: string, session: ThreadSession): Promise<void> {
    try {
      const key = this.getSessionKey(sessionKey);

      // Store session with TTL in Redis
      await this.redis.setex(
        key,
        this.DEFAULT_TTL_SECONDS,
        JSON.stringify(session)
      );

      // Create thread index for fast lookups
      const indexKey = this.getThreadIndexKey(
        session.channelId,
        session.threadId
      );
      await this.redis.setex(
        indexKey,
        this.DEFAULT_TTL_SECONDS,
        JSON.stringify({ sessionKey })
      );

      logger.debug(`Stored session ${sessionKey}`);
    } catch (error) {
      logger.error(`Failed to set session ${sessionKey}:`, error);
      throw error;
    }
  }

  async delete(sessionKey: string): Promise<void> {
    try {
      // Get session first to clean up thread index
      const session = await this.get(sessionKey);

      const key = this.getSessionKey(sessionKey);
      await this.redis.del(key);

      // Clean up thread index
      if (session?.threadId) {
        const indexKey = this.getThreadIndexKey(
          session.channelId,
          session.threadId
        );
        await this.redis.del(indexKey);
      }

      logger.debug(`Deleted session ${sessionKey}`);
    } catch (error) {
      logger.error(`Failed to delete session ${sessionKey}:`, error);
      throw error;
    }
  }

  async getByThread(
    channelId: string,
    threadTs: string
  ): Promise<ThreadSession | null> {
    try {
      const indexKey = this.getThreadIndexKey(channelId, threadTs);
      const indexData = await this.redis.get(indexKey);

      if (!indexData) {
        return null;
      }

      const index = JSON.parse(indexData) as { sessionKey: string };
      return await this.get(index.sessionKey);
    } catch (error) {
      logger.error(
        `Failed to get session by thread ${channelId}:${threadTs}:`,
        error
      );
      return null;
    }
  }

  /** Optional cleanup - Redis handles this via TTL */
  async cleanup?(): Promise<number> {
    logger.debug("Redis TTL handles automatic cleanup");
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
    threadId?: string,
    threadCreator?: string
  ): Promise<ThreadSession> {
    // threadId is required for the new schema
    const effectiveThreadId = threadId || userId;
    const session: ThreadSession = {
      threadId: effectiveThreadId,
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
   * Note: Redis-based stores handle this automatically via TTL
   */
  async cleanupExpired(ttl: number): Promise<number> {
    return (await this.store.cleanup?.(ttl)) || 0;
  }
}
