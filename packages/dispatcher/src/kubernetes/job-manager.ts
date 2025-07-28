#!/usr/bin/env bun

import * as k8s from "@kubernetes/client-node";
import type { 
  KubernetesConfig,
  WorkerJobRequest,
  JobTemplateData,
  KubernetesError
} from "../types";

export class KubernetesJobManager {
  private k8sApi: k8s.BatchV1Api;
  private k8sCoreApi: k8s.CoreV1Api;
  private activeJobs = new Map<string, string>(); // sessionKey -> jobName
  private config: KubernetesConfig;

  constructor(config: KubernetesConfig) {
    this.config = config;

    // Initialize Kubernetes client
    const kc = new k8s.KubeConfig();
    
    if (config.kubeconfig) {
      kc.loadFromFile(config.kubeconfig);
    } else {
      // Try to load from cluster (for in-cluster deployment)
      try {
        kc.loadFromCluster();
      } catch (error) {
        // Fallback to default config
        kc.loadFromDefault();
      }
    }

    this.k8sApi = kc.makeApiClient(k8s.BatchV1Api);
    this.k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
  }

  /**
   * Create a worker job for the user request
   */
  async createWorkerJob(request: WorkerJobRequest): Promise<string> {
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
      await this.k8sApi.createNamespacedJob(this.config.namespace, jobManifest);
      
      // Track the job
      this.activeJobs.set(request.sessionKey, jobName);
      
      console.log(`Created Kubernetes job: ${jobName} for session ${request.sessionKey}`);
      
      // Start monitoring the job
      this.monitorJob(jobName, request.sessionKey);
      
      return jobName;

    } catch (error) {
      throw new KubernetesError(
        "createWorkerJob",
        `Failed to create job for session ${request.sessionKey}`,
        error as Error
      );
    }
  }

  /**
   * Generate unique job name
   */
  private generateJobName(sessionKey: string): string {
    const timestamp = Date.now().toString(36);
    const sessionHash = sessionKey.replace(/[^a-z0-9]/gi, "").toLowerCase().substring(0, 8);
    return `claude-worker-${sessionHash}-${timestamp}`;
  }

  /**
   * Create Kubernetes Job manifest
   */
  private createJobManifest(jobName: string, request: WorkerJobRequest): k8s.V1Job {
    const templateData: JobTemplateData = {
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
            serviceAccountName: "claude-worker",
          },
        },
      },
    };
  }

  /**
   * Monitor job status
   */
  private async monitorJob(jobName: string, sessionKey: string): Promise<void> {
    const maxAttempts = 60; // Monitor for up to 10 minutes (10s intervals)
    let attempts = 0;

    const checkStatus = async () => {
      try {
        attempts++;
        
        const jobResponse = await this.k8sApi.readNamespacedJob(jobName, this.config.namespace);
        const job = jobResponse.body;
        
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
        
      } catch (error) {
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
  async deleteJob(jobName: string): Promise<void> {
    try {
      await this.k8sApi.deleteNamespacedJob(
        jobName,
        this.config.namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        "Background" // Delete in background
      );
      
      console.log(`Deleted job: ${jobName}`);
    } catch (error) {
      console.error(`Failed to delete job ${jobName}:`, error);
    }
  }

  /**
   * Get job status
   */
  async getJobStatus(jobName: string): Promise<string> {
    try {
      const response = await this.k8sApi.readNamespacedJob(jobName, this.config.namespace);
      const job = response.body;
      
      if (job.status?.succeeded) return "succeeded";
      if (job.status?.failed) return "failed";
      if (job.status?.active) return "running";
      
      return "pending";
    } catch (error) {
      return "unknown";
    }
  }

  /**
   * List active jobs
   */
  async listActiveJobs(): Promise<Array<{ name: string; sessionKey: string; status: string }>> {
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
  getActiveJobCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Cleanup all jobs
   */
  async cleanup(): Promise<void> {
    console.log(`Cleaning up ${this.activeJobs.size} active jobs...`);
    
    const promises = Array.from(this.activeJobs.values()).map(jobName =>
      this.deleteJob(jobName).catch(error => 
        console.error(`Failed to delete job ${jobName}:`, error)
      )
    );
    
    await Promise.allSettled(promises);
    this.activeJobs.clear();
    
    console.log("Job cleanup completed");
  }
}