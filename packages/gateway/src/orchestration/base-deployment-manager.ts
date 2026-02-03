import {
  createLogger,
  ErrorCode,
  extractTraceId,
  generateWorkerToken,
  OrchestratorError,
} from "@peerbot/core";
import { mcpConfigStore } from "../auth/mcp/mcp-config-store";
import type { MessagePayload } from "../infrastructure/queue/queue-producer";
import { networkConfigStore } from "../proxy/network-config-store";
import { getScheduledWakeupService } from "./scheduled-wakeup";

// Re-export MessagePayload for use by deployment implementations
export type { MessagePayload };

const logger = createLogger("orchestrator");

/**
 * Generate a consistent deployment name from user ID and thread ID
 * This ensures all messages in the same thread use the same worker
 * K8s names must be lowercase alphanumeric with hyphens only
 */
export function generateDeploymentName(
  userId: string,
  threadId: string
): string {
  // Sanitize threadId: replace dots with hyphens, lowercase, take last 10 chars
  const shortThreadId = threadId.replace(".", "-").toLowerCase().slice(-10);
  // Sanitize userId: remove non-alphanumeric, lowercase, take first 8 chars
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortUserId = sanitizedUserId.slice(0, 8);
  return `peerbot-worker-${shortUserId}-${shortThreadId}`;
}

// Type for module environment variable builder function
export type ModuleEnvVarsBuilder = (
  userId: string,
  agentId: string,
  envVars: Record<string, string>
) => Promise<Record<string, string>>;

// Orchestrator configuration
export interface OrchestratorConfig {
  queues: {
    connectionString: string;
    retryLimit: number;
    retryDelay: number;
    expireInSeconds: number;
  };
  worker: {
    image: {
      repository: string;
      tag: string;
      pullPolicy: string;
    };
    runtimeClassName?: string; // Optional - if not set or unavailable, uses default container runtime
    resources: {
      requests: { cpu: string; memory: string };
      limits: { cpu: string; memory: string };
    };
    idleCleanupMinutes: number;
    maxDeployments: number;
    env?: Record<string, string | number | boolean>;
    persistence?: {
      size?: string;
      storageClass?: string;
    };
  };
  kubernetes: {
    namespace: string;
  };
  cleanup: {
    initialDelayMs: number;
    intervalMs: number;
    veryOldDays: number;
  };
}

export interface DeploymentInfo {
  deploymentName: string;
  lastActivity: Date;
  minutesIdle: number;
  daysSinceActivity: number;
  replicas: number;
  isIdle: boolean;
  isVeryOld: boolean;
}

export abstract class BaseDeploymentManager {
  protected config: OrchestratorConfig;
  protected moduleEnvVarsBuilder?: ModuleEnvVarsBuilder;

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder
  ) {
    this.config = config;
    this.moduleEnvVarsBuilder = moduleEnvVarsBuilder;
  }

  /**
   * Get the dispatcher URL for the worker gateway service (port 8080)
   */
  protected getDispatcherUrl(): string {
    return `http://${this.getDispatcherHost()}:8080`;
  }

  // Abstract methods that must be implemented by concrete classes
  abstract listDeployments(): Promise<DeploymentInfo[]>;
  abstract createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload,
    userEnvVars?: Record<string, string>
  ): Promise<void>;
  abstract scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void>;
  abstract deleteDeployment(deploymentName: string): Promise<void>;
  abstract updateDeploymentActivity(deploymentName: string): Promise<void>;

  /**
   * Get the dispatcher service host (without port)
   * Implementations return the appropriate host for their deployment mode
   */
  protected abstract getDispatcherHost(): string;

  /**
   * Create worker deployment for handling messages
   */
  async createWorkerDeployment(
    userId: string,
    threadId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    const deploymentName = generateDeploymentName(userId, threadId);

    logger.info(
      `Worker deployment - threadId: ${threadId}, deploymentName: ${deploymentName}`
    );

    try {
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
          throw new OrchestratorError(
            ErrorCode.DEPLOYMENT_CREATE_FAILED,
            `Cannot create new deployment: Maximum deployments limit (${maxDeployments}) reached. Current active deployments: ${deploymentsAfterCleanup.length}`,
            { maxDeployments, currentCount: deploymentsAfterCleanup.length },
            true
          );
        }
      }

      await this.createDeployment(
        deploymentName,
        userId,
        userId,
        messageData,
        {}
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
    messageData?: MessagePayload,
    includeSecrets: boolean = true,
    userEnvVars: Record<string, string> = {}
  ): Promise<{ [key: string]: string }> {
    // Validate required fields
    if (!messageData) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Message data is required for worker deployment",
        { deploymentName },
        true
      );
    }

    const { threadId, channelId, platformMetadata } = messageData;

    if (!threadId || !channelId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "threadId and channelId are required in message data",
        { deploymentName, hasThreadId: !!threadId, hasChannelId: !!channelId },
        true
      );
    }

    // Generate worker authentication token with platform info
    // Check both top-level teamId (WhatsApp) and platformMetadata.teamId (Slack)
    const teamId = messageData.teamId || platformMetadata?.teamId;
    const agentId = messageData.agentId!;
    // Extract traceId for end-to-end observability
    const traceId = extractTraceId(messageData);
    const workerToken = generateWorkerToken(userId, threadId, deploymentName, {
      channelId,
      teamId,
      platform: messageData.platform,
      agentId,
      traceId,
    });

    // Get the dispatcher host for proxy configuration
    const dispatcherHost = this.getDispatcherHost();

    // Store per-deployment network config for proxy lookup
    // The HTTP proxy extracts deploymentName from Proxy-Authorization header
    // and looks up the config from networkConfigStore
    if (messageData.networkConfig) {
      await networkConfigStore.set(deploymentName, messageData.networkConfig);
      logger.debug(
        `Stored network config for ${deploymentName}: allowed=${messageData.networkConfig.allowedDomains?.length ?? 0}, denied=${messageData.networkConfig.deniedDomains?.length ?? 0}`
      );
    }

    // Store per-deployment MCP config for session-context lookup
    if (messageData.mcpConfig) {
      await mcpConfigStore.set(deploymentName, messageData.mcpConfig);
      logger.debug(
        `Stored MCP config for ${deploymentName}: ${Object.keys(messageData.mcpConfig.mcpServers).length} servers`
      );
    }

    // Extract git config for workspace initialization
    // These are passed to worker and used by GitFilesystemModule.buildEnvVars()
    const gitEnvVars: Record<string, string> = {};
    if (messageData.gitConfig) {
      const { repoUrl, branch, sparse } = messageData.gitConfig;
      if (repoUrl) {
        gitEnvVars.GIT_REPO_URL = repoUrl;
      }
      if (branch) {
        gitEnvVars.GIT_BRANCH = branch;
      }
      if (sparse && sparse.length > 0) {
        // Comma-separated list of sparse checkout paths
        gitEnvVars.GIT_SPARSE_PATHS = sparse.join(",");
      }
      logger.debug(
        `Git config for ${deploymentName}: repo=${repoUrl}, branch=${branch || "default"}, sparse=${sparse?.length || 0}`
      );
    }

    // Extract nix config for environment setup
    // These are passed to worker entrypoint to activate Nix environment
    const nixEnvVars: Record<string, string> = {};
    if (messageData.nixConfig) {
      const { flakeUrl, packages } = messageData.nixConfig;
      if (flakeUrl) {
        nixEnvVars.NIX_FLAKE_URL = flakeUrl;
      }
      if (packages && packages.length > 0) {
        // Comma-separated list of Nix packages
        nixEnvVars.NIX_PACKAGES = packages.join(",");
      }
      logger.debug(
        `Nix config for ${deploymentName}: flakeUrl=${flakeUrl || "none"}, packages=${packages?.length || 0}`
      );
    }

    // Build proxy URL with deployment identification via Basic auth
    // Format: http://<deploymentName>:<workerToken>@<host>:8118
    // The proxy extracts deploymentName from username and looks up per-deployment config
    const proxyUrl = `http://${deploymentName}:${workerToken}@${dispatcherHost}:8118`;

    let envVars: { [key: string]: string } = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: channelId,
      ORIGINAL_MESSAGE_TS:
        platformMetadata?.originalMessageTs || messageData.messageId || "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      THREAD_ID: threadId,
      // Worker authentication and communication
      WORKER_TOKEN: workerToken,
      DISPATCHER_URL: this.getDispatcherUrl(),
      // Node environment - always production for workers (they have read-only filesystem)
      NODE_ENV: "production",
      // Enable SDK debugging for crash investigation
      DEBUG: "1",
      // HTTP proxy configuration for network isolation
      // Workers must route all external traffic through the gateway proxy
      // Proxy-Authorization Basic auth identifies the deployment for per-agent network rules
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      // Don't proxy internal services (base list, extended below)
      NO_PROXY: `${dispatcherHost},redis,localhost,127.0.0.1`,
    };

    // Add optional environment variables only if they exist
    if (messageData?.platformMetadata?.botResponseTs) {
      envVars.BOT_RESPONSE_TS = messageData.platformMetadata.botResponseTs;
    }

    // Add trace ID for end-to-end observability
    if (traceId) {
      envVars.TRACE_ID = traceId;
    }

    // Add Tempo endpoint for distributed tracing
    const tempoEndpoint = process.env.TEMPO_ENDPOINT;
    if (tempoEndpoint) {
      envVars.TEMPO_ENDPOINT = tempoEndpoint;
      // Extract tempo hostname and add to NO_PROXY so workers can send traces directly
      try {
        const tempoUrl = new URL(tempoEndpoint);
        envVars.NO_PROXY = `${envVars.NO_PROXY},${tempoUrl.hostname}`;
      } catch {
        // If URL parsing fails, just add peerbot-tempo as fallback
        envVars.NO_PROXY = `${envVars.NO_PROXY},peerbot-tempo`;
      }
    }

    // Merge git environment variables before module processing
    // This allows GitFilesystemModule.buildEnvVars() to access GIT_REPO_URL etc.
    Object.assign(envVars, gitEnvVars);

    // Merge nix environment variables
    // Worker entrypoint reads NIX_FLAKE_URL and NIX_PACKAGES to activate Nix environment
    Object.assign(envVars, nixEnvVars);

    // Include secrets from process.env for Docker deployments
    if (includeSecrets && this.moduleEnvVarsBuilder) {
      // Add module-specific environment variables
      try {
        envVars = await this.moduleEnvVarsBuilder(userId, agentId, envVars);
      } catch (error) {
        logger.warn("Failed to build module environment variables:", error);
      }
    }
    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      Object.entries(this.config.worker.env).forEach(([key, value]) => {
        envVars[key] = String(value);
      });
    }

    // Merge user environment variables (they take precedence over defaults)
    Object.entries(userEnvVars).forEach(([key, value]) => {
      // User env vars can override any default except system-critical ones
      if (key !== "QUEUE_URL" && key !== "DEPLOYMENT_NAME") {
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
  async deleteWorkerDeployment(deploymentName: string): Promise<void> {
    try {
      // Clean up per-deployment configs from stores
      await networkConfigStore.delete(deploymentName);
      await mcpConfigStore.delete(deploymentName);

      // Clean up any scheduled wakeups for this deployment
      const scheduledWakeupService = getScheduledWakeupService();
      if (scheduledWakeupService) {
        await scheduledWakeupService.cleanupForDeployment(deploymentName);
      }

      await this.deleteDeployment(deploymentName);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_DELETE_FAILED,
        `Failed to delete deployment for ${deploymentName}: ${error instanceof Error ? error.message : String(error)}`,
        { deploymentName, error },
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
        const { deploymentName, replicas, isIdle, isVeryOld } = analysis;

        if (isVeryOld) {
          // Delete very old deployments (>= 7 days)
          try {
            await this.deleteWorkerDeployment(deploymentName);
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
        for (const { deploymentName } of deploymentsToDelete) {
          try {
            await this.deleteWorkerDeployment(deploymentName);
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
