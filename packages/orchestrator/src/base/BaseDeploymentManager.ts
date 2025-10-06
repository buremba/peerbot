import type { DatabaseAdapter } from "@peerbot/shared";
import { DatabaseManager } from "@peerbot/shared";
import {
  ErrorCode,
  type OrchestratorConfig,
  OrchestratorError,
} from "../types";
import type { BaseSecretManager } from "./BaseSecretManager";
import { createLogger } from "@peerbot/shared";
import { buildModuleEnvVars } from "../module-integration";

const logger = createLogger("orchestrator");

export interface DeploymentInfo {
  deploymentName: string;
  deploymentId: string;
  lastActivity: Date;
  minutesIdle: number;
  daysSinceActivity: number;
  replicas: number;
  isIdle: boolean;
  isVeryOld: boolean;
}

export abstract class BaseDeploymentManager {
  protected config: OrchestratorConfig;
  protected database: DatabaseAdapter;
  protected databaseManager: DatabaseManager;
  protected secretManager: BaseSecretManager;

  constructor(
    config: OrchestratorConfig,
    database: DatabaseAdapter,
    secretManager: BaseSecretManager
  ) {
    this.config = config;
    this.database = database;
    this.databaseManager = new DatabaseManager(database);
    this.secretManager = secretManager;
  }

  /**
   * Get all environment variables for a user from database with context
   * Priority: Channel+Repo > Channel > User+Repo > User
   */
  protected async getUserEnvironmentVariables(
    userId: string,
    channelId?: string,
    repository?: string
  ): Promise<Record<string, string>> {
    try {
      return await this.database.getEnvironmentVariables({
        platformUserId: userId,
        channelId,
        repository,
      });
    } catch (error) {
      logger.error(
        `Error fetching environment variables for user ${userId}:`,
        error
      );
      return {};
    }
  }

  // Abstract methods that must be implemented by concrete classes
  abstract listDeployments(): Promise<DeploymentInfo[]>;
  abstract createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: any,
    userEnvVars?: Record<string, string>
  ): Promise<void>;
  abstract scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void>;
  abstract deleteDeployment(deploymentId: string): Promise<void>;
  abstract updateDeploymentActivity(deploymentName: string): Promise<void>;

  /**
   * Create worker deployment for handling messages
   */
  async createWorkerDeployment(
    userId: string,
    threadId: string,
    messageData?: any
  ): Promise<void> {
    // CRITICAL: Create deployment name using user ID and thread ID
    // This name MUST be consistent for all messages in the same thread
    // Thread ID should ALWAYS be the Slack thread_ts (root message timestamp)
    // DO NOT use individual message timestamps - that creates multiple workers per thread!
    // Example: peerbot-worker-u095zlhk-297-164169 (one worker for entire thread)
    const shortThreadId = threadId.replace(".", "-").slice(-10); // Last 10 chars, replace dot with dash
    const shortUserId = userId.toLowerCase().slice(0, 8); // First 8 chars of user ID
    const deploymentName = `peerbot-worker-${shortUserId}-${shortThreadId}`;

    logger.info(
      `Worker deployment - threadId: ${threadId}, deploymentName: ${deploymentName}`
    );

    try {
      // Always ensure user credentials exist first
      const username = this.databaseManager.generatePostgresUsername(userId);

      // Check if secret already exists and get existing password, or generate new one
      await this.secretManager.getOrCreateUserCredentials(
        username,
        (username: string, password: string) =>
          this.databaseManager.createPostgresUser(username, password)
      );

      // Check if deployment already exists by getting the list and filtering
      const deployments = await this.listDeployments();
      const existingDeployment = deployments.find(
        (d) => d.deploymentName === deploymentName
      );

      if (existingDeployment) {
        await this.scaleDeployment(deploymentName, 1);
        return;
      }

      // Check if we would exceed max deployments limit
      const maxDeployments = this.config.worker.maxDeployments;
      if (maxDeployments > 0 && deployments.length >= maxDeployments) {
        logger.warn(
          `⚠️  Maximum deployments limit reached (${deployments.length}/${maxDeployments}). Running cleanup before creating new deployment.`
        );
        await this.reconcileDeployments();

        // Check again after cleanup
        const deploymentsAfterCleanup = await this.listDeployments();
        if (deploymentsAfterCleanup.length >= maxDeployments) {
          throw new Error(
            `Cannot create new deployment: Maximum deployments limit (${maxDeployments}) reached. Current active deployments: ${deploymentsAfterCleanup.length}`
          );
        }
      }

      // Extract channel and repository from messageData
      const channelId = messageData?.channelId;
      const repository = messageData?.platformMetadata?.repositoryUrl;

      // Fetch user environment variables with context
      const userEnvVars = await this.getUserEnvironmentVariables(
        userId,
        channelId,
        repository
      );

      await this.createDeployment(
        deploymentName,
        username,
        userId,
        messageData,
        userEnvVars
      );
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create worker deployment: ${error instanceof Error ? error.message : String(error)}`,
        { userId, threadId, error },
        true
      );
    }
  }

  /**
   * Generate environment variables common to all deployment types
   */
  protected async generateEnvironmentVariables(
    username: string,
    userId: string,
    deploymentName: string,
    messageData?: any,
    includeSecrets: boolean = true,
    userEnvVars: Record<string, string> = {}
  ): Promise<{ [key: string]: string }> {
    // Parse database connection string to extract host and port
    const dbUrl = new URL(this.config.database.connectionString);
    const dbHost = dbUrl.hostname;
    const dbPort = dbUrl.port || "5432"; // Default PostgreSQL port

    let envVars: { [key: string]: string } = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: messageData?.channelId || "",
      ORIGINAL_MESSAGE_TS:
        messageData?.platformMetadata?.originalMessageTs ||
        messageData?.messageId ||
        "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      SLACK_TEAM_ID: messageData?.platformMetadata?.teamId || "",
      SLACK_CHANNEL_ID: messageData?.channelId || "",
      SLACK_THREAD_TS: messageData?.threadId || "",
      PEERBOT_DATABASE_HOST: dbHost,
      PEERBOT_DATABASE_PORT: dbPort,
    };

    // Add optional environment variables only if they exist
    if (messageData?.platformMetadata?.repositoryUrl) {
      envVars.REPOSITORY_URL = messageData.platformMetadata.repositoryUrl;
    }
    if (messageData?.platformMetadata?.botResponseTs) {
      envVars.BOT_RESPONSE_TS = messageData.platformMetadata.botResponseTs;
    }

    // Include secrets from process.env for Docker deployments
    if (includeSecrets) {
      // Add module-specific environment variables
      try {
        envVars = await buildModuleEnvVars(userId, envVars);
      } catch (error) {
        logger.warn("Failed to build module environment variables:", error);
      }
    }

    if (process.env.CLAUDE_ALLOWED_TOOLS) {
      envVars.CLAUDE_ALLOWED_TOOLS = process.env.CLAUDE_ALLOWED_TOOLS;
    }

    if (process.env.CLAUDE_DISALLOWED_TOOLS) {
      envVars.CLAUDE_DISALLOWED_TOOLS = process.env.CLAUDE_DISALLOWED_TOOLS;
    }

    if (process.env.CLAUDE_TIMEOUT_MINUTES) {
      envVars.CLAUDE_TIMEOUT_MINUTES = process.env.CLAUDE_TIMEOUT_MINUTES;
    }

    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      Object.entries(this.config.worker.env).forEach(([key, value]) => {
        envVars[key] = String(value);
      });
    }

    // Always configure Anthropic API proxy
    const dispatcherService =
      process.env.DISPATCHER_SERVICE_NAME || "peerbot-dispatcher";
    // The proxy runs on port 8080, not the main service port 3000
    const dispatcherProxyPort = process.env.DISPATCHER_PROXY_PORT || "8080";
    const namespace = process.env.KUBERNETES_NAMESPACE || "peerbot";

    // Detect if we're running in Docker mode (DEPLOYMENT_MODE=docker) or Kubernetes mode
    const isDockerMode = process.env.DEPLOYMENT_MODE === "docker";
    let proxyUrl: string;

    if (isDockerMode) {
      // For Docker mode with Docker Compose, use the dispatcher container name
      // The dispatcher runs on port 8080 in Docker mode for the proxy endpoint
      // Using the container name works because they're on the same Docker network
      proxyUrl = `http://peerbot-dispatcher-1:8080/api/anthropic`;
    } else {
      // For Kubernetes mode, use internal service DNS
      // The dispatcher runs on port 8080 for the proxy endpoint
      proxyUrl = `http://${dispatcherService}.${namespace}.svc.cluster.local:${dispatcherProxyPort}/api/anthropic`;
    }

    // Set the base URL to use dispatcher's proxy
    envVars.ANTHROPIC_BASE_URL = proxyUrl;

    // ANTHROPIC_API_KEY will be set by the container command override
    // which uses the database username and password

    logger.info(
      `🔧 Configured worker to use Anthropic proxy at ${envVars.ANTHROPIC_BASE_URL}`
    );

    // Merge user environment variables (they take precedence over defaults)
    Object.entries(userEnvVars).forEach(([key, value]) => {
      // Skip database credentials as they're handled separately
      if (!key.startsWith("PEERBOT_DATABASE_")) {
        envVars[key] = value;
      }
    });

    if (Object.keys(userEnvVars).length > 0) {
      logger.info(
        `📦 Loaded ${Object.keys(userEnvVars).length} user environment variables for ${userId}`
      );
    }

    return envVars;
  }

  /**
   * Delete a worker deployment and associated resources
   */
  async deleteWorkerDeployment(deploymentId: string): Promise<void> {
    try {
      // const _deploymentName = `peerbot-worker-${deploymentId}`;

      await this.deleteDeployment(deploymentId);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_DELETE_FAILED,
        `Failed to delete deployment for ${deploymentId}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentId, error },
        true
      );
    }
  }

  /**
   * Reconcile deployments: unified method for cleanup and resource management
   * This method uses the abstract methods to work with any deployment backend
   */
  async reconcileDeployments(): Promise<void> {
    try {
      const maxDeployments = this.config.worker.maxDeployments;

      logger.info("🔄 Running deployment cleanup...");

      // Get all worker deployments from the backend
      const activeDeployments = await this.listDeployments();

      if (activeDeployments.length === 0) {
        return;
      }

      // Sort deployments by last activity (oldest first)
      const sortedDeployments = [...activeDeployments].sort(
        (a, b) => a.lastActivity.getTime() - b.lastActivity.getTime()
      );

      let processedCount = 0;

      // Process each deployment based on its state
      for (const analysis of sortedDeployments) {
        const {
          deploymentName,
          deploymentId,
          // minutesIdle,
          // daysSinceActivity,
          replicas,
          isIdle,
          isVeryOld,
        } = analysis;

        if (isVeryOld) {
          // Delete very old deployments (>= 7 days)
          try {
            await this.deleteWorkerDeployment(deploymentId);
            processedCount++;
          } catch (error) {
            logger.error(
              `❌ Failed to delete deployment ${deploymentName}:`,
              error
            );
          }
        } else if (isIdle && replicas > 0) {
          // Scale down idle deployments
          try {
            await this.scaleDeployment(deploymentName, 0);
            processedCount++;
          } catch (error) {
            logger.error(
              `❌ Failed to scale down deployment ${deploymentName}:`,
              error
            );
          }
        }
      }

      // Check if we exceed max deployments (after cleanup)
      const remainingDeployments = sortedDeployments.filter(
        (d) => !d.isVeryOld
      );
      if (remainingDeployments.length > maxDeployments) {
        const excessCount = remainingDeployments.length - maxDeployments;

        const deploymentsToDelete = remainingDeployments.slice(0, excessCount);
        for (const { deploymentName, deploymentId } of deploymentsToDelete) {
          try {
            await this.deleteWorkerDeployment(deploymentId);
            processedCount++;
          } catch (error) {
            logger.error(
              `❌ Failed to remove deployment ${deploymentName}:`,
              error
            );
          }
        }
      }

      if (processedCount > 0) {
        logger.info(
          `✅ Cleanup completed: processed ${processedCount} deployment(s)`
        );
      }
    } catch (error) {
      logger.error(
        "Error during deployment reconciliation:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
