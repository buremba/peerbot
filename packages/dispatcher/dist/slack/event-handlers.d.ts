#!/usr/bin/env bun
import type { App } from "@slack/bolt";
import type { KubernetesJobManager } from "../kubernetes/job-manager";
import type { GitHubRepositoryManager } from "../github/repository-manager";
import type { DispatcherConfig, ThreadSession } from "../types";
export declare class SlackEventHandlers {
    private app;
    private jobManager;
    private repoManager;
    private config;
    private activeSessions;
    private userMappings;
    constructor(app: App, jobManager: KubernetesJobManager, repoManager: GitHubRepositoryManager, config: DispatcherConfig);
    /**
     * Setup Slack event handlers
     */
    private setupEventHandlers;
    /**
     * Handle user request by routing to appropriate worker
     */
    private handleUserRequest;
    /**
     * Extract Slack context from event
     */
    private extractSlackContext;
    /**
     * Extract user request from mention text
     */
    private extractUserRequest;
    /**
     * Check if user is allowed to use the bot
     */
    private isUserAllowed;
    /**
     * Get or create GitHub username mapping for Slack user
     */
    private getOrCreateUserMapping;
    /**
     * Format initial response message
     */
    private formatInitialResponse;
    /**
     * Format kubectl commands for debugging
     */
    private formatKubectlCommands;
    /**
     * Handle job completion notification
     */
    handleJobCompletion(sessionKey: string, success: boolean): Promise<void>;
    /**
     * Handle job timeout
     */
    handleJobTimeout(sessionKey: string): Promise<void>;
    /**
     * Get active sessions for monitoring
     */
    getActiveSessions(): ThreadSession[];
    /**
     * Get session count
     */
    getActiveSessionCount(): number;
    /**
     * Cleanup all sessions
     */
    cleanup(): void;
}
//# sourceMappingURL=event-handlers.d.ts.map