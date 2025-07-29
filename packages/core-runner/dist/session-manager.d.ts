#!/usr/bin/env bun
import type { SessionState, SessionContext, ConversationMessage, ProgressUpdate, GcsConfig } from "./types";
export declare class SessionManager {
    private activeSessions;
    private sessionTimeouts;
    private gcsStorage;
    private timeoutMinutes;
    constructor(config: GcsConfig & {
        timeoutMinutes?: number;
    });
    /**
     * Validate session key to prevent security issues
     */
    private validateSessionKey;
    /**
     * Create a new session
     */
    createSession(sessionKey: string, context: SessionContext): Promise<SessionState>;
    /**
     * Recover session from GCS
     */
    recoverSession(sessionKey: string): Promise<SessionState>;
    /**
     * Get current session state
     */
    getSession(sessionKey: string): SessionState | null;
    /**
     * Add message to conversation
     */
    addMessage(sessionKey: string, message: ConversationMessage): Promise<void>;
    /**
     * Update session progress
     */
    updateProgress(sessionKey: string, update: ProgressUpdate): Promise<void>;
    /**
     * Start timeout monitoring for session
     */
    startTimeoutMonitoring(sessionKey: string): Promise<void>;
    /**
     * Reset session timeout (called on activity)
     */
    resetTimeout(sessionKey: string): void;
    /**
     * Clear session timeout
     */
    clearTimeout(sessionKey: string): void;
    /**
     * Persist session to GCS
     */
    persistSession(sessionKey: string): Promise<string>;
    /**
     * Check if session exists in GCS
     */
    sessionExistsInGcs(sessionKey: string): Promise<boolean>;
    /**
     * Clean up session resources
     */
    cleanup(sessionKey: string): Promise<void>;
    /**
     * Generate session key from context
     */
    static generateSessionKey(context: SessionContext): string;
    /**
     * Get active session count
     */
    getActiveSessionCount(): number;
    /**
     * Get session status for monitoring
     */
    getSessionStatus(): {
        activeSessions: number;
        sessionsWithTimeouts: number;
        sessionKeys: string[];
    };
    /**
     * Emergency cleanup all sessions (for shutdown)
     */
    cleanupAll(): Promise<void>;
}
//# sourceMappingURL=session-manager.d.ts.map