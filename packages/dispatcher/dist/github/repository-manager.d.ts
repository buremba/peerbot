#!/usr/bin/env bun
import type { GitHubConfig, UserRepository } from "../types";
export declare class GitHubRepositoryManager {
    private octokit;
    private config;
    private repositories;
    constructor(config: GitHubConfig);
    /**
     * Ensure user repository exists, create if needed
     */
    ensureUserRepository(username: string): Promise<UserRepository>;
    /**
     * Create a new user repository
     */
    private createUserRepository;
    /**
     * Generate initial README content
     */
    private generateInitialReadme;
    /**
     * Create initial directory structure
     */
    private createInitialStructure;
    /**
     * Get repository information
     */
    getRepositoryInfo(username: string): Promise<UserRepository | null>;
    /**
     * List all user repositories in the organization
     */
    listUserRepositories(): Promise<UserRepository[]>;
    /**
     * Update repository last used timestamp
     */
    updateLastUsed(username: string): void;
    /**
     * Get repository stats for monitoring
     */
    getRepositoryStats(): {
        totalRepositories: number;
        recentlyUsed: number;
        cached: number;
    };
    /**
     * Clear repository cache
     */
    clearCache(): void;
    /**
     * Check if organization exists and is accessible
     */
    validateOrganization(): Promise<boolean>;
    /**
     * Get GitHub API rate limit status
     */
    getRateLimitStatus(): Promise<{
        limit: number;
        remaining: number;
        reset: Date;
    }>;
}
//# sourceMappingURL=repository-manager.d.ts.map