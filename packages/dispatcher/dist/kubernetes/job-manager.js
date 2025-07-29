#!/usr/bin/env bun
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.KubernetesJobManager = void 0;
const k8s = __importStar(require("@kubernetes/client-node"));
const types_1 = require("../types");
class KubernetesJobManager {
    k8sApi;
    k8sCoreApi;
    activeJobs = new Map(); // sessionKey -> jobName
    rateLimitMap = new Map(); // userId -> rate limit data
    config;
    // Rate limiting configuration
    RATE_LIMIT_MAX_JOBS = 5; // Max jobs per user per window
    RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes window
    constructor(config) {
        this.config = config;
        // Initialize Kubernetes client
        const kc = new k8s.KubeConfig();
        if (config.kubeconfig) {
            kc.loadFromFile(config.kubeconfig);
        }
        else {
            try {
                // Always use in-cluster config when running in Kubernetes
                // This properly sets up the service account token and CA certificate
                kc.loadFromCluster();
                console.log("✅ Successfully loaded in-cluster Kubernetes configuration");
            }
            catch (error) {
                console.error("❌ Failed to load in-cluster config:", error);
                throw new Error("Failed to initialize Kubernetes client: " + error.message);
            }
        }
        this.k8sApi = kc.makeApiClient(k8s.BatchV1Api);
        this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
        // Start cleanup timer for rate limit entries
        this.startRateLimitCleanup();
    }
    /**
     * Check if user is within rate limits
     */
    checkRateLimit(userId) {
        // Use a default ID for undefined users to prevent them from bypassing rate limits
        const effectiveUserId = userId || "anonymous";
        const now = Date.now();
        const entry = this.rateLimitMap.get(effectiveUserId);
        if (!entry) {
            // First request for this user
            this.rateLimitMap.set(effectiveUserId, { count: 1, windowStart: now });
            return true;
        }
        // Check if we're in a new window
        if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
            // Reset for new window
            entry.count = 1;
            entry.windowStart = now;
            return true;
        }
        // Check if under limit
        if (entry.count < this.RATE_LIMIT_MAX_JOBS) {
            entry.count++;
            return true;
        }
        // Rate limit exceeded
        console.warn(`Rate limit exceeded for user ${effectiveUserId}: ${entry.count} jobs in current window`);
        return false;
    }
    /**
     * Start periodic cleanup of expired rate limit entries
     */
    startRateLimitCleanup() {
        const cleanupInterval = 5 * 60 * 1000; // Clean up every 5 minutes
        setInterval(() => {
            const now = Date.now();
            for (const [userId, entry] of this.rateLimitMap.entries()) {
                if (now - entry.windowStart >= this.RATE_LIMIT_WINDOW_MS) {
                    this.rateLimitMap.delete(userId);
                }
            }
        }, cleanupInterval);
    }
    /**
     * Create a worker job for the user request
     */
    async createWorkerJob(request) {
        // Check rate limits first
        if (!this.checkRateLimit(request.userId)) {
            throw new types_1.KubernetesError("createWorkerJob", `Rate limit exceeded for user ${request.userId}. Maximum ${this.RATE_LIMIT_MAX_JOBS} jobs per ${this.RATE_LIMIT_WINDOW_MS / 1000 / 60} minutes`, new Error("Rate limit exceeded"));
        }
        const jobName = this.generateJobName(request.sessionKey);
        try {
            // Check if job already exists
            const existingJobName = this.activeJobs.get(request.sessionKey);
            if (existingJobName) {
                console.log(`Job already exists for session ${request.sessionKey}: ${existingJobName}`);
                return existingJobName;
            }
            // Create job manifest
            const jobManifest = this.createJobManifest(jobName, request);
            // Create the job
            await this.k8sApi.createNamespacedJob({
                namespace: this.config.namespace,
                body: jobManifest
            });
            // Track the job
            this.activeJobs.set(request.sessionKey, jobName);
            console.log(`Created Kubernetes job: ${jobName} for session ${request.sessionKey}`);
            // Start monitoring the job
            this.monitorJob(jobName, request.sessionKey);
            return jobName;
        }
        catch (error) {
            throw new types_1.KubernetesError("createWorkerJob", `Failed to create job for session ${request.sessionKey}`, error);
        }
    }
    /**
     * Generate unique job name
     */
    generateJobName(sessionKey) {
        const timestamp = Date.now().toString(36);
        const sessionHash = sessionKey.replace(/[^a-z0-9]/gi, "").toLowerCase().substring(0, 8);
        return `claude-worker-${sessionHash}-${timestamp}`;
    }
    /**
     * Create Kubernetes Job manifest
     */
    createJobManifest(jobName, request) {
        const templateData = {
            jobName,
            namespace: this.config.namespace,
            workerImage: this.config.workerImage,
            cpu: this.config.cpu,
            memory: this.config.memory,
            timeoutSeconds: this.config.timeoutSeconds,
            sessionKey: request.sessionKey,
            userId: request.userId,
            username: request.username,
            channelId: request.channelId,
            threadTs: request.threadTs || "",
            repositoryUrl: request.repositoryUrl,
            userPrompt: Buffer.from(request.userPrompt).toString("base64"), // Base64 encode for safety
            slackResponseChannel: request.slackResponseChannel,
            slackResponseTs: request.slackResponseTs,
            claudeOptions: JSON.stringify(request.claudeOptions),
            recoveryMode: request.recoveryMode ? "true" : "false",
            // These will be injected from secrets/configmaps
            slackToken: "",
            githubToken: "",
            gcsBucket: "",
            gcsKeyFile: "",
            gcsProjectId: "",
        };
        return {
            apiVersion: "batch/v1",
            kind: "Job",
            metadata: {
                name: jobName,
                namespace: this.config.namespace,
                labels: {
                    app: "claude-worker",
                    "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
                    "user-id": request.userId,
                    component: "worker",
                },
                annotations: {
                    "claude.ai/session-key": request.sessionKey,
                    "claude.ai/user-id": request.userId,
                    "claude.ai/username": request.username,
                    "claude.ai/created-at": new Date().toISOString(),
                },
            },
            spec: {
                activeDeadlineSeconds: this.config.timeoutSeconds,
                ttlSecondsAfterFinished: 300, // Clean up job 5 minutes after completion
                template: {
                    metadata: {
                        labels: {
                            app: "claude-worker",
                            "session-key": request.sessionKey.replace(/[^a-z0-9]/gi, "-").toLowerCase(),
                            component: "worker",
                        },
                    },
                    spec: {
                        restartPolicy: "Never",
                        // Use spot instances for workers to save costs
                        nodeSelector: {
                            "cloud.google.com/gke-spot": "true",
                        },
                        tolerations: [
                            {
                                key: "cloud.google.com/gke-spot",
                                operator: "Equal",
                                value: "true",
                                effect: "NoSchedule",
                            },
                        ],
                        containers: [
                            {
                                name: "claude-worker",
                                image: this.config.workerImage,
                                imagePullPolicy: "Always",
                                resources: {
                                    requests: {
                                        cpu: this.config.cpu,
                                        memory: this.config.memory,
                                    },
                                    limits: {
                                        cpu: this.config.cpu,
                                        memory: this.config.memory,
                                    },
                                },
                                env: [
                                    {
                                        name: "SESSION_KEY",
                                        value: templateData.sessionKey,
                                    },
                                    {
                                        name: "USER_ID",
                                        value: templateData.userId,
                                    },
                                    {
                                        name: "USERNAME",
                                        value: templateData.username,
                                    },
                                    {
                                        name: "CHANNEL_ID",
                                        value: templateData.channelId,
                                    },
                                    {
                                        name: "THREAD_TS",
                                        value: templateData.threadTs,
                                    },
                                    {
                                        name: "REPOSITORY_URL",
                                        value: templateData.repositoryUrl,
                                    },
                                    {
                                        name: "USER_PROMPT",
                                        value: templateData.userPrompt,
                                    },
                                    {
                                        name: "SLACK_RESPONSE_CHANNEL",
                                        value: templateData.slackResponseChannel,
                                    },
                                    {
                                        name: "SLACK_RESPONSE_TS",
                                        value: templateData.slackResponseTs,
                                    },
                                    {
                                        name: "CLAUDE_OPTIONS",
                                        value: templateData.claudeOptions,
                                    },
                                    {
                                        name: "RECOVERY_MODE",
                                        value: templateData.recoveryMode,
                                    },
                                    {
                                        name: "SLACK_BOT_TOKEN",
                                        valueFrom: {
                                            secretKeyRef: {
                                                name: "claude-secrets",
                                                key: "slack-bot-token",
                                            },
                                        },
                                    },
                                    {
                                        name: "GITHUB_TOKEN",
                                        valueFrom: {
                                            secretKeyRef: {
                                                name: "claude-secrets",
                                                key: "github-token",
                                            },
                                        },
                                    },
                                    {
                                        name: "GCS_BUCKET_NAME",
                                        valueFrom: {
                                            configMapKeyRef: {
                                                name: "claude-config",
                                                key: "gcs-bucket-name",
                                            },
                                        },
                                    },
                                    {
                                        name: "GOOGLE_CLOUD_PROJECT",
                                        valueFrom: {
                                            configMapKeyRef: {
                                                name: "claude-config",
                                                key: "gcs-project-id",
                                                optional: true,
                                            },
                                        },
                                    },
                                ],
                                volumeMounts: [
                                    {
                                        name: "workspace",
                                        mountPath: "/workspace",
                                    },
                                    {
                                        name: "gcs-key",
                                        mountPath: "/etc/gcs",
                                        readOnly: true,
                                    },
                                ],
                                workingDir: "/workspace",
                                command: ["/app/scripts/entrypoint.sh"],
                            },
                        ],
                        volumes: [
                            {
                                name: "workspace",
                                emptyDir: {
                                    sizeLimit: "10Gi",
                                },
                            },
                            {
                                name: "gcs-key",
                                secret: {
                                    secretName: "claude-secrets",
                                    items: [
                                        {
                                            key: "gcs-service-account",
                                            path: "key.json",
                                        },
                                    ],
                                    optional: true,
                                },
                            },
                        ],
                        serviceAccountName: "peerbot-sa",
                    },
                },
            },
        };
    }
    /**
     * Monitor job status
     */
    async monitorJob(jobName, sessionKey) {
        const maxAttempts = 60; // Monitor for up to 10 minutes (10s intervals)
        let attempts = 0;
        const checkStatus = async () => {
            try {
                attempts++;
                const jobResponse = await this.k8sApi.readNamespacedJob({
                    name: jobName,
                    namespace: this.config.namespace
                });
                const job = jobResponse;
                const status = job.status;
                if (status?.succeeded) {
                    console.log(`Job ${jobName} completed successfully`);
                    this.activeJobs.delete(sessionKey);
                    return;
                }
                if (status?.failed) {
                    console.log(`Job ${jobName} failed`);
                    this.activeJobs.delete(sessionKey);
                    return;
                }
                // Check if job timed out
                if (attempts >= maxAttempts) {
                    console.log(`Job ${jobName} monitoring timed out`);
                    this.activeJobs.delete(sessionKey);
                    return;
                }
                // Continue monitoring
                setTimeout(checkStatus, 10000); // Check every 10 seconds
            }
            catch (error) {
                console.error(`Error monitoring job ${jobName}:`, error);
                this.activeJobs.delete(sessionKey);
            }
        };
        // Start monitoring
        setTimeout(checkStatus, 5000); // Initial delay of 5 seconds
    }
    /**
     * Delete a job
     */
    async deleteJob(jobName) {
        try {
            await this.k8sApi.deleteNamespacedJob({
                name: jobName,
                namespace: this.config.namespace,
                body: {
                    propagationPolicy: "Background"
                }
            });
            console.log(`Deleted job: ${jobName}`);
        }
        catch (error) {
            console.error(`Failed to delete job ${jobName}:`, error);
        }
    }
    /**
     * Get job status
     */
    async getJobStatus(jobName) {
        try {
            const response = await this.k8sApi.readNamespacedJob({
                name: jobName,
                namespace: this.config.namespace
            });
            const job = response;
            if (job.status?.succeeded)
                return "succeeded";
            if (job.status?.failed)
                return "failed";
            if (job.status?.active)
                return "running";
            return "pending";
        }
        catch (error) {
            return "unknown";
        }
    }
    /**
     * List active jobs
     */
    async listActiveJobs() {
        const jobs = [];
        for (const [sessionKey, jobName] of this.activeJobs.entries()) {
            const status = await this.getJobStatus(jobName);
            jobs.push({ name: jobName, sessionKey, status });
        }
        return jobs;
    }
    /**
     * Get active job count
     */
    getActiveJobCount() {
        return this.activeJobs.size;
    }
    /**
     * Cleanup all jobs
     */
    async cleanup() {
        console.log(`Cleaning up ${this.activeJobs.size} active jobs...`);
        const promises = Array.from(this.activeJobs.values()).map(jobName => this.deleteJob(jobName).catch(error => console.error(`Failed to delete job ${jobName}:`, error)));
        await Promise.allSettled(promises);
        this.activeJobs.clear();
        console.log("Job cleanup completed");
    }
}
exports.KubernetesJobManager = KubernetesJobManager;
//# sourceMappingURL=job-manager.js.map