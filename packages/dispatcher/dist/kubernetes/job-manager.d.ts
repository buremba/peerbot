#!/usr/bin/env bun
import type { KubernetesConfig, WorkerJobRequest } from "../types";
import type { SlackTokenManager } from "../slack/token-manager";
export declare class KubernetesJobManager {
    private k8sApi;
    private k8sCoreApi;
    private activeJobs;
    private rateLimitMap;
    private config;
    private tokenManager?;
    private readonly RATE_LIMIT_MAX_JOBS;
    private readonly RATE_LIMIT_WINDOW_MS;
    constructor(config: KubernetesConfig, tokenManager?: SlackTokenManager);
    /**
     * Check if user is within rate limits
     */
    private checkRateLimit;
    /**
     * Start periodic cleanup of expired rate limit entries
     */
    private startRateLimitCleanup;
    /**
     * Create a worker job for the user request
     */
    createWorkerJob(request: WorkerJobRequest): Promise<string>;
    /**
     * Generate unique job name
     */
    private generateJobName;
    /**
     * Create Kubernetes Job manifest
     */
    private createJobManifest;
    /**
     * Monitor job status
     */
    private monitorJob;
    /**
     * Delete a job
     */
    deleteJob(jobName: string): Promise<void>;
    /**
     * Get job status
     */
    getJobStatus(jobName: string): Promise<string>;
    /**
     * List active jobs
     */
    listActiveJobs(): Promise<Array<{
        name: string;
        sessionKey: string;
        status: string;
    }>>;
    /**
     * Get active job count
     */
    getActiveJobCount(): number;
    /**
     * Cleanup all jobs
     */
    cleanup(): Promise<void>;
}
//# sourceMappingURL=job-manager.d.ts.map