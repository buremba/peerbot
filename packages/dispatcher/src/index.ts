#!/usr/bin/env bun

import { App, LogLevel } from "@slack/bolt";
import { SlackEventHandlers } from "./slack/event-handlers";
import { KubernetesJobManager } from "./kubernetes/job-manager";
import { DockerJobManager } from "./docker/job-manager";
import { GitHubRepositoryManager } from "./github/repository-manager";
import { setupHealthEndpoints } from "./simple-http";
import { SlackTokenManager } from "./slack/token-manager";
import type { AgentManager } from "./infrastructure/agent-manager";
import type { DispatcherConfig } from "./types";

export class SlackDispatcher {
  private app: App;
  private eventHandlers: SlackEventHandlers;
  private jobManager: AgentManager;
  private repoManager: GitHubRepositoryManager;
  private config: DispatcherConfig;
  private tokenManager?: SlackTokenManager;

  constructor(config: DispatcherConfig) {
    this.config = config;
    this.tokenManager = config.slack.tokenManager;

    // Initialize Slack app with authorize function if token manager is available
    const appConfig: any = {
      token: config.slack.token,
      appToken: config.slack.appToken,
      signingSecret: config.slack.signingSecret,
      socketMode: config.slack.socketMode !== false,
      port: config.slack.port || 3000,
      logLevel: config.logLevel || LogLevel.INFO,
      ignoreSelf: true,
      // Enable request logging
      installerOptions: {
        port: config.slack.port || 3000,
      },
      // Process events even without responding
      processBeforeResponse: true,
    };

    // If token manager is available, use authorize function instead of static token
    if (this.tokenManager) {
      delete appConfig.token; // Remove static token
      appConfig.authorize = async () => {
        const token = await this.tokenManager!.getValidToken();
        return {
          botToken: token,
          botId: config.slack.botUserId,
          botUserId: config.slack.botUserId,
        };
      };
    }

    this.app = new App(appConfig);

    // Initialize managers based on infrastructure mode
    if (config.infrastructure === "docker") {
      if (!config.docker) {
        throw new Error("Docker configuration is required when infrastructure mode is 'docker'");
      }
      this.jobManager = new DockerJobManager(config.docker, this.tokenManager);
    } else {
      if (!config.kubernetes) {
        throw new Error("Kubernetes configuration is required when infrastructure mode is 'kubernetes'");
      }
      this.jobManager = new KubernetesJobManager(config.kubernetes, this.tokenManager);
    }
    this.repoManager = new GitHubRepositoryManager(config.github);
    this.eventHandlers = new SlackEventHandlers(
      this.app,
      this.jobManager,
      this.repoManager,
      config
    );

    this.setupErrorHandling();
    this.setupGracefulShutdown();
  }

  /**
   * Start the dispatcher
   */
  async start(): Promise<void> {
    try {
      await this.app.start();
      
      // Setup health endpoints for Kubernetes
      setupHealthEndpoints();
      
      const mode = this.config.slack.socketMode ? "Socket Mode" : `HTTP on port ${this.config.slack.port}`;
      console.log(`🚀 Slack Dispatcher is running in ${mode}!`);
      
      // Log configuration
      console.log("Configuration:");
      console.log(`- Infrastructure Mode: ${this.config.infrastructure}`);
      if (this.config.infrastructure === "kubernetes" && this.config.kubernetes) {
        console.log(`- Kubernetes Namespace: ${this.config.kubernetes.namespace}`);
        console.log(`- Worker Image: ${this.config.kubernetes.workerImage}`);
      } else if (this.config.infrastructure === "docker" && this.config.docker) {
        console.log(`- Docker Socket: ${this.config.docker.socketPath || "/var/run/docker.sock"}`);
        console.log(`- Worker Image: ${this.config.docker.workerImage}`);
        console.log(`- Workspace Host Dir: ${this.config.docker.workspaceVolumeHost || "none"}`);
      }
      console.log(`- GitHub Organization: ${this.config.github.organization}`);
      console.log(`- GCS Bucket: ${this.config.gcs.bucketName}`);
      console.log(`- Session Timeout: ${this.config.sessionTimeoutMinutes} minutes`);
      console.log(`- Signing Secret: ${this.config.slack.signingSecret?.substring(0, 8)}...`);
      
    } catch (error) {
      console.error("Failed to start Slack dispatcher:", error);
      process.exit(1);
    }
  }

  /**
   * Stop the dispatcher
   */
  async stop(): Promise<void> {
    try {
      await this.app.stop();
      await this.jobManager.cleanup();
      
      // Stop token manager if it exists
      if (this.tokenManager) {
        this.tokenManager.stop();
      }
      
      console.log("Slack dispatcher stopped");
    } catch (error) {
      console.error("Error stopping Slack dispatcher:", error);
    }
  }

  /**
   * Get dispatcher status
   */
  getStatus(): {
    isRunning: boolean;
    activeJobs: number;
    config: Partial<DispatcherConfig>;
  } {
    return {
      isRunning: true,
      activeJobs: this.jobManager.getActiveJobCount(),
      config: {
        slack: {
          socketMode: this.config.slack.socketMode,
          port: this.config.slack.port,
        },
        infrastructure: this.config.infrastructure,
        ...(this.config.infrastructure === "kubernetes" && this.config.kubernetes && {
          kubernetes: {
            namespace: this.config.kubernetes.namespace,
            workerImage: this.config.kubernetes.workerImage,
          }
        }),
        ...(this.config.infrastructure === "docker" && this.config.docker && {
          docker: {
            workerImage: this.config.docker.workerImage,
            socketPath: this.config.docker.socketPath,
          }
        }),
      },
    };
  }

  /**
   * Setup error handling
   */
  private setupErrorHandling(): void {
    this.app.error(async (error) => {
      console.error("Slack app error:", error);
      console.error("Error details:", {
        message: error.message,
        code: (error as any).code,
        data: (error as any).data,
        stack: error.stack
      });
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      process.exit(1);
    });
  }

  /**
   * Setup graceful shutdown
   */
  private setupGracefulShutdown(): void {
    const cleanup = async () => {
      console.log("Shutting down Slack dispatcher...");
      
      // Stop accepting new jobs
      await this.stop();
      
      // Wait for active jobs to complete (with timeout)
      const activeJobs = this.jobManager.getActiveJobCount();
      if (activeJobs > 0) {
        console.log(`Waiting for ${activeJobs} active jobs to complete...`);
        
        const timeout = setTimeout(() => {
          console.log("Timeout reached, forcing shutdown");
          process.exit(0);
        }, 60000); // 1 minute timeout
        
        // Wait for jobs to complete
        while (this.jobManager.getActiveJobCount() > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        clearTimeout(timeout);
      }
      
      console.log("Slack dispatcher shutdown complete");
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    console.log("🚀 Starting Claude Code Slack Dispatcher");

    // Initialize token manager if refresh token is available
    let tokenManager: SlackTokenManager | undefined;
    let botToken = process.env.SLACK_BOT_TOKEN;
    
    if (process.env.SLACK_REFRESH_TOKEN && process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
      console.log("🔄 Initializing token rotation...");
      
      // If no bot token, get one using refresh token
      if (!botToken) {
        const params = new URLSearchParams({
          client_id: process.env.SLACK_CLIENT_ID,
          client_secret: process.env.SLACK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: process.env.SLACK_REFRESH_TOKEN
        });

        const response = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString()
        });

        const data = await response.json() as any;
        
        if (data.ok && data.access_token) {
          botToken = data.access_token;
          console.log("✅ Successfully obtained initial access token");
        } else {
          throw new Error(`Failed to get initial access token: ${data.error}`);
        }
      }
      
      // Initialize token manager
      tokenManager = new SlackTokenManager(
        process.env.SLACK_CLIENT_ID,
        process.env.SLACK_CLIENT_SECRET,
        process.env.SLACK_REFRESH_TOKEN,
        botToken!
      );
    }

    // Determine infrastructure mode
    const infrastructureMode = (process.env.INFRASTRUCTURE_MODE || "kubernetes") as "kubernetes" | "docker";
    
    // Load configuration from environment
    const config: DispatcherConfig = {
      slack: {
        token: botToken || process.env.SLACK_BOT_TOKEN!,
        tokenManager,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: process.env.SLACK_HTTP_MODE !== "true",
        port: parseInt(process.env.PORT || "3000"),
        botUserId: process.env.SLACK_BOT_USER_ID,
        triggerPhrase: process.env.SLACK_TRIGGER_PHRASE || "@peerbotai",
        allowedUsers: process.env.SLACK_ALLOWED_USERS?.split(","),
        allowedChannels: process.env.SLACK_ALLOWED_CHANNELS?.split(","),
      },
      infrastructure: infrastructureMode,
      ...(infrastructureMode === "kubernetes" && {
        kubernetes: {
          namespace: process.env.KUBERNETES_NAMESPACE || "default",
          workerImage: process.env.WORKER_IMAGE || "claude-worker:latest",
          cpu: process.env.WORKER_CPU || "1000m",
          memory: process.env.WORKER_MEMORY || "2Gi",
          timeoutSeconds: parseInt(process.env.WORKER_TIMEOUT_SECONDS || "300"),
        }
      }),
      ...(infrastructureMode === "docker" && {
        docker: {
          socketPath: process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
          workspaceVolumeHost: process.env.WORKSPACE_HOST_DIR,
          network: process.env.DOCKER_NETWORK,
          removeContainers: process.env.DOCKER_REMOVE_CONTAINERS !== "false",
          workerImage: process.env.WORKER_IMAGE || "claude-worker:latest",
          cpu: process.env.WORKER_CPU,
          memory: process.env.WORKER_MEMORY,
          timeoutSeconds: parseInt(process.env.WORKER_TIMEOUT_SECONDS || "300"),
        }
      }),
      github: {
        token: process.env.GITHUB_TOKEN!,
        organization: process.env.GITHUB_ORGANIZATION || "peerbot-community",
      },
      gcs: {
        bucketName: process.env.GCS_BUCKET_NAME || "peerbot-conversations-prod",
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        projectId: process.env.GOOGLE_CLOUD_PROJECT,
      },
      claude: {
        allowedTools: process.env.ALLOWED_TOOLS,
        model: process.env.MODEL,
        timeoutMinutes: process.env.TIMEOUT_MINUTES,
      },
      sessionTimeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || "5"),
      logLevel: process.env.LOG_LEVEL as any || LogLevel.INFO,
    };

    // Validate required configuration
    if (!config.slack.token) {
      throw new Error("Either SLACK_BOT_TOKEN or SLACK_REFRESH_TOKEN with SLACK_CLIENT_ID and SLACK_CLIENT_SECRET is required");
    }
    if (!config.github.token) {
      throw new Error("GITHUB_TOKEN is required");
    }
    
    // Validate infrastructure-specific configuration
    if (config.infrastructure === "docker" && !config.docker) {
      throw new Error("Docker configuration is missing when infrastructure mode is 'docker'");
    }
    if (config.infrastructure === "kubernetes" && !config.kubernetes) {
      throw new Error("Kubernetes configuration is missing when infrastructure mode is 'kubernetes'");
    }

    // Create and start dispatcher
    const dispatcher = new SlackDispatcher(config);
    await dispatcher.start();

    console.log("✅ Claude Code Slack Dispatcher is running!");

    // Handle health checks
    process.on("SIGUSR1", () => {
      const status = dispatcher.getStatus();
      console.log("Health check:", JSON.stringify(status, null, 2));
    });

  } catch (error) {
    console.error("❌ Failed to start Slack Dispatcher:", error);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

export type { DispatcherConfig } from "./types";