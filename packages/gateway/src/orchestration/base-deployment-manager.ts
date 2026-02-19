import { createHash } from "node:crypto";
import {
  createLogger,
  ErrorCode,
  extractTraceId,
  generateWorkerToken,
  type ModelProviderModule,
  OrchestratorError,
} from "@lobu/core";
import type Redis from "ioredis";
import { mcpConfigStore } from "../auth/mcp/mcp-config-store";
import type { MessagePayload } from "../infrastructure/queue/queue-producer";
import { networkConfigStore } from "../proxy/network-config-store";
import {
  deleteSecretMappings,
  generatePlaceholder,
} from "../proxy/secret-proxy";
import { getScheduledWakeupService } from "./scheduled-wakeup";

// Re-export MessagePayload for use by deployment implementations
export type { MessagePayload };

const logger = createLogger("orchestrator");

/**
 * Generate a consistent worker runtime ID from user ID and conversation ID.
 * This ensures all messages in the same conversation route to the same worker runtime.
 * K8s names must be lowercase alphanumeric with hyphens only
 */
export function generateDeploymentName(
  userId: string,
  conversationId: string
): string {
  // Keep a short, readable user prefix, but ensure uniqueness via hash.
  const sanitizedUserId = userId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortUserId = (sanitizedUserId.slice(0, 8) || "user").toLowerCase();

  const hash = createHash("sha256")
    .update(`${userId}:${conversationId}`)
    .digest("hex")
    .slice(0, 12);

  return `lobu-worker-${shortUserId}-${hash}`;
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

/** Check if an env var name looks like a secret (API key / token / secret / password). */
function isSecretEnvVar(
  name: string,
  providerModules: ModelProviderModule[]
): boolean {
  for (const provider of providerModules) {
    if (provider.getSecretEnvVarNames().includes(name)) return true;
  }
  const upper = name.toUpperCase();
  return (
    upper.includes("_KEY") ||
    upper.includes("_TOKEN") ||
    upper.includes("_SECRET") ||
    upper.includes("_PASSWORD")
  );
}

export abstract class BaseDeploymentManager {
  protected config: OrchestratorConfig;
  protected moduleEnvVarsBuilder?: ModuleEnvVarsBuilder;
  protected providerModules: ModelProviderModule[];
  protected redisClient?: Redis;

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    this.config = config;
    this.moduleEnvVarsBuilder = moduleEnvVarsBuilder;
    this.providerModules = providerModules;
  }

  /**
   * Inject Redis client for secret placeholder generation.
   * Called after core services are initialized.
   */
  setRedisClient(redis: Redis): void {
    this.redisClient = redis;
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
   * Create worker deployment for handling messages.
   * @param existingDeployments - Optional pre-fetched deployment list to avoid redundant API calls
   */
  async createWorkerDeployment(
    userId: string,
    conversationId: string,
    messageData?: MessagePayload,
    existingDeployments?: DeploymentInfo[]
  ): Promise<void> {
    const deploymentName = generateDeploymentName(userId, conversationId);

    logger.info(
      `Worker deployment - conversationId: ${conversationId}, deploymentName: ${deploymentName}`
    );

    try {
      // Use pre-fetched list or fetch fresh
      const deployments = existingDeployments ?? (await this.listDeployments());
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
            {
              maxDeployments,
              currentCount: deploymentsAfterCleanup.length,
            },
            true
          );
        }
      }

      // Extract user env vars from agent settings (carried in agentOptions)
      const userEnvVars =
        (messageData?.agentOptions as Record<string, any>)?.envVars ?? {};

      await this.createDeployment(
        deploymentName,
        userId,
        userId,
        messageData,
        userEnvVars
      );
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to create worker deployment: ${error instanceof Error ? error.message : String(error)}`,
        { userId, conversationId, error },
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

    const { conversationId, channelId, platformMetadata } = messageData as any;
    const effectiveConversationId = conversationId;

    if (!effectiveConversationId || !channelId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "conversationId and channelId are required in message data",
        {
          deploymentName,
          hasConversationId: !!effectiveConversationId,
          hasChannelId: !!channelId,
        },
        true
      );
    }

    // Generate worker authentication token with platform info
    // Check both top-level teamId (WhatsApp) and platformMetadata.teamId (Slack)
    const teamId = messageData.teamId || platformMetadata?.teamId;
    const agentId = messageData.agentId!;
    // Extract traceId for end-to-end observability
    const traceId = extractTraceId(messageData);
    const workerToken = generateWorkerToken(
      userId,
      effectiveConversationId,
      deploymentName,
      {
        channelId,
        teamId,
        platform: messageData.platform,
        agentId,
        traceId,
      }
    );

    // Get the dispatcher host for proxy configuration
    const dispatcherHost = this.getDispatcherHost();

    // Auto-add Nix cache domains when Nix packages are configured
    // Workers need to download packages from cache.nixos.org etc.
    if (
      messageData.nixConfig?.packages?.length ||
      messageData.nixConfig?.flakeUrl
    ) {
      const NIX_DOMAINS = [
        "cache.nixos.org",
        "channels.nixos.org",
        "releases.nixos.org",
      ];
      if (!messageData.networkConfig) {
        messageData.networkConfig = {};
      }
      const existing = messageData.networkConfig.allowedDomains || [];
      const toAdd = NIX_DOMAINS.filter((d) => !existing.includes(d));
      if (toAdd.length > 0) {
        messageData.networkConfig.allowedDomains = [...existing, ...toAdd];
        logger.info(
          `Added Nix cache domains to network allowlist for ${deploymentName}: ${toAdd.join(", ")}`
        );
      }
    }

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

    const parsedProxyPort = Number.parseInt(
      process.env.WORKER_PROXY_PORT || "8118",
      10
    );
    const proxyPort = Number.isFinite(parsedProxyPort) ? parsedProxyPort : 8118;

    // Build proxy URL with deployment identification via Basic auth
    // Format: http://<deploymentName>:<workerToken>@<host>:<proxyPort>
    // The proxy extracts deploymentName from username and looks up per-deployment config
    // Note: Credentials in proxy URL is standard for transparent HTTP proxying.
    // The workerToken is short-lived and scoped to this deployment only.
    const proxyUrl = `http://${deploymentName}:${workerToken}@${dispatcherHost}:${proxyPort}`;

    let envVars: { [key: string]: string } = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: channelId,
      ORIGINAL_MESSAGE_TS:
        platformMetadata?.originalMessageTs || messageData.messageId || "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      CONVERSATION_ID: effectiveConversationId,
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
        // If URL parsing fails, just add lobu-tempo as fallback
        envVars.NO_PROXY = `${envVars.NO_PROXY},lobu-tempo`;
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

    // System-critical env vars that must not be overridden by user config
    const PROTECTED_ENV_VARS = new Set([
      "QUEUE_URL",
      "DEPLOYMENT_NAME",
      "WORKER_TOKEN",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "DISPATCHER_URL",
      "NODE_ENV",
    ]);

    // Merge user environment variables (they take precedence over defaults)
    Object.entries(userEnvVars).forEach(([key, value]) => {
      if (!PROTECTED_ENV_VARS.has(key)) {
        envVars[key] = value;
      }
    });

    if (Object.keys(userEnvVars).length > 0) {
      logger.info(
        `📦 Loaded ${Object.keys(userEnvVars).length} user environment variables for ${userId}`
      );
    }

    // Inject system key fallback from registered model provider modules
    for (const provider of this.providerModules) {
      envVars = provider.injectSystemKeyFallback(envVars);
    }

    // Replace secret env vars with placeholders and point SDK at the proxy
    if (this.redisClient) {
      let hasSecrets = false;
      for (const [key, value] of Object.entries(envVars)) {
        if (!value || !isSecretEnvVar(key, this.providerModules)) continue;
        // Skip system env vars that should not be swapped
        if (key === "WORKER_TOKEN") continue;
        try {
          const placeholder = await generatePlaceholder(
            this.redisClient,
            agentId,
            key,
            value,
            deploymentName
          );
          envVars[key] = placeholder;
          hasSecrets = true;
        } catch (error) {
          logger.warn(`Failed to generate placeholder for ${key}:`, error);
        }
      }

      if (hasSecrets) {
        // Point provider SDKs at the secret proxy instead of directly at provider APIs
        const proxyUrl = `${this.getDispatcherUrl()}/api/proxy`;
        for (const provider of this.providerModules) {
          Object.assign(envVars, provider.getProxyBaseUrlMappings(proxyUrl));
        }
        logger.info(
          `🔐 Generated secret placeholders for ${deploymentName}, routing through proxy`
        );
      }
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

      // Clean up secret placeholder mappings
      if (this.redisClient) {
        await deleteSecretMappings(this.redisClient, deploymentName);
      }

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
      const BATCH_SIZE = 10; // Process up to 10 deletions in parallel

      // Collect actions to perform
      const toDelete: string[] = [];
      const toScaleDown: string[] = [];

      for (const analysis of sortedDeployments) {
        const { deploymentName, replicas, isIdle, isVeryOld } = analysis;

        if (isVeryOld) {
          toDelete.push(deploymentName);
        } else if (isIdle && replicas > 0) {
          toScaleDown.push(deploymentName);
        }
      }

      // Check if we exceed max deployments
      const remainingDeployments = sortedDeployments.filter(
        (d) => !d.isVeryOld
      );
      if (remainingDeployments.length > maxDeployments) {
        const excessCount = remainingDeployments.length - maxDeployments;
        const deploymentsToDelete = remainingDeployments.slice(0, excessCount);
        for (const { deploymentName } of deploymentsToDelete) {
          if (!toDelete.includes(deploymentName)) {
            toDelete.push(deploymentName);
          }
        }
      }

      // Process deletions in parallel batches
      for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
        const batch = toDelete.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((name) => this.deleteWorkerDeployment(name))
        );
        for (let j = 0; j < results.length; j++) {
          if (results[j]!.status === "fulfilled") {
            processedCount++;
          } else {
            logger.error(
              `❌ Failed to delete deployment ${batch[j]}:`,
              (results[j] as PromiseRejectedResult).reason
            );
          }
        }
      }

      // Process scale-downs in parallel batches
      for (let i = 0; i < toScaleDown.length; i += BATCH_SIZE) {
        const batch = toScaleDown.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((name) => this.scaleDeployment(name, 0))
        );
        for (let j = 0; j < results.length; j++) {
          if (results[j]!.status === "fulfilled") {
            processedCount++;
          } else {
            logger.error(
              `❌ Failed to scale down deployment ${batch[j]}:`,
              (results[j] as PromiseRejectedResult).reason
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
