#!/usr/bin/env bun
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GcsStorage = exports.createPromptFile = exports.runClaudeWithProgress = exports.SessionManager = exports.ClaudeSessionRunner = void 0;
const claude_execution_1 = require("./claude-execution");
const session_manager_1 = require("./session-manager");
const prompt_generation_1 = require("./prompt-generation");
/**
 * Main interface for executing Claude sessions with thread-based persistence
 */
class ClaudeSessionRunner {
    sessionManager;
    constructor(config) {
        this.sessionManager = new session_manager_1.SessionManager({
            bucketName: config.gcsBucket,
            keyFile: config.gcsKeyFile,
            timeoutMinutes: config.timeoutMinutes
        });
    }
    /**
     * Execute a Claude session with conversation persistence
     */
    async executeSession(options) {
        const { sessionKey, userPrompt, context, options: claudeOptions, onProgress, recoveryOptions } = options;
        try {
            // Initialize or recover session
            let sessionState;
            if (recoveryOptions?.fromGcs) {
                console.log(`Recovering session ${sessionKey} from GCS...`);
                sessionState = await this.sessionManager.recoverSession(sessionKey);
            }
            else {
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
            const promptPath = await (0, prompt_generation_1.createPromptFile)(context, sessionState.conversation);
            // Start session timeout monitoring
            this.sessionManager.startTimeoutMonitoring(sessionKey);
            // Execute Claude with progress monitoring
            const result = await (0, claude_execution_1.runClaudeWithProgress)(promptPath, claudeOptions, async (update) => {
                // Reset session timeout on activity
                this.sessionManager.resetTimeout(sessionKey);
                // Persist progress to session
                await this.sessionManager.updateProgress(sessionKey, update);
                // Call external progress callback
                if (onProgress) {
                    await onProgress(update);
                }
            });
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
        }
        catch (error) {
            console.error(`Session ${sessionKey} execution failed:`, error);
            // Try to persist error state
            try {
                await this.sessionManager.persistSession(sessionKey);
            }
            catch (persistError) {
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
    async cleanupSession(sessionKey) {
        await this.sessionManager.cleanup(sessionKey);
    }
    /**
     * Get current session state
     */
    async getSessionState(sessionKey) {
        return this.sessionManager.getSession(sessionKey);
    }
    /**
     * Check if session exists in GCS
     */
    async sessionExists(sessionKey) {
        return this.sessionManager.sessionExistsInGcs(sessionKey);
    }
}
exports.ClaudeSessionRunner = ClaudeSessionRunner;
var session_manager_2 = require("./session-manager");
Object.defineProperty(exports, "SessionManager", { enumerable: true, get: function () { return session_manager_2.SessionManager; } });
var claude_execution_2 = require("./claude-execution");
Object.defineProperty(exports, "runClaudeWithProgress", { enumerable: true, get: function () { return claude_execution_2.runClaudeWithProgress; } });
var prompt_generation_2 = require("./prompt-generation");
Object.defineProperty(exports, "createPromptFile", { enumerable: true, get: function () { return prompt_generation_2.createPromptFile; } });
var gcs_1 = require("./storage/gcs");
Object.defineProperty(exports, "GcsStorage", { enumerable: true, get: function () { return gcs_1.GcsStorage; } });
//# sourceMappingURL=index.js.map