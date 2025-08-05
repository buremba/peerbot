#!/usr/bin/env bun

import { SessionError } from "./types";
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
    console.log("SessionManager initialized (stateless - using Slack as source of truth)");
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

    console.log(`Created session state: ${sessionKey}`);
    return sessionState;
  }

  /**
   * Add message to conversation
   */
  async addMessage(sessionKey: string, message: ConversationMessage): Promise<void> {
    console.log(`Would add ${message.role} message to session ${sessionKey} (no-op in stateless mode)`);
  }

  /**
   * Update session progress (no-op in stateless mode)
   */
  async updateProgress(sessionKey: string, update: ProgressUpdate): Promise<void> {
    console.log(`Progress update for ${sessionKey}: ${update.type}`);
  }

  /**
   * No-op methods for compatibility
   */
  startTimeoutMonitoring(sessionKey: string): Promise<void> {
    console.log(`Timeout monitoring for ${sessionKey} (no-op in stateless mode)`);
    return Promise.resolve();
  }

  resetTimeout(_sessionKey: string): void {
    // No-op
  }

  clearTimeout(_sessionKey: string): void {
    // No-op
  }

  async persistSession(sessionKey: string): Promise<string> {
    console.log(`Session ${sessionKey} - no persistence needed (Slack is source of truth)`);
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
    console.log(`Cleanup for ${sessionKey} (no-op in stateless mode)`);
  }

  async cleanupSession(sessionKey: string): Promise<void> {
    console.log(`Cleanup for ${sessionKey} (no-op in stateless mode)`);
  }

  /**
   * Generate session key from context
   */
  static generateSessionKey(context: SessionContext): string {
    if (context.threadTs) {
      // Thread-based session
      return `${context.channelId}-${context.threadTs}`;
    } else {
      // New conversation
      return `${context.channelId}-${context.messageTs}`;
    }
  }
}