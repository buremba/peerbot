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
import type { GrantStore } from "../permissions/grant-store";
import {
  deleteSecretMappings,
  generatePlaceholder,
} from "../proxy/secret-proxy";
import { getScheduledWakeupService } from "./scheduled-wakeup";

// Re-export MessagePayload for use by deployment implementations
export type { MessagePayload };

const logger = createLogger("orchestrator");

export interface DeploymentIdentity {
  conversationId: string;
  channelId?: string;
  platform?: string;
  userId?: string;
}

/**
 * Build a canonical conversation identity key for runtime routing.
 * Preferred format: platform:channelId:conversationId
 */
export function buildCanonicalConversationKey(
  identity: DeploymentIdentity
): string {
  const { conversationId, channelId, platform } = identity;
  if (platform && channelId) {
    return `${platform}:${channelId}:${conversationId}`;
  }
  if (channelId) {
    return `${channelId}:${conversationId}`;
  }
  return conversationId;
}

function sanitizeNameHint(value: string | undefined, fallback: string): string {
  const sanitized = (value || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (sanitized.slice(0, 8) || fallback).toLowerCase();
}

/**
 * Generate a consistent worker runtime ID from canonical conversation identity.
 * Overload preserved for compatibility with older callers.
 * K8s names must be lowercase alphanumeric with hyphens only.
 */
export function generateDeploymentName(
  userId: string,
  conversationId: string
): string;
export function generateDeploymentName(identity: DeploymentIdentity): string;
export function generateDeploymentName(
  arg1: string | DeploymentIdentity,
  arg2?: string
): string {
  if (typeof arg1 === "string") {
    const userId = arg1;
    const conversationId = arg2 || "";
    const shortHint = sanitizeNameHint(userId, "user");
    const hash = createHash("sha256")
      .update(`${userId}:${conversationId}`)
      .digest("hex")
      .slice(0, 12);
    return `lobu-worker-${shortHint}-${hash}`;
  }

  const identity = arg1;
  const canonicalKey = buildCanonicalConversationKey(identity);
  const hint = sanitizeNameHint(identity.platform || identity.userId, "ctx");
  const hash = createHash("sha256")
    .update(canonicalKey)
    .digest("hex")
    .slice(0, 12);
  return `lobu-worker-${hint}-${hash}`;
}

// Type for module environment variable builder function
export type ModuleEnvVarsBuilder = (
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
      digest?: string;
      pullPolicy: string;
    };
    serviceAccountName?: string;
    imagePullSecrets?: string[];
    runtimeClassName?: string; // Optional - if not set or unavailable, uses default container runtime
    startupTimeoutSeconds?: number;
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
  protected providerCatalogService?: import("../auth/provider-catalog").ProviderCatalogService;
  protected redisClient?: Redis;
  protected grantStore?: GrantStore;

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
   * Refresh provider modules after module registry initialization.
   */
  setProviderModules(providerModules: ModelProviderModule[]): void {
    this.providerModules = providerModules;
  }

  setProviderCatalogService(
    service: import("../auth/provider-catalog").ProviderCatalogService
  ): void {
    this.providerCatalogService = service;
  }

  /**
   * Inject grant store for auto-adding domain grants at deployment time.
   */
  setGrantStore(store: GrantStore): void {
    this.grantStore = store;
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
  abstract validateWorkerImage(): Promise<void>;

  /**
   * Get the dispatcher service host (without port)
   * Implementations return the appropriate host for their deployment mode
   */
  protected abstract getDispatcherHost(): string;

  /**
   * Resolve worker image reference.
   * If digest is configured, prefer immutable digest reference (repo@sha256:...).
   */
  protected getWorkerImageReference(): string {
    const { repository, tag, digest } = this.config.worker.image;
    const normalizedDigest = digest?.trim();

    if (normalizedDigest) {
      const digestWithAlgo = normalizedDigest.startsWith("sha256:")
        ? normalizedDigest
        : `sha256:${normalizedDigest}`;
      return `${repository}@${digestWithAlgo}`;
    }

    return `${repository}:${tag}`;
  }

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
    const deploymentIdentity: DeploymentIdentity = {
      userId,
      conversationId,
      channelId: messageData?.channelId,
      platform: messageData?.platform,
    };
    const deploymentName = generateDeploymentName(deploymentIdentity);
    const canonicalConversationKey =
      buildCanonicalConversationKey(deploymentIdentity);

    logger.info(
      `Worker deployment - conversationId: ${conversationId}, canonicalKey: ${canonicalConversationKey}, deploymentName: ${deploymentName}`
    );

    try {
      // Use pre-fetched list or fetch fresh
      const deployments = existingDeployments ?? (await this.listDeployments());
      const existingDeployment = deployments.find(
        (d) => d.deploymentName === deploymentName
      );

      if (existingDeployment) {
        // Scale up the existing deployment. Provider config is now delivered
        // dynamically via session context, so no need to recreate.
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
   * Validate that messageData has all required fields for deployment.
   */
  private validateMessageData(
    deploymentName: string,
    messageData?: MessagePayload
  ): MessagePayload {
    if (!messageData) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Message data is required for worker deployment",
        { deploymentName },
        true
      );
    }

    const { conversationId, channelId } = messageData;
    if (!conversationId || !channelId) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "conversationId and channelId are required in message data",
        {
          deploymentName,
          hasConversationId: !!conversationId,
          hasChannelId: !!channelId,
        },
        true
      );
    }

    return messageData;
  }

  /**
   * Auto-add Nix cache domains as grants and persist MCP configs for the deployment.
   */
  private async storeDeploymentConfigs(
    deploymentName: string,
    messageData: MessagePayload
  ): Promise<void> {
    const agentId = messageData.agentId;

    // Sync networkConfig.allowedDomains to grant store
    if (
      this.grantStore &&
      agentId &&
      messageData.networkConfig?.allowedDomains?.length
    ) {
      for (const domain of messageData.networkConfig.allowedDomains) {
        await this.grantStore.grant(agentId, domain, null);
      }
      logger.info(
        `Synced network config domains as grants for ${deploymentName}: ${messageData.networkConfig.allowedDomains.join(", ")}`
      );
    }

    // Auto-add Nix cache domains as permanent grants when Nix packages are configured
    if (
      this.grantStore &&
      agentId &&
      (messageData.nixConfig?.packages?.length ||
        messageData.nixConfig?.flakeUrl)
    ) {
      const NIX_DOMAINS = [
        "cache.nixos.org",
        "channels.nixos.org",
        "releases.nixos.org",
      ];
      for (const domain of NIX_DOMAINS) {
        await this.grantStore.grant(agentId, domain, null);
      }
      logger.info(
        `Added Nix cache domains as grants for ${deploymentName}: ${NIX_DOMAINS.join(", ")}`
      );
    }

    if (messageData.mcpConfig) {
      await mcpConfigStore.set(deploymentName, messageData.mcpConfig);
      logger.debug(
        `Stored MCP config for ${deploymentName}: ${Object.keys(messageData.mcpConfig.mcpServers).length} servers`
      );
    }
  }

  /**
   * Sync networkConfig.allowedDomains to the grant store for a running worker.
   * Called on every message to pick up domains added via settings page.
   */
  async syncNetworkConfigGrants(messageData: MessagePayload): Promise<void> {
    const agentId = messageData.agentId;
    if (
      !this.grantStore ||
      !agentId ||
      !messageData.networkConfig?.allowedDomains?.length
    ) {
      return;
    }
    for (const domain of messageData.networkConfig.allowedDomains) {
      await this.grantStore.grant(agentId, domain, null);
    }
  }

  /**
   * Build proxy URL with deployment identification via Basic auth.
   */
  private buildProxyUrl(
    deploymentName: string,
    workerToken: string,
    dispatcherHost: string
  ): string {
    const parsedProxyPort = Number.parseInt(
      process.env.WORKER_PROXY_PORT || "8118",
      10
    );
    const proxyPort = Number.isFinite(parsedProxyPort) ? parsedProxyPort : 8118;
    return `http://${deploymentName}:${workerToken}@${dispatcherHost}:${proxyPort}`;
  }

  /**
   * Assemble the base environment variables map for a worker deployment.
   */
  private assembleBaseEnv(
    username: string,
    userId: string,
    deploymentName: string,
    workerToken: string,
    messageData: MessagePayload,
    traceId: string | undefined,
    proxyUrl: string,
    dispatcherHost: string
  ): Record<string, string> {
    const { conversationId, channelId, platformMetadata } = messageData;

    const envVars: Record<string, string> = {
      USER_ID: userId,
      USERNAME: username,
      DEPLOYMENT_NAME: deploymentName,
      CHANNEL_ID: channelId,
      ORIGINAL_MESSAGE_TS:
        platformMetadata?.originalMessageTs || messageData.messageId || "",
      LOG_LEVEL: "info",
      WORKSPACE_DIR: "/workspace",
      CONVERSATION_ID: conversationId,
      WORKER_TOKEN: workerToken,
      DISPATCHER_URL: this.getDispatcherUrl(),
      NODE_ENV: process.env.NODE_ENV || "production",
      DEBUG: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: `${dispatcherHost},redis,localhost,127.0.0.1`,
      // Route temporary files and cache to persistent workspace storage.
      TMPDIR: "/workspace/.tmp",
      TMP: "/workspace/.tmp",
      TEMP: "/workspace/.tmp",
      XDG_CACHE_HOME: "/workspace/.cache",
    };

    if (platformMetadata?.botResponseTs) {
      envVars.BOT_RESPONSE_TS = platformMetadata.botResponseTs;
    }

    if (traceId) {
      envVars.TRACE_ID = traceId;
    }

    // Add Tempo endpoint for distributed tracing
    const tempoEndpoint = process.env.TEMPO_ENDPOINT;
    if (tempoEndpoint) {
      envVars.TEMPO_ENDPOINT = tempoEndpoint;
      try {
        const tempoUrl = new URL(tempoEndpoint);
        envVars.NO_PROXY = `${envVars.NO_PROXY},${tempoUrl.hostname}`;
      } catch {
        envVars.NO_PROXY = `${envVars.NO_PROXY},lobu-tempo`;
      }
    }

    // Nix config
    if (messageData.nixConfig) {
      const { flakeUrl, packages } = messageData.nixConfig;
      if (flakeUrl) envVars.NIX_FLAKE_URL = flakeUrl;
      if (packages && packages.length > 0)
        envVars.NIX_PACKAGES = packages.join(",");
      logger.debug(
        `Nix config for ${deploymentName}: flakeUrl=${flakeUrl || "none"}, packages=${packages?.length || 0}`
      );
    }

    return envVars;
  }

  /**
   * Replace secret env var values with opaque placeholders before passing to workers.
   *
   * Provider credential env vars are set to `"lobu-proxy"` — the proxy resolves
   * the real credential at request time using agentId from the URL path
   * (`/a/{agentId}`) and the provider slug.
   *
   * Non-provider secrets use UUID placeholders stored in Redis.
   */
  private async injectSecretPlaceholders(
    envVars: Record<string, string>,
    agentId: string,
    deploymentName: string
  ): Promise<Record<string, string>> {
    if (!this.redisClient) return envVars;

    // Collect credential env var names from all providers
    const providerCredentialVars = new Set<string>();
    for (const provider of this.providerModules) {
      providerCredentialVars.add(provider.getCredentialEnvVarName());
    }

    let hasSecrets = false;
    for (const [key, value] of Object.entries(envVars)) {
      if (!value || !isSecretEnvVar(key, this.providerModules)) continue;
      if (key === "WORKER_TOKEN") continue;

      if (providerCredentialVars.has(key)) {
        // Provider credentials use a proxy placeholder. The worker never
        // sees real credentials. The proxy resolves the real credential
        // using agentId from the URL path (/a/{agentId}) and the provider
        // slug, then overrides the Authorization header before forwarding.
        envVars[key] = "lobu-proxy";
        hasSecrets = true;
      } else {
        // Use UUID placeholder for non-provider secrets (legacy path)
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
    }

    if (hasSecrets) {
      const proxyUrl = `${this.getDispatcherUrl()}/api/proxy`;
      for (const provider of this.providerModules) {
        Object.assign(
          envVars,
          provider.getProxyBaseUrlMappings(proxyUrl, agentId)
        );
      }
      logger.info(
        `🔐 Generated secret placeholders for ${deploymentName}, routing through proxy`
      );
    }

    return envVars;
  }

  /**
   * Generate environment variables common to all deployment types.
   * Orchestrates the focused helpers above.
   */
  protected async generateEnvironmentVariables(
    username: string,
    userId: string,
    deploymentName: string,
    messageData?: MessagePayload,
    includeSecrets: boolean = true,
    userEnvVars: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const validated = this.validateMessageData(deploymentName, messageData);
    const { conversationId, channelId, platformMetadata, agentId, platform } =
      validated;
    const teamId = validated.teamId || platformMetadata?.teamId;
    const traceId = extractTraceId(validated);

    const workerToken = generateWorkerToken(
      userId,
      conversationId,
      deploymentName,
      { channelId, teamId, platform, agentId, traceId }
    );

    const dispatcherHost = this.getDispatcherHost();
    await this.storeDeploymentConfigs(deploymentName, validated);

    const proxyUrl = this.buildProxyUrl(
      deploymentName,
      workerToken,
      dispatcherHost
    );

    let envVars = this.assembleBaseEnv(
      username,
      userId,
      deploymentName,
      workerToken,
      validated,
      traceId,
      proxyUrl,
      dispatcherHost
    );

    // Include secrets from process.env for Docker deployments
    if (includeSecrets && this.moduleEnvVarsBuilder) {
      try {
        envVars = await this.moduleEnvVarsBuilder(agentId, envVars);
      } catch (error) {
        logger.warn("Failed to build module environment variables:", error);
      }
    }

    // Add worker environment variables from configuration
    if (this.config.worker.env) {
      for (const [key, value] of Object.entries(this.config.worker.env)) {
        envVars[key] = String(value);
      }
    }

    // Merge user environment variables (they take precedence over defaults,
    // except for system-critical vars that must not be overridden)
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

    for (const [key, value] of Object.entries(userEnvVars)) {
      if (!PROTECTED_ENV_VARS.has(key)) {
        envVars[key] = value;
      }
    }

    if (Object.keys(userEnvVars).length > 0) {
      logger.info(
        `Loaded ${Object.keys(userEnvVars).length} user environment variables for ${userId}`
      );
    }

    // Resolve per-agent installed providers (catalog-only when active, no global fallback)
    const effectiveProviders = this.providerCatalogService
      ? await this.providerCatalogService.getInstalledModules(agentId)
      : this.providerModules;

    for (const provider of effectiveProviders) {
      envVars = provider.injectSystemKeyFallback(envVars);
    }

    envVars = await this.injectSecretPlaceholders(
      envVars,
      agentId,
      deploymentName
    );

    // Inject provider metadata into agentOptions so the worker can configure
    // the SDK generically without hardcoded provider checks.
    // Determine primary provider from the model in agentOptions.
    const agentModel = validated.agentOptions?.model as string | undefined;
    let primaryProvider: ModelProviderModule | undefined;

    if (
      agentModel &&
      effectiveProviders.length > 0 &&
      this.providerCatalogService
    ) {
      primaryProvider = await this.providerCatalogService.findProviderForModel(
        agentModel,
        effectiveProviders
      );
    }

    // When no explicit model is set (auto mode), detect the primary provider
    // from installed providers order (first with credentials = primary).
    if (!primaryProvider && effectiveProviders.length > 0) {
      for (const candidate of effectiveProviders) {
        if (
          candidate.hasSystemKey() ||
          (await candidate.hasCredentials(agentId))
        ) {
          primaryProvider = candidate;
          break;
        }
      }
    }

    if (primaryProvider) {
      logger.info(
        {
          agentId,
          primaryProviderId: primaryProvider.providerId,
          slug: primaryProvider.getUpstreamConfig?.()?.slug,
        },
        "Selected primary provider"
      );

      const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
      const mappings = primaryProvider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId
      );
      const providerBaseUrl = Object.values(mappings)[0];
      if (providerBaseUrl) {
        validated.agentOptions = {
          ...validated.agentOptions,
          providerBaseUrl,
        };
      }

      // CREDENTIAL_ENV_VAR_NAME and AGENT_DEFAULT_PROVIDER are now
      // delivered dynamically via session context endpoint. No longer
      // set as static container env vars.
    }

    // Build full provider base URL mappings for all installed providers
    const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      const mappings = provider.getProxyBaseUrlMappings(proxyBaseUrl, agentId);
      Object.assign(providerBaseUrlMappings, mappings);
    }
    if (Object.keys(providerBaseUrlMappings).length > 0) {
      validated.agentOptions = {
        ...validated.agentOptions,
        providerBaseUrlMappings,
      };
    }

    // CLI_BACKENDS is now delivered dynamically via session context.
    // Still need to auto-add npm registry domains for npx at deploy time.
    const hasCliBackendProviders = effectiveProviders.some((p) =>
      p.getCliBackendConfig?.()
    );
    if (hasCliBackendProviders && this.grantStore && agentId) {
      const NPM_DOMAINS = ["registry.npmjs.org", "registry.npmmirror.com"];
      for (const domain of NPM_DOMAINS) {
        await this.grantStore.grant(agentId, domain, null);
      }
      logger.info(
        `Added npm registry domains as grants for ${deploymentName}: ${NPM_DOMAINS.join(", ")}`
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
