#!/usr/bin/env bun
import type { DispatcherConfig } from "./types";
export declare class SlackDispatcher {
    private app;
    private eventHandlers;
    private jobManager;
    private repoManager;
    private config;
    private tokenManager?;
    constructor(config: DispatcherConfig);
    /**
     * Start the dispatcher
     */
    start(): Promise<void>;
    /**
     * Stop the dispatcher
     */
    stop(): Promise<void>;
    /**
     * Get dispatcher status
     */
    getStatus(): {
        isRunning: boolean;
        activeJobs: number;
        config: Partial<DispatcherConfig>;
    };
    /**
     * Setup error handling
     */
    private setupErrorHandling;
    /**
     * Setup graceful shutdown
     */
    private setupGracefulShutdown;
}
export type { DispatcherConfig } from "./types";
//# sourceMappingURL=index.d.ts.map