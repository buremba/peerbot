#!/usr/bin/env bun

import { SessionError } from "./types";
import logger from "./logger";
import type { 
  SessionState, 
  SessionContext, 
  ConversationMessage, 
  ProgressUpdate
} from "./types";

/**
 * Stateless session manager - Slack is the source of truth for conversation history
 */
export class SessionManager {
  constructor(_config: { timeoutMinutes?: number }) {
    logger.info("SessionManager initialized (stateless - using Slack as source of truth)");
  }

  /**
   * Create a new session state object
   */
  async createSession(sessionKey: string, context: SessionContext): Promise<SessionState> {
    const now = Date.now();
    
    const sessionState: SessionState = {
      sessionKey,
      context,
      conversation: [],
      createdAt: now,
      lastActivity: now,
      status: "active",
    };

    // Add system message for context if provided
    if (context.customInstructions) {
      sessionState.conversation.push({
        role: "system",
        content: context.customInstructions,
        timestamp: now,
      });
    }

    logger.info(`Created session state: ${sessionKey}`);
    return sessionState;
  }

  /**
   * Add message to conversation
   */
  async addMessage(sessionKey: string, message: ConversationMessage): Promise<void> {
    logger.info(`Would add ${message.role} message to session ${sessionKey} (no-op in stateless mode)`);
  }

  /**
   * Update session progress (no-op in stateless mode)
   */
  async updateProgress(sessionKey: string, update: ProgressUpdate): Promise<void> {
    logger.info(`Progress update for ${sessionKey}: ${update.type}`);
  }

  /**
   * No-op methods for compatibility
   */
  startTimeoutMonitoring(sessionKey: string): Promise<void> {
    logger.info(`Timeout monitoring for ${sessionKey} (no-op in stateless mode)`);
    return Promise.resolve();
  }

  resetTimeout(_sessionKey: string): void {
    // No-op
  }

  clearTimeout(_sessionKey: string): void {
    // No-op
  }

  async persistSession(sessionKey: string): Promise<string> {
    logger.info(`Session ${sessionKey} - no persistence needed (Slack is source of truth)`);
    return `slack://thread/${sessionKey}`;
  }

  async sessionExists(_sessionKey: string): Promise<boolean> {
    // Always return false since we don't store sessions
    return false;
  }

  async recoverSession(sessionKey: string): Promise<SessionState> {
    throw new SessionError(
      sessionKey,
      "NOT_IMPLEMENTED",
      "Session recovery not needed - conversation history comes from Slack"
    );
  }

  async cleanup(sessionKey: string): Promise<void> {
    logger.info(`Cleanup for ${sessionKey} (no-op in stateless mode)`);
  }

  async cleanupSession(sessionKey: string): Promise<void> {
    logger.info(`Cleanup for ${sessionKey} (no-op in stateless mode)`);
  }

  /**
   * Generate session key from context
   */
  static generateSessionKey(context: SessionContext): string {
    // Generate a shorter session key using just the last parts
    const channelPart = context.channelId.slice(-4); // Last 4 chars of channel
    const timestamp = context.threadTs || context.messageTs || '';
    const tsPart = timestamp.split('.')[0]?.slice(-6) || '000000'; // Last 6 digits of timestamp
    const randomPart = Math.random().toString(36).substring(2, 5); // 3 random chars
    
    return `${channelPart}-${tsPart}-${randomPart}`;
  }
}