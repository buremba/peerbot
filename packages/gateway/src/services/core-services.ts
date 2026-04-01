#!/usr/bin/env bun

import {
  type AgentAccessStore,
  type AgentConfigStore,
  type AgentConnectionStore,
  CommandRegistry,
  createLogger,
  moduleRegistry,
  type RegistryEntry,
  type SystemSkillEntry,
} from "@lobu/core";
import { AdminStatusCache } from "../auth/admin-status-cache";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module";
import { ChatGPTOAuthModule } from "../auth/chatgpt";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module";
import { McpConfigService } from "../auth/mcp/config-service";
import { McpProxy } from "../auth/mcp/proxy";
import { McpToolCache } from "../auth/mcp/tool-cache";
import { OAuthClient } from "../auth/oauth/client";
import { CLAUDE_PROVIDER } from "../auth/oauth/providers";
import {
  createOAuthStateStore,
  OAuthStateStore,
  type ProviderOAuthStateStore,
} from "../auth/oauth/state-store";
import { ProviderCatalogService } from "../auth/provider-catalog";
import { AgentSettingsStore, AuthProfilesManager } from "../auth/settings";
import { ClaimService } from "../auth/settings/claim-service";
import { ModelPreferenceStore } from "../auth/settings/model-preference-store";
import { SettingsOAuthClient } from "../auth/settings/oauth-client";
import { UserAgentsStore } from "../auth/user-agents-store";
import { ChannelBindingService } from "../channels";
import { registerBuiltInCommands } from "../commands/built-in-commands";
import type { GatewayConfig } from "../config";
import { WorkerGateway } from "../gateway";
import type { IMessageQueue } from "../infrastructure/queue";
import {
  QueueProducer,
  RedisQueue,
  type RedisQueueConfig,
} from "../infrastructure/queue";
import { InteractionService } from "../interactions";
import { getModelProviderModules } from "../modules/module-system";
import {
  ScheduledWakeupService,
  setScheduledWakeupService,
} from "../orchestration/scheduled-wakeup";
import { GrantStore } from "../permissions/grant-store";
import { SecretProxy } from "../proxy/secret-proxy";
import { TokenRefreshJob } from "../proxy/token-refresh-job";
import { seedAgentsFromManifest } from "./agent-seeder";
import { ImageGenerationService } from "./image-generation-service";
import { InstructionService } from "./instruction-service";
import { RedisSessionStore, SessionManager } from "./session-manager";
import { SettingsResolver } from "./settings-resolver";
import { SystemConfigResolver } from "./system-config-resolver";
import { SystemSkillsService } from "./system-skills-service";
import { TranscriptionService } from "./transcription-service";

const logger = createLogger("core-services");

/**
 * Core Services - Centralized service initialization and lifecycle management
 */
export class CoreServices {
  // ============================================================================
  // Queue Services
  // ============================================================================
  private queue?: IMessageQueue;
  private queueProducer?: QueueProducer;

  // ============================================================================
  // Session Services
  // ============================================================================
  private sessionManager?: SessionManager;
  private instructionService?: InstructionService;
  private interactionService?: InteractionService;

  // ============================================================================
  // Auth & Provider Services
  // ============================================================================
  private authProfilesManager?: AuthProfilesManager;
  private modelPreferenceStore?: ModelPreferenceStore;
  private oauthStateStore?: ProviderOAuthStateStore;
  private secretProxy?: SecretProxy;
  private tokenRefreshJob?: TokenRefreshJob;

  // ============================================================================
  // MCP Services
  // ============================================================================
  private mcpConfigService?: McpConfigService;
  private mcpProxy?: McpProxy;

  // ============================================================================
  // Permissions
  // ============================================================================
  private grantStore?: GrantStore;

  // ============================================================================
  // System Skills Service
  // ============================================================================
  private systemSkillsService?: SystemSkillsService;
  private systemConfigResolver?: SystemConfigResolver;

  // ============================================================================
  // Worker Gateway
  // ============================================================================
  private workerGateway?: WorkerGateway;

  // ============================================================================
  // Agent Configuration Services
  // ============================================================================
  private agentSettingsStore?: AgentSettingsStore;
  private channelBindingService?: ChannelBindingService;
  private transcriptionService?: TranscriptionService;
  private imageGenerationService?: ImageGenerationService;
  private userAgentsStore?: UserAgentsStore;
  private agentMetadataStore?: AgentMetadataStore;
  private adminStatusCache?: AdminStatusCache;

  // ============================================================================
  // Settings OAuth
  // ============================================================================
  private claimService?: ClaimService;
  private settingsOAuthClient?: SettingsOAuthClient;
  private settingsOAuthStateStore?: OAuthStateStore<{
    userId: string;
    codeVerifier: string;
    returnUrl: string;
  }>;

  // ============================================================================
  // Provider Catalog
  // ============================================================================
  private providerCatalogService?: ProviderCatalogService;

  // ============================================================================
  // Command Registry
  // ============================================================================
  private commandRegistry?: CommandRegistry;

  // ============================================================================
  // Scheduled Wakeup Service
  // ============================================================================
  private scheduledWakeupService?: ScheduledWakeupService;

  // ============================================================================
  // Agent Sub-Stores (injectable — host can provide its own implementations)
  // ============================================================================
  private configStore?: AgentConfigStore;
  private connectionStore?: AgentConnectionStore;
  private accessStore?: AgentAccessStore;
  private settingsResolver?: SettingsResolver;

  // Options stored for deferred initialization
  private options?: {
    configStore?: AgentConfigStore;
    connectionStore?: AgentConnectionStore;
    accessStore?: AgentAccessStore;
    systemSkills?: SystemSkillEntry[];
    skillRegistries?: RegistryEntry[];
  };

  constructor(
    private readonly config: GatewayConfig,
    options?: {
      configStore?: AgentConfigStore;
      connectionStore?: AgentConnectionStore;
      accessStore?: AgentAccessStore;
      systemSkills?: SystemSkillEntry[];
      skillRegistries?: RegistryEntry[];
    }
  ) {
    this.options = options;
    if (options?.configStore) this.configStore = options.configStore;
    if (options?.connectionStore)
      this.connectionStore = options.connectionStore;
    if (options?.accessStore) this.accessStore = options.accessStore;
  }

  getConfigStore(): AgentConfigStore | undefined {
    return this.configStore;
  }

  getConnectionStore(): AgentConnectionStore | undefined {
    return this.connectionStore;
  }

  getAccessStore(): AgentAccessStore | undefined {
    return this.accessStore;
  }

  getSettingsResolver(): SettingsResolver | undefined {
    return this.settingsResolver;
  }

  getSkillRegistryConfigs(): RegistryEntry[] | undefined {
    return this.options?.skillRegistries;
  }

  /**
   * Initialize all core services in dependency order
   */
  async initialize(): Promise<void> {
    logger.debug("Initializing core services...");

    // 1. Queue (foundation for everything else)
    await this.initializeQueue();
    logger.debug("Queue initialized");

    // 2. Session management
    await this.initializeSessionServices();
    logger.debug("Session services initialized");

    // 3. Auth & provider services
    await this.initializeClaudeServices();
    logger.debug("Auth & provider services initialized");

    // 4. MCP ecosystem (depends on queue and Claude services)
    await this.initializeMcpServices();
    logger.debug("MCP services initialized");

    // 5. Queue producer (depends on queue being ready)
    await this.initializeQueueProducer();
    logger.debug("Queue producer initialized");

    // 6. Scheduled wakeup service (depends on queue)
    await this.initializeScheduledWakeupService();
    logger.debug("Scheduled wakeup service initialized");

    // 7. Command registry (depends on agent settings store)
    this.initializeCommandRegistry();
    logger.debug("Command registry initialized");

    logger.info("Core services initialized successfully");
  }

  // ============================================================================
  // 1. Queue Services Initialization
  // ============================================================================

  private async initializeQueue(): Promise<void> {
    if (!this.config.queues?.connectionString) {
      throw new Error("Queue connection string is required");
    }

    const url = new URL(this.config.queues.connectionString);
    if (url.protocol !== "redis:") {
      throw new Error(
        `Unsupported queue protocol: ${url.protocol}. Only redis:// is supported.`
      );
    }

    const config: RedisQueueConfig = {
      host: url.hostname,
      port: Number.parseInt(url.port, 10) || 6379,
      password: url.password || undefined,
      db: url.pathname ? Number.parseInt(url.pathname.slice(1), 10) : 0,
      maxRetriesPerRequest: 3,
    };

    this.queue = new RedisQueue(config);
    await this.queue.start();
    logger.debug("Queue connection established");
  }

  private async initializeQueueProducer(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before queue producer");
    }

    this.queueProducer = new QueueProducer(this.queue);
    await this.queueProducer.start();
    logger.debug("Queue producer initialized");
  }

  // ============================================================================
  // Scheduled Wakeup Service Initialization
  // ============================================================================

  private async initializeScheduledWakeupService(): Promise<void> {
    if (!this.queue) {
      throw new Error(
        "Queue must be initialized before scheduled wakeup service"
      );
    }

    this.scheduledWakeupService = new ScheduledWakeupService(this.queue);
    await this.scheduledWakeupService.start();
    // Set global reference for BaseDeploymentManager cleanup
    setScheduledWakeupService(this.scheduledWakeupService);
    logger.debug("Scheduled wakeup service initialized");
  }

  // ============================================================================
  // 2. Session Services Initialization
  // ============================================================================

  private async initializeSessionServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before session services");
    }

    const redisClient = this.queue.getRedisClient();

    const sessionStore = new RedisSessionStore(this.queue);
    this.sessionManager = new SessionManager(sessionStore);
    logger.debug("Session manager initialized");

    this.interactionService = new InteractionService();
    logger.debug("Interaction service initialized");

    // Initialize agent sub-stores — default missing ones to Redis
    if (!this.configStore || !this.connectionStore || !this.accessStore) {
      const { RedisAgentStore } = await import("../stores/redis-agent-store");
      const redisStore = new RedisAgentStore(redisClient);
      if (!this.configStore) this.configStore = redisStore;
      if (!this.connectionStore) this.connectionStore = redisStore;
      if (!this.accessStore) this.accessStore = redisStore;
      logger.debug("Agent sub-stores initialized (Redis defaults for missing)");
    } else {
      logger.debug("Using host-provided agent sub-stores (embedded mode)");
    }

    // Create settings resolver (template fallback logic)
    this.settingsResolver = new SettingsResolver(
      this.configStore,
      this.connectionStore
    );

    // Initialize grant store for unified permissions
    this.grantStore = new GrantStore(redisClient);
    logger.debug("Grant store initialized");

    // Initialize agent configuration stores
    this.agentSettingsStore = new AgentSettingsStore(redisClient);
    this.channelBindingService = new ChannelBindingService(redisClient);
    this.userAgentsStore = new UserAgentsStore(redisClient);
    this.agentMetadataStore = new AgentMetadataStore(redisClient);
    this.adminStatusCache = new AdminStatusCache(redisClient);
    logger.debug(
      "Agent settings, channel binding, user agents & metadata stores initialized"
    );

    // Initialize claim service (always available, used by OAuth settings flow)
    this.claimService = new ClaimService(redisClient);
    logger.debug("Claim service initialized");

    // Initialize settings OAuth client if configured
    this.settingsOAuthClient =
      SettingsOAuthClient.fromEnv(this.config.mcp.publicGatewayUrl, {
        get: (key) => redisClient.get(key),
        set: (key, value, ttlSeconds) =>
          redisClient.setex(key, ttlSeconds, value),
      }) ?? undefined;
    if (this.settingsOAuthClient) {
      this.settingsOAuthStateStore = new OAuthStateStore(
        redisClient,
        "settings:oauth:state",
        "settings-oauth-state"
      );
      logger.debug("Settings OAuth client initialized");
    }
  }

  // ============================================================================
  // 3. Auth & Provider Services Initialization
  // ============================================================================

  private async initializeClaudeServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before auth services");
    }

    const redisClient = this.queue.getRedisClient();

    if (!this.agentSettingsStore) {
      throw new Error(
        "Agent settings store must be initialized before auth services"
      );
    }

    // Initialize auth profile and preference stores
    this.authProfilesManager = new AuthProfilesManager(this.agentSettingsStore);
    this.transcriptionService = new TranscriptionService(
      this.authProfilesManager
    );
    this.imageGenerationService = new ImageGenerationService(
      this.authProfilesManager
    );
    this.modelPreferenceStore = new ModelPreferenceStore(redisClient, "claude");

    // Seed agents from .lobu/agents.json manifest (CLI-managed projects)
    await seedAgentsFromManifest(this.configStore!, this.authProfilesManager);

    logger.debug(
      "Auth profile, model preference, transcription, and image generation services initialized"
    );

    // Initialize secret injection proxy (will be finalized after provider modules are registered)
    this.secretProxy = new SecretProxy({
      defaultUpstreamUrl:
        this.config.anthropicProxy.anthropicBaseUrl ||
        "https://api.anthropic.com",
    });
    this.secretProxy.initialize(redisClient);
    logger.debug(
      `Secret proxy initialized (upstream: ${this.config.anthropicProxy.anthropicBaseUrl || "https://api.anthropic.com"})`
    );

    // Start background token refresh job
    if (!this.authProfilesManager) {
      throw new Error(
        "Auth profiles manager must be initialized before token refresh job"
      );
    }
    this.tokenRefreshJob = new TokenRefreshJob(
      this.authProfilesManager,
      redisClient,
      [{ providerId: "claude", oauthClient: new OAuthClient(CLAUDE_PROVIDER) }]
    );
    this.tokenRefreshJob.start();
    logger.debug("Token refresh job started");

    // Register Claude OAuth module
    this.oauthStateStore = createOAuthStateStore("claude", redisClient);
    const claudeOAuthModule = new ClaudeOAuthModule(
      this.authProfilesManager,
      this.modelPreferenceStore
    );
    moduleRegistry.register(claudeOAuthModule);
    logger.debug(
      `Claude OAuth module registered (system token: ${claudeOAuthModule.hasSystemKey() ? "available" : "not available"})`
    );

    // Register ChatGPT OAuth module
    const chatgptOAuthModule = new ChatGPTOAuthModule(this.agentSettingsStore);
    moduleRegistry.register(chatgptOAuthModule);
    logger.debug(
      `ChatGPT OAuth module registered (system token: ${chatgptOAuthModule.hasSystemKey() ? "available" : "not available"})`
    );

    // Initialize system skills — use injected skills if provided, else load from file
    if (this.options?.systemSkills) {
      this.systemSkillsService = new SystemSkillsService(
        undefined,
        this.options.systemSkills
      );
    } else {
      let systemSkillsUrl = "config/system-skills.json";
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const configPath = resolve(
          process.cwd(),
          "config/skill-registries.json"
        );
        if (existsSync(configPath)) {
          const raw = JSON.parse(readFileSync(configPath, "utf-8"));
          const lobuEntry = (raw.registries || []).find(
            (r: any) => r.type === "lobu"
          );
          if (lobuEntry?.apiUrl) {
            systemSkillsUrl = lobuEntry.apiUrl;
          }
        }
      } catch (error) {
        logger.warn("Failed to read skill registries config", { error });
      }
      this.systemSkillsService = new SystemSkillsService(systemSkillsUrl);
    }
    this.systemConfigResolver = new SystemConfigResolver(
      this.systemSkillsService
    );
    logger.debug("System skills service initialized");

    this.transcriptionService?.setProviderConfigSource(() =>
      this.systemConfigResolver
        ? this.systemConfigResolver.getProviderConfigs()
        : Promise.resolve({})
    );

    // Register config-driven providers from system skills
    const configProviders =
      await this.systemConfigResolver.getProviderConfigs();
    const registeredIds = new Set(
      getModelProviderModules().map((m) => m.providerId)
    );
    for (const [id, entry] of Object.entries(configProviders)) {
      if (registeredIds.has(id)) {
        logger.info(
          `Skipping config-driven provider "${id}" — already registered`
        );
        continue;
      }
      const module = new ApiKeyProviderModule({
        providerId: id,
        providerDisplayName: entry.displayName,
        providerIconUrl: entry.iconUrl,
        envVarName: entry.envVarName,
        slug: id,
        upstreamBaseUrl: entry.upstreamBaseUrl,
        modelsEndpoint: entry.modelsEndpoint,
        sdkCompat: entry.sdkCompat,
        defaultModel: entry.defaultModel,
        registryAlias: entry.registryAlias,
        apiKeyInstructions: entry.apiKeyInstructions,
        apiKeyPlaceholder: entry.apiKeyPlaceholder,
        agentSettingsStore: this.agentSettingsStore,
      });
      moduleRegistry.register(module);
      registeredIds.add(id);
      logger.debug(
        `Registered config-driven provider: ${id} (system key: ${module.hasSystemKey() ? "available" : "not available"})`
      );
    }

    // Initialize provider catalog service
    this.providerCatalogService = new ProviderCatalogService(
      this.agentSettingsStore,
      this.authProfilesManager
    );
    logger.debug("Provider catalog service initialized");

    // Register provider upstream configs with the secret proxy for path-based routing
    if (this.secretProxy) {
      this.secretProxy.setAuthProfilesManager(this.authProfilesManager);
      for (const provider of getModelProviderModules()) {
        const upstream = provider.getUpstreamConfig?.();
        if (upstream) {
          this.secretProxy.registerUpstream(upstream, provider.providerId);
        }
      }
      // Register system key resolver for fallback when no per-agent auth profile exists
      const modules = getModelProviderModules();
      this.secretProxy.setSystemKeyResolver((providerId: string) => {
        const mod = modules.find((m) => m.providerId === providerId);
        if (!mod) return undefined;
        // Use the module's injectSystemKeyFallback to resolve the system key.
        // The fallback may inject into a different env var than credentialEnvVarName
        // (e.g., Claude injects ANTHROPIC_API_KEY, not CLAUDE_CODE_OAUTH_TOKEN),
        // so check all secret env var names.
        const testEnv: Record<string, string> = {};
        mod.injectSystemKeyFallback(testEnv);
        for (const varName of mod.getSecretEnvVarNames()) {
          if (testEnv[varName]) return testEnv[varName];
        }
        return testEnv[mod.getCredentialEnvVarName()] || undefined;
      });
      logger.debug("Provider upstreams registered with secret proxy");
    }
  }

  // ============================================================================
  // 4. MCP Services Initialization
  // ============================================================================

  private async initializeMcpServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before MCP services");
    }

    const redisClient = this.queue.getRedisClient();

    // Initialize simplified MCP config service (no OAuth discovery)
    this.mcpConfigService = new McpConfigService({
      agentSettingsStore: this.agentSettingsStore,
      configResolver: this.systemConfigResolver,
    });

    // Initialize instruction service (needed by WorkerGateway)
    this.instructionService = new InstructionService(
      this.mcpConfigService,
      this.agentSettingsStore
    );
    logger.debug("Instruction service initialized");

    // Initialize MCP tool cache and proxy
    const mcpToolCache = new McpToolCache(redisClient);
    this.mcpProxy = new McpProxy(
      this.mcpConfigService,
      this.queue,
      mcpToolCache,
      this.grantStore
    );
    logger.debug("MCP proxy initialized");

    // Initialize worker gateway
    if (!this.sessionManager) {
      throw new Error(
        "Session manager must be initialized before worker gateway"
      );
    }
    this.workerGateway = new WorkerGateway(
      this.queue,
      this.config.mcp.publicGatewayUrl,
      this.sessionManager,
      this.mcpConfigService,
      this.instructionService,
      this.mcpProxy,
      this.providerCatalogService,
      this.settingsResolver,
      this.systemSkillsService
    );
    logger.debug("Worker gateway initialized");

    // Discover and initialize all available modules
    await moduleRegistry.registerAvailableModules();
    await moduleRegistry.initAll();
    logger.debug("Modules initialized");
  }

  // ============================================================================
  // 7. Command Registry Initialization
  // ============================================================================

  private initializeCommandRegistry(): void {
    if (!this.agentSettingsStore) {
      throw new Error(
        "Agent settings store must be initialized before command registry"
      );
    }
    if (!this.claimService) {
      throw new Error(
        "Claim service must be initialized before command registry"
      );
    }

    this.commandRegistry = new CommandRegistry();
    registerBuiltInCommands(this.commandRegistry, {
      agentSettingsStore: this.agentSettingsStore,
      claimService: this.claimService,
    });
    logger.debug("Command registry initialized with built-in commands");
  }

  // ============================================================================
  // Shutdown
  // ============================================================================

  async shutdown(): Promise<void> {
    logger.info("Shutting down core services...");

    if (this.tokenRefreshJob) {
      this.tokenRefreshJob.stop();
    }

    if (this.queueProducer) {
      await this.queueProducer.stop();
    }

    if (this.workerGateway) {
      this.workerGateway.shutdown();
      logger.info("Worker gateway shutdown complete");
    }

    if (this.queue) {
      await this.queue.stop();
    }

    logger.info("Core services shutdown complete");
  }

  // ============================================================================
  // Service Accessors (implements ICoreServices interface)
  // ============================================================================

  getQueue(): IMessageQueue {
    if (!this.queue) throw new Error("Queue not initialized");
    return this.queue;
  }

  getQueueProducer(): QueueProducer {
    if (!this.queueProducer) throw new Error("Queue producer not initialized");
    return this.queueProducer;
  }

  getSecretProxy(): SecretProxy | undefined {
    return this.secretProxy;
  }

  getWorkerGateway(): WorkerGateway | undefined {
    return this.workerGateway;
  }

  getMcpProxy(): McpProxy | undefined {
    return this.mcpProxy;
  }

  getMcpConfigService(): McpConfigService | undefined {
    return this.mcpConfigService;
  }

  getModelPreferenceStore(): ModelPreferenceStore | undefined {
    return this.modelPreferenceStore;
  }

  getOAuthStateStore(): ProviderOAuthStateStore | undefined {
    return this.oauthStateStore;
  }

  getPublicGatewayUrl(): string {
    return this.config.mcp.publicGatewayUrl;
  }

  getSessionManager(): SessionManager {
    if (!this.sessionManager)
      throw new Error("Session manager not initialized");
    return this.sessionManager;
  }

  getInstructionService(): InstructionService | undefined {
    return this.instructionService;
  }

  getInteractionService(): InteractionService {
    if (!this.interactionService)
      throw new Error("Interaction service not initialized");
    return this.interactionService;
  }

  getAgentSettingsStore(): AgentSettingsStore {
    if (!this.agentSettingsStore)
      throw new Error("Agent settings store not initialized");
    return this.agentSettingsStore;
  }

  getChannelBindingService(): ChannelBindingService {
    if (!this.channelBindingService)
      throw new Error("Channel binding service not initialized");
    return this.channelBindingService;
  }

  getScheduledWakeupService(): ScheduledWakeupService | undefined {
    return this.scheduledWakeupService;
  }

  getTranscriptionService(): TranscriptionService | undefined {
    return this.transcriptionService;
  }

  getImageGenerationService(): ImageGenerationService | undefined {
    return this.imageGenerationService;
  }

  getUserAgentsStore(): UserAgentsStore {
    if (!this.userAgentsStore)
      throw new Error("User agents store not initialized");
    return this.userAgentsStore;
  }

  getAgentMetadataStore(): AgentMetadataStore {
    if (!this.agentMetadataStore)
      throw new Error("Agent metadata store not initialized");
    return this.agentMetadataStore;
  }

  getAdminStatusCache(): AdminStatusCache {
    if (!this.adminStatusCache)
      throw new Error("Admin status cache not initialized");
    return this.adminStatusCache;
  }

  getCommandRegistry(): CommandRegistry {
    if (!this.commandRegistry)
      throw new Error("Command registry not initialized");
    return this.commandRegistry;
  }

  getProviderCatalogService(): ProviderCatalogService {
    if (!this.providerCatalogService)
      throw new Error("Provider catalog service not initialized");
    return this.providerCatalogService;
  }

  getAuthProfilesManager(): AuthProfilesManager | undefined {
    return this.authProfilesManager;
  }

  getGrantStore(): GrantStore | undefined {
    return this.grantStore;
  }

  getSystemSkillsService(): SystemSkillsService | undefined {
    return this.systemSkillsService;
  }

  getSystemConfigResolver(): SystemConfigResolver | undefined {
    return this.systemConfigResolver;
  }

  getClaimService(): ClaimService | undefined {
    return this.claimService;
  }

  getSettingsOAuthClient(): SettingsOAuthClient | undefined {
    return this.settingsOAuthClient;
  }

  getSettingsOAuthStateStore():
    | OAuthStateStore<{
        userId: string;
        codeVerifier: string;
        returnUrl: string;
      }>
    | undefined {
    return this.settingsOAuthStateStore;
  }
}
