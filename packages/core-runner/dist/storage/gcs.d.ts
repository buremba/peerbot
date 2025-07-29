#!/usr/bin/env bun
import type { GcsConfig, SessionState, ConversationMetadata } from "../types";
export declare class GcsStorage {
    private storage;
    private bucketName;
    constructor(config: GcsConfig);
    /**
     * Validate session key to prevent security issues
     */
    private validateSessionKey;
    /**
     * Generate GCS path for session data
     */
    private getSessionPath;
    /**
     * Generate GCS path for conversation history
     */
    private getConversationPath;
    /**
     * Generate GCS path for metadata
     */
    private getMetadataPath;
    /**
     * Save session state to GCS
     */
    saveSessionState(sessionState: SessionState): Promise<string>;
    /**
     * Load session state from GCS
     */
    loadSessionState(sessionKey: string): Promise<SessionState | null>;
    /**
     * Check if session exists in GCS
     */
    sessionExists(sessionKey: string): Promise<boolean>;
    /**
     * Delete session from GCS
     */
    deleteSession(sessionKey: string): Promise<void>;
    /**
     * List sessions for a user (for debugging/admin purposes)
     */
    listUserSessions(userId: string, limit?: number): Promise<ConversationMetadata[]>;
    /**
     * Clean up old sessions (for maintenance)
     */
    cleanupOldSessions(olderThanDays?: number): Promise<number>;
}
//# sourceMappingURL=gcs.d.ts.map