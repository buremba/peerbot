#!/usr/bin/env bun

import { runClaudeWithProgress } from "./claude-execution";
import { SessionManager } from "./session-manager";
import { createPromptFile } from "./prompt-generation";
import type { 
  ClaudeExecutionOptions, 
  ClaudeExecutionResult, 
  ProgressCallback,
  SessionContext,
  SessionState 
} from "./types";

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
export class ClaudeSessionRunner {
  private sessionManager: SessionManager;

  constructor(config: {
    gcsBucket: string;
    gcsKeyFile?: string;
    timeoutMinutes?: number;
  }) {
    this.sessionManager = new SessionManager({
      bucketName: config.gcsBucket,
      keyFile: config.gcsKeyFile,
      timeoutMinutes: config.timeoutMinutes
    });
  }

  /**
   * Execute a Claude session with conversation persistence
   */
  async executeSession(options: ExecuteClaudeSessionOptions): Promise<SessionExecutionResult> {
    const { sessionKey, userPrompt, context, options: claudeOptions, onProgress, recoveryOptions } = options;

    try {
      // Initialize or recover session
      let sessionState: SessionState;
      
      if (recoveryOptions?.fromGcs) {
        console.log(`Recovering session ${sessionKey} from GCS...`);
        sessionState = await this.sessionManager.recoverSession(sessionKey);
      } else {
        console.log(`Creating new session ${sessionKey}...`);
        sessionState = await this.sessionManager.createSession(sessionKey, context);
      }

      // Add user message to conversation
      await this.sessionManager.addMessage(sessionKey, {
        role: "user",
        content: userPrompt,
        timestamp: Date.now(),
      });

      // Create prompt file with full conversation context
      const promptPath = await createPromptFile(context, sessionState.conversation);

      // Start session timeout monitoring
      this.sessionManager.startTimeoutMonitoring(sessionKey);

      // Execute Claude with progress monitoring
      const result = await runClaudeWithProgress(
        promptPath,
        claudeOptions,
        async (update) => {
          // Reset session timeout on activity
          this.sessionManager.resetTimeout(sessionKey);
          
          // Persist progress to session
          await this.sessionManager.updateProgress(sessionKey, update);
          
          // Call external progress callback
          if (onProgress) {
            await onProgress(update);
          }
        }
      );

      // Add Claude's response to conversation
      if (result.success && result.output) {
        await this.sessionManager.addMessage(sessionKey, {
          role: "assistant", 
          content: result.output,
          timestamp: Date.now(),
        });
      }

      // Persist final session state to GCS
      const gcsPath = await this.sessionManager.persistSession(sessionKey);

      // Clean up session timeout
      this.sessionManager.clearTimeout(sessionKey);

      return {
        ...result,
        sessionKey,
        persistedToGcs: true,
        gcsPath,
      };

    } catch (error) {
      console.error(`Session ${sessionKey} execution failed:`, error);
      
      // Try to persist error state
      try {
        await this.sessionManager.persistSession(sessionKey);
      } catch (persistError) {
        console.error(`Failed to persist session on error:`, persistError);
      }

      // Clean up
      this.sessionManager.clearTimeout(sessionKey);

      return {
        success: false,
        exitCode: 1,
        output: "",
        error: error instanceof Error ? error.message : "Unknown error",
        sessionKey,
      };
    }
  }

  /**
   * Clean up session resources
   */
  async cleanupSession(sessionKey: string): Promise<void> {
    await this.sessionManager.cleanup(sessionKey);
  }

  /**
   * Get current session state
   */
  async getSessionState(sessionKey: string): Promise<SessionState | null> {
    return this.sessionManager.getSession(sessionKey);
  }

  /**
   * Check if session exists in GCS
   */
  async sessionExists(sessionKey: string): Promise<boolean> {
    return this.sessionManager.sessionExistsInGcs(sessionKey);
  }
}

// Re-export types and utilities
export type {
  ClaudeExecutionOptions,
  ClaudeExecutionResult,
  ProgressCallback,
  SessionContext,
  SessionState,
} from "./types";

export { SessionManager } from "./session-manager";
export { runClaudeWithProgress } from "./claude-execution";
export { createPromptFile } from "./prompt-generation";
export { GcsStorage } from "./storage/gcs";