#!/usr/bin/env bun

import { GcsStorage } from "./storage/gcs";
import type { 
  SessionState, 
  SessionContext, 
  ConversationMessage, 
  ProgressUpdate,
  SessionError,
  GcsConfig 
} from "./types";

export class SessionManager {
  private activeSessions = new Map<string, SessionState>();
  private sessionTimeouts = new Map<string, NodeJS.Timeout>();
  private gcsStorage: GcsStorage;
  private timeoutMinutes: number;

  constructor(config: GcsConfig & { timeoutMinutes?: number }) {
    this.gcsStorage = new GcsStorage(config);
    this.timeoutMinutes = config.timeoutMinutes || 5; // Default 5 minutes
  }

  /**
   * Validate session key to prevent security issues
   */
  private validateSessionKey(sessionKey: string): void {
    if (!sessionKey || typeof sessionKey !== 'string') {
      throw new SessionError(sessionKey, "INVALID_KEY", "Session key must be a non-empty string");
    }
    
    if (sessionKey.length > 100) {
      throw new SessionError(sessionKey, "INVALID_KEY", "Session key too long (max 100 characters)");
    }
    
    // Prevent path traversal and malicious patterns
    const maliciousPatterns = [
      /\.\./,           // Parent directory traversal
      /[\\\/]/,         // Path separators (forward or backward slash)
      /[\x00-\x1f]/,    // Control characters
      /[<>:"|?*]/,      // Invalid filename characters
    ];
    
    for (const pattern of maliciousPatterns) {
      if (pattern.test(sessionKey)) {
        throw new SessionError(sessionKey, "INVALID_KEY", "Session key contains invalid characters or patterns");
      }
    }
    
    // Allow only alphanumeric, dots, hyphens, and underscores
    if (!/^[a-zA-Z0-9._-]+$/.test(sessionKey)) {
      throw new SessionError(sessionKey, "INVALID_KEY", "Session key must contain only alphanumeric characters, dots, hyphens, and underscores");
    }
  }

  /**
   * Create a new session
   */
  async createSession(sessionKey: string, context: SessionContext): Promise<SessionState> {
    this.validateSessionKey(sessionKey);
    const now = Date.now();
    
    const sessionState: SessionState = {
      sessionKey,
      context,
      conversation: [],
      createdAt: now,
      lastActivity: now,
      status: "active",
    };

    // Add system message for context
    if (context.customInstructions) {
      sessionState.conversation.push({
        role: "system",
        content: context.customInstructions,
        timestamp: now,
      });
    }

    this.activeSessions.set(sessionKey, sessionState);
    console.log(`Created new session: ${sessionKey}`);
    
    return sessionState;
  }

  /**
   * Recover session from GCS
   */
  async recoverSession(sessionKey: string): Promise<SessionState> {
    this.validateSessionKey(sessionKey);
    try {
      // Check if session is already active in memory
      const activeSession = this.activeSessions.get(sessionKey);
      if (activeSession) {
        console.log(`Session ${sessionKey} already active in memory`);
        return activeSession;
      }

      // Load from GCS
      const sessionState = await this.gcsStorage.loadSessionState(sessionKey);
      
      if (!sessionState) {
        throw new Error(`Session ${sessionKey} not found in GCS`);
      }

      // Mark as active and update last activity
      sessionState.status = "active";
      sessionState.lastActivity = Date.now();

      // Store in active sessions
      this.activeSessions.set(sessionKey, sessionState);
      
      console.log(`Recovered session: ${sessionKey} with ${sessionState.conversation.length} messages`);
      return sessionState;

    } catch (error) {
      throw new SessionError(
        sessionKey,
        "RECOVERY_FAILED",
        `Failed to recover session from GCS`,
        error as Error
      );
    }
  }

  /**
   * Get current session state
   */
  getSession(sessionKey: string): SessionState | null {
    this.validateSessionKey(sessionKey);
    return this.activeSessions.get(sessionKey) || null;
  }

  /**
   * Add message to conversation
   */
  async addMessage(sessionKey: string, message: ConversationMessage): Promise<void> {
    this.validateSessionKey(sessionKey);
    const session = this.activeSessions.get(sessionKey);
    if (!session) {
      throw new SessionError(sessionKey, "SESSION_NOT_FOUND", "Session not found");
    }

    session.conversation.push(message);
    session.lastActivity = Date.now();
    
    console.log(`Added ${message.role} message to session ${sessionKey}`);
  }

  /**
   * Update session progress
   */
  async updateProgress(sessionKey: string, update: ProgressUpdate): Promise<void> {
    this.validateSessionKey(sessionKey);
    const session = this.activeSessions.get(sessionKey);
    if (!session) {
      return; // Session might have timed out
    }

    session.lastActivity = Date.now();
    
    if (!session.progress) {
      session.progress = {};
    }
    
    session.progress.lastUpdate = update;
    
    // Add progress as a message if it's significant
    if (update.type === "completion" || update.type === "error") {
      await this.addMessage(sessionKey, {
        role: "assistant",
        content: `Progress update: ${update.type}`,
        timestamp: update.timestamp,
        metadata: { progressUpdate: update },
      });
    }
  }

  /**
   * Start timeout monitoring for session
   */
  startTimeoutMonitoring(sessionKey: string): Promise<void> {
    this.validateSessionKey(sessionKey);
    return new Promise((resolve) => {
      const timeoutMs = this.timeoutMinutes * 60 * 1000;
      
      const timeoutId = setTimeout(async () => {
        console.log(`Session ${sessionKey} timed out after ${this.timeoutMinutes} minutes`);
        
        const session = this.activeSessions.get(sessionKey);
        if (session) {
          session.status = "timeout";
          session.lastActivity = Date.now();
          
          // Persist session before cleanup
          try {
            await this.persistSession(sessionKey);
          } catch (error) {
            console.error(`Failed to persist session ${sessionKey} on timeout:`, error);
          }
          
          // Clean up
          this.activeSessions.delete(sessionKey);
        }
        
        this.sessionTimeouts.delete(sessionKey);
        resolve();
      }, timeoutMs);

      this.sessionTimeouts.set(sessionKey, timeoutId);
      console.log(`Started timeout monitoring for session ${sessionKey} (${this.timeoutMinutes} minutes)`);
    });
  }

  /**
   * Reset session timeout (called on activity)
   */
  resetTimeout(sessionKey: string): void {
    this.validateSessionKey(sessionKey);
    const existingTimeout = this.sessionTimeouts.get(sessionKey);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this.sessionTimeouts.delete(sessionKey);
      
      // Restart timeout monitoring
      this.startTimeoutMonitoring(sessionKey);
    }
  }

  /**
   * Clear session timeout
   */
  clearTimeout(sessionKey: string): void {
    this.validateSessionKey(sessionKey);
    const timeoutId = this.sessionTimeouts.get(sessionKey);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.sessionTimeouts.delete(sessionKey);
      console.log(`Cleared timeout for session ${sessionKey}`);
    }
  }

  /**
   * Persist session to GCS
   */
  async persistSession(sessionKey: string): Promise<string> {
    this.validateSessionKey(sessionKey);
    const session = this.activeSessions.get(sessionKey);
    if (!session) {
      throw new SessionError(sessionKey, "SESSION_NOT_FOUND", "Session not found for persistence");
    }

    try {
      const gcsPath = await this.gcsStorage.saveSessionState(session);
      console.log(`Persisted session ${sessionKey} to GCS`);
      return gcsPath;
    } catch (error) {
      throw new SessionError(
        sessionKey,
        "PERSISTENCE_FAILED",
        "Failed to persist session to GCS",
        error as Error
      );
    }
  }

  /**
   * Check if session exists in GCS
   */
  async sessionExistsInGcs(sessionKey: string): Promise<boolean> {
    this.validateSessionKey(sessionKey);
    return this.gcsStorage.sessionExists(sessionKey);
  }

  /**
   * Clean up session resources
   */
  async cleanup(sessionKey: string): Promise<void> {
    this.validateSessionKey(sessionKey);
    const session = this.activeSessions.get(sessionKey);
    
    if (session) {
      session.status = "completed";
      session.lastActivity = Date.now();
      
      // Persist final state
      try {
        await this.persistSession(sessionKey);
      } catch (error) {
        console.error(`Failed to persist session ${sessionKey} during cleanup:`, error);
      }
    }

    // Clear timeout
    this.clearTimeout(sessionKey);
    
    // Remove from active sessions
    this.activeSessions.delete(sessionKey);
    
    console.log(`Cleaned up session: ${sessionKey}`);
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

  /**
   * Get active session count
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Get session status for monitoring
   */
  getSessionStatus(): {
    activeSessions: number;
    sessionsWithTimeouts: number;
    sessionKeys: string[];
  } {
    return {
      activeSessions: this.activeSessions.size,
      sessionsWithTimeouts: this.sessionTimeouts.size,
      sessionKeys: Array.from(this.activeSessions.keys()),
    };
  }

  /**
   * Emergency cleanup all sessions (for shutdown)
   */
  async cleanupAll(): Promise<void> {
    console.log(`Emergency cleanup of ${this.activeSessions.size} sessions...`);
    
    const promises = Array.from(this.activeSessions.keys()).map(sessionKey =>
      this.cleanup(sessionKey).catch(error => 
        console.error(`Failed to cleanup session ${sessionKey}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    console.log("Emergency cleanup completed");
  }
}