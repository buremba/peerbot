#!/usr/bin/env bun
import type { ClaudeExecutionOptions, ClaudeExecutionResult, ProgressCallback, SessionContext, SessionState } from "./types";
export interface ExecuteClaudeSessionOptions {
    sessionKey: string;
    userPrompt: string;
    context: SessionContext;
    options: ClaudeExecutionOptions;
    onProgress?: ProgressCallback;
    recoveryOptions?: {
        fromGcs?: boolean;
        gcsPath?: string;
    };
}
export interface SessionExecutionResult extends ClaudeExecutionResult {
    sessionKey: string;
    persistedToGcs?: boolean;
    gcsPath?: string;
}
/**
 * Main interface for executing Claude sessions with thread-based persistence
 */
export declare class ClaudeSessionRunner {
    private sessionManager;
    constructor(config: {
        gcsBucket: string;
        gcsKeyFile?: string;
        timeoutMinutes?: number;
    });
    /**
     * Execute a Claude session with conversation persistence
     */
    executeSession(options: ExecuteClaudeSessionOptions): Promise<SessionExecutionResult>;
    /**
     * Clean up session resources
     */
    cleanupSession(sessionKey: string): Promise<void>;
    /**
     * Get current session state
     */
    getSessionState(sessionKey: string): Promise<SessionState | null>;
    /**
     * Check if session exists in GCS
     */
    sessionExists(sessionKey: string): Promise<boolean>;
}
export type { ClaudeExecutionOptions, ClaudeExecutionResult, ProgressCallback, SessionContext, SessionState, } from "./types";
export { SessionManager } from "./session-manager";
export { runClaudeWithProgress } from "./claude-execution";
export { createPromptFile } from "./prompt-generation";
export { GcsStorage } from "./storage/gcs";
//# sourceMappingURL=index.d.ts.map