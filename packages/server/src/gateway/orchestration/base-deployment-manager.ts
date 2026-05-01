import { createHash } from "node:crypto";
import {
  createLogger,
  ErrorCode,
  extractTraceId,
  generateWorkerToken,
  OrchestratorError,
} from "@lobu/core";
import type { ProviderCredentialContext } from "../embedded.js";
import type { MessagePayload } from "../infrastructure/queue/queue-producer.js";
import type { ModelProviderModule } from "../modules/module-system.js";
import type { GrantStore } from "../permissions/grant-store.js";
import {
  buildPolicyBundle,
  type PolicyStore,
} from "../permissions/policy-store.js";
import {
  deleteSecretMappings,
  generatePlaceholder,
} from "../proxy/secret-proxy.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  type WritableSecretStore,
} from "../secrets/index.js";
// Re-export MessagePayload for use by deployment implementations
export type { MessagePayload };

const logger = createLogger("orchestrator");

/** TTL applied to non-provider secret env var placeholders. */
const SECRET_PLACEHOLDER_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Maximum number of agents tracked in the grant-sync LRU. Oldest entry is
 * evicted when the cache grows past this bound, which prevents unbounded
 * memory growth for long-running gateways that see a large agent churn.
 */
const GRANT_SYNC_CACHE_MAX = 1000;

interface DeploymentIdentity {
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
 * Runtime IDs stay lowercase alphanumeric with hyphens for filesystem and
 * process-manager compatibility.
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
  envVars: Record<string, string>,
  context?: ProviderCredentialContext
) => Promise<Record<string, string>>;

// Orchestrator configuration
export interface OrchestratorConfig {
  queues: {
    retryLimit: number;
    retryDelay: number;
    expireInSeconds: number;
  };
  worker: {
    /**
     * Absolute path to the worker TypeScript entrypoint. Callers compute
     * this once at boot — the gateway never probes cwd or reads env at
     * deployment time.
     */
    entryPoint?: string;
    /**
     * Extra PATH entries prepended when spawning worker processes (e.g.
     * workspace-local `.bin` directories for `tsx`, `bun`). Callers supply
     * absolute paths; the manager uses them verbatim.
     */
    binPathEntries?: string[];
    startupTimeoutSeconds?: number;
    idleCleanupMinutes: number;
    maxDeployments: number;
    env?: Record<string, string | number | boolean>;
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
  protected providerCatalogService?: import("../auth/provider-catalog.js").ProviderCatalogService;
  /**
   * Set by `setSecretStore` during `Orchestrator.injectCoreServices`.
   * `generateEnvironmentVariables` asserts this is present before use.
   */
  protected secretStore?: WritableSecretStore;
  protected grantStore?: GrantStore;
  protected policyStore?: PolicyStore;
  /**
   * Per-agent cache of the last-synced grant pattern set. Used to
   * (a) skip redundant `grantStore.grant()` writes when the set is
   * unchanged and (b) compute the revoke-diff so patterns dropped from
   * `networkConfig.allowedDomains` / `preApprovedTools` are removed from
   * the grant store instead of lingering forever.
   */
  private grantSyncCache = new Map<string, Set<string>>();
  /**
   * In-flight `ensureDeployment` promises keyed by deploymentName. Coalesces
   * concurrent calls within a single gateway process so the orchestrator-
   * specific `spawnDeployment` only runs once per deployment slot. Cross-
   * process concurrency (multi-replica gateway) is handled by the underlying
   * orchestrator's atomic name-uniqueness guarantee — each subclass catches
   * the resulting AlreadyExists error and treats it as benign success.
   */
  private inFlightCreates = new Map<string, Promise<void>>();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    this.config = config;
    this.moduleEnvVarsBuilder = moduleEnvVarsBuilder;
    this.providerModules = providerModules;
  }

  setSecretStore(secretStore: WritableSecretStore): void {
    this.secretStore = secretStore;
  }

  /**
   * Refresh provider modules after module registry initialization.
   */
  setProviderModules(providerModules: ModelProviderModule[]): void {
    this.providerModules = providerModules;
  }

  setProviderCatalogService(
    service: import("../auth/provider-catalog.js").ProviderCatalogService
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
   * Inject policy store for syncing per-agent egress judge rules.
   */
  setPolicyStore(store: PolicyStore): void {
    this.policyStore = store;
  }

  /**
   * Get the dispatcher URL for the worker gateway service (port 8080)
   */
  protected getDispatcherUrl(): string {
    return `http://${this.getDispatcherHost()}:8080`;
  }

  // Abstract methods that must be implemented by concrete classes
  abstract listDeployments(): Promise<DeploymentInfo[]>;
  /**
   * Runtime-specific deployment spawn. Subclasses must implement the
   * actual create call and treat an already-running worker as benign success.
   * Always invoked through `ensureDeployment` which provides in-process
   * coalescing.
   */
  protected abstract spawnDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
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
   * Idempotent deployment ensure: returns the existing deployment if one is
   * already being (or has been) created with this name, otherwise delegates
   * to the orchestrator-specific `spawnDeployment`. Concurrent callers for
   * the same name share a single in-flight promise.
   */
  async ensureDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload
  ): Promise<void> {
    const inFlight = this.inFlightCreates.get(deploymentName);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.spawnDeployment(
      deploymentName,
      username,
      userId,
      messageData
    ).finally(() => {
      this.inFlightCreates.delete(deploymentName);
    });
    this.inFlightCreates.set(deploymentName, promise);
    return promise;
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

      await this.ensureDeployment(deploymentName, userId, userId, messageData);
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
   * Sync per-agent egress judge policies (judgedDomains + named judges +
   * operator extra_policy) into the policy store so the HTTP proxy can
   * resolve them at request time.
   */
  private syncEgressPolicy(
    messageData: MessagePayload,
    deploymentName?: string
  ): void {
    const agentId = messageData.agentId;
    if (!this.policyStore || !agentId) return;

    const bundle = buildPolicyBundle({
      judgedDomains: messageData.networkConfig?.judgedDomains,
      judges: messageData.networkConfig?.judges,
      egressConfig: messageData.egressConfig,
    });
    if (bundle) {
      this.policyStore.set(agentId, bundle);
      if (deploymentName) {
        logger.info(
          `Synced egress judge policy for ${deploymentName}: ${bundle.judgedDomains.length} rule(s), ${Object.keys(bundle.judges).length} judge(s)`
        );
      } else {
        logger.debug("Synced egress judge policy", {
          agentId,
          rules: bundle.judgedDomains.length,
          judges: Object.keys(bundle.judges).length,
        });
      }
    } else {
      this.policyStore.clear(agentId);
    }
  }

  /**
   * Auto-add Nix cache domains as grants, sync per-agent grants (network +
   * pre-approved MCP tools) and egress judge policy, and persist MCP configs
   * for the deployment.
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

    // Sync operator-pre-approved MCP tool patterns to grant store
    if (this.grantStore && agentId && messageData.preApprovedTools?.length) {
      for (const pattern of messageData.preApprovedTools) {
        await this.grantStore.grant(agentId, pattern, null);
      }
      logger.info(
        `Synced pre-approved tool patterns as grants for ${deploymentName}: ${messageData.preApprovedTools.join(", ")}`
      );
    }

    this.syncEgressPolicy(messageData, deploymentName);

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
  }

  /**
   * Sync per-agent grants (network domains + pre-approved MCP tool patterns)
   * to the grant store for a running worker. Called on every message so
   * config changes pick up without redeploying. Also refreshes the in-memory
   * egress judge policy store, which is read by the shared HTTP proxy rather
   * than by the worker process.
   *
   * Computes the diff against the last-synced set per agent:
   *   - patterns in the new set but not the previous are `grant()`-ed
   *   - patterns in the previous set but not the new are `revoke()`-d
   * This means clearing `networkConfig.allowedDomains` or
   * `preApprovedTools` in lobu.toml actually drops access, instead of
   * leaving stale grants in the store.
   */
  async syncNetworkConfigGrants(messageData: MessagePayload): Promise<void> {
    const agentId = messageData.agentId;
    if (!agentId) return;

    this.syncEgressPolicy(messageData);

    if (!this.grantStore) return;

    const nextPatterns = new Set<string>();
    for (const domain of messageData.networkConfig?.allowedDomains ?? []) {
      nextPatterns.add(domain);
    }
    for (const pattern of messageData.preApprovedTools ?? []) {
      nextPatterns.add(pattern);
    }

    const previous = this.grantSyncCache.get(agentId) ?? new Set<string>();

    // Unchanged set → skip the round-trip entirely.
    if (
      nextPatterns.size === previous.size &&
      [...nextPatterns].every((p) => previous.has(p))
    ) {
      return;
    }

    // Revoke patterns that were previously granted but are no longer
    // present in the current config.
    for (const pattern of previous) {
      if (!nextPatterns.has(pattern)) {
        await this.grantStore.revoke(agentId, pattern);
      }
    }

    // Grant any new patterns. Repeating grants for existing patterns is
    // idempotent, but skipping them saves writes.
    for (const pattern of nextPatterns) {
      if (!previous.has(pattern)) {
        await this.grantStore.grant(agentId, pattern, null);
      }
    }

    // LRU touch: delete + re-insert so the agent becomes the newest key.
    this.grantSyncCache.delete(agentId);
    this.grantSyncCache.set(agentId, nextPatterns);

    // Evict the oldest entry if we've exceeded the cap.
    if (this.grantSyncCache.size > GRANT_SYNC_CACHE_MAX) {
      const oldest = this.grantSyncCache.keys().next().value;
      if (oldest !== undefined) {
        this.grantSyncCache.delete(oldest);
      }
    }
  }

  /**
   * Clear the grant sync cache for an agent. Call this when the agent's
   * networkConfig or preApprovedTools change (deployment teardown, config
   * reload) so the next message re-syncs grants.
   */
  invalidateGrantSyncCache(agentId: string): void {
    this.grantSyncCache.delete(agentId);
  }

  /** Clear the entire grant sync cache. Call on whole-config reload. */
  clearAllGrantSyncCaches(): void {
    this.grantSyncCache.clear();
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
      NO_PROXY: `${dispatcherHost},gateway,localhost,127.0.0.1`,
      // Pin HOME inside the persistent workspace so per-tool caches
      // (~/.npm, ~/.cache, ~/.config, ~/.local/share) survive worker restarts
      // without leaking into the gateway host home directory.
      HOME: "/workspace",
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

    // Add OTLP endpoint for distributed tracing
    const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (otlpEndpoint) {
      envVars.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint;
      try {
        const otlpUrl = new URL(otlpEndpoint);
        envVars.NO_PROXY = `${envVars.NO_PROXY},${otlpUrl.hostname}`;
      } catch {
        envVars.NO_PROXY = `${envVars.NO_PROXY},tempo`;
      }
    }

    // Forward WORKER_ENV_* vars to workers with prefix stripped
    const WORKER_ENV_PREFIX = "WORKER_ENV_";
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(WORKER_ENV_PREFIX)) {
        const stripped = key.slice(WORKER_ENV_PREFIX.length);
        if (stripped) {
          envVars[stripped] = process.env[key]!;
        }
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
   * Non-provider secrets use UUID placeholders stored in the secret-proxy.
   */
  private async injectSecretPlaceholders(
    envVars: Record<string, string>,
    agentId: string,
    deploymentName: string,
    context?: ProviderCredentialContext
  ): Promise<Record<string, string>> {
    // Tests that exercise deployment lifecycle without a secret store can
    // skip placeholder injection (no secrets to swap). Previously this short-
    // circuited on the absent redisClient; now the secretStore plays the
    // same role.
    if (!this.secretStore) return envVars;
    const secretStore = this.secretStore;

    // Collect credential env var names from all providers
    const providerCredentialVars = new Set<string>();
    for (const provider of this.providerModules) {
      providerCredentialVars.add(provider.getCredentialEnvVarName());
    }

    let hasSecrets = false;
    const workerToken = envVars.WORKER_TOKEN;
    for (const [key, value] of Object.entries(envVars)) {
      if (!value || !isSecretEnvVar(key, this.providerModules)) continue;
      if (key === "WORKER_TOKEN") continue;
      // Some providers (e.g. Bedrock) authenticate workers by JWT and
      // legitimately put the worker's own WORKER_TOKEN into the credential
      // env var — the gateway verifies it on the incoming request. In that
      // case we must not swap the value for a placeholder; the worker needs
      // the real JWT to call the gateway route.
      if (workerToken && value === workerToken) continue;

      if (providerCredentialVars.has(key)) {
        // Provider credentials use a proxy placeholder. The worker never
        // sees real credentials. The proxy resolves the real credential
        // using agentId from the URL path (/a/{agentId}) and the provider
        // slug, then overrides the Authorization header before forwarding.
        const ownerProvider = this.providerModules.find(
          (p) => p.getCredentialEnvVarName() === key
        );
        if (ownerProvider?.buildCredentialPlaceholder) {
          envVars[key] = await ownerProvider.buildCredentialPlaceholder(
            agentId,
            context
          );
        } else {
          envVars[key] = "lobu-proxy";
        }
        hasSecrets = true;
      } else {
        // Custom env var secrets (non-provider): move the value into the
        // secret store and hand the worker an opaque UUID placeholder.
        try {
          const secretRef = await persistSecretValue(
            secretStore,
            `deployments/${deploymentName}/${agentId}/${key}`,
            value,
            { ttlSeconds: SECRET_PLACEHOLDER_TTL_SECONDS }
          );
          if (!secretRef) continue;
          const placeholder = generatePlaceholder(
            agentId,
            key,
            secretRef,
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
    includeSecrets: boolean = true
  ): Promise<Record<string, string>> {
    const validated = this.validateMessageData(deploymentName, messageData);
    const { conversationId, channelId, platformMetadata, agentId, platform } =
      validated;
    const teamId = validated.teamId || platformMetadata?.teamId;
    const traceId = extractTraceId(validated);
    const providerContext: ProviderCredentialContext = {
      userId,
      conversationId,
      channelId,
      deploymentName,
      platform,
      connectionId:
        typeof platformMetadata?.connectionId === "string"
          ? platformMetadata.connectionId
          : undefined,
    };

    const workerToken = generateWorkerToken(
      userId,
      conversationId,
      deploymentName,
      {
        channelId,
        teamId,
        platform,
        agentId,
        connectionId:
          typeof platformMetadata?.connectionId === "string"
            ? platformMetadata.connectionId
            : undefined,
        traceId,
      }
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

    // Include host-provided secret references when requested.
    if (includeSecrets && this.moduleEnvVarsBuilder) {
      try {
        envVars = await this.moduleEnvVarsBuilder(
          agentId,
          envVars,
          providerContext
        );
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
      deploymentName,
      providerContext
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
          (await candidate.hasCredentials(agentId, providerContext))
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
      // delivered dynamically via the session context endpoint instead of
      // static process environment.
    }

    // Build full provider base URL mappings for all installed providers
    const proxyBaseUrl = `${this.getDispatcherUrl()}/api/proxy`;
    const providerBaseUrlMappings: Record<string, string> = {};
    for (const provider of effectiveProviders) {
      const mappings = provider.getProxyBaseUrlMappings(
        proxyBaseUrl,
        agentId,
        providerContext
      );
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
      // Clean up secret placeholder mappings
      deleteSecretMappings(deploymentName);

      // Cascade-delete the underlying non-provider secrets written by
      // `injectSecretPlaceholders` under `deployments/{deploymentName}/`.
      // Without this, the placeholder mappings are gone but the backing
      // secret entries linger until their 7-day TTL expires (and AWS SM
      // entries would leak forever).
      if (this.secretStore) {
        try {
          const cleared = await deleteSecretsByPrefix(
            this.secretStore,
            `deployments/${deploymentName}/`
          );
          if (cleared > 0) {
            logger.debug(
              `Cleared ${cleared} deployment secret(s) for ${deploymentName}`
            );
          }
        } catch (error) {
          logger.warn(
            `Failed to clear deployment secrets for ${deploymentName}:`,
            error
          );
        }
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

      logger.debug("Running deployment cleanup...");

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
          if (results[j]?.status === "fulfilled") {
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
          if (results[j]?.status === "fulfilled") {
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
