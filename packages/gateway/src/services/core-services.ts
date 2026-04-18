#!/usr/bin/env bun

import {
  type AgentAccessStore,
  type AgentConfigStore,
  type AgentConnectionStore,
  CommandRegistry,
  createLogger,
  moduleRegistry,
  type ProviderRegistryEntry,
} from "@lobu/core";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module";
import { BedrockProviderModule } from "../auth/bedrock/provider-module";
import { ChatGPTOAuthModule } from "../auth/chatgpt";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module";
import { ExternalAuthClient } from "../auth/external/client";
import { McpConfigService } from "../auth/mcp/config-service";
import { McpProxy } from "../auth/mcp/proxy";
import { McpToolCache } from "../auth/mcp/tool-cache";
import { OAuthClient } from "../auth/oauth/client";
import { CLAUDE_PROVIDER } from "../auth/oauth/providers";
import {
  createOAuthStateStore,
  type ProviderOAuthStateStore,
} from "../auth/oauth/state-store";
import { ProviderCatalogService } from "../auth/provider-catalog";
import { AgentSettingsStore, AuthProfilesManager } from "../auth/settings";
import { ModelPreferenceStore } from "../auth/settings/model-preference-store";
import { UserAuthProfileStore } from "../auth/settings/user-auth-profile-store";
import { UserAgentsStore } from "../auth/user-agents-store";
import { ChannelBindingService } from "../channels";
import { ConversationStateStore } from "../connections/conversation-state-store";
import { createGatewayStateAdapter } from "../connections/state-adapter";
import { registerBuiltInCommands } from "../commands/built-in-commands";
import type { AgentConfig, GatewayConfig } from "../config";
import type { RuntimeProviderCredentialResolver } from "../embedded";
import {
  applyOwlettoMemoryEnvFromProject,
  type FileLoadedAgent,
  loadAgentConfigFromFiles,
} from "../config/file-loader";
import { ArtifactStore } from "../files/artifact-store";
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
  ScheduleService,
  setScheduleServiceInstance,
} from "../orchestration/scheduled-wakeup";
import { GrantStore } from "../permissions/grant-store";
import { SecretProxy } from "../proxy/secret-proxy";
import { TokenRefreshJob } from "../proxy/token-refresh-job";
import {
  AwsSecretsManagerSecretStore,
  RedisSecretStore,
  SecretStoreRegistry,
} from "../secrets";
import { InMemoryAgentStore } from "../stores/in-memory-agent-store";
import {
  RedisAgentAccessStore,
  RedisAgentConfigStore,
  RedisAgentConnectionStore,
} from "../stores/redis-agent-store";
import { BedrockModelCatalog } from "./bedrock-model-catalog";
import { BedrockOpenAIService } from "./bedrock-openai-service";
import {
  buildRegistryMap,
  DeclaredAgentRegistry,
  entryFromAgentConfig,
} from "./declared-agent-registry";
import { ImageGenerationService } from "./image-generation-service";
import { InstructionService } from "./instruction-service";
import { SessionManager, StateAdapterSessionStore } from "./session-manager";
import { SettingsResolver } from "./settings-resolver";
import { ProviderConfigResolver } from "./provider-config-resolver";
import { ProviderRegistryService } from "./provider-registry-service";
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
  private declaredAgentRegistry?: DeclaredAgentRegistry;
  private userAuthProfileStore?: UserAuthProfileStore;
  private modelPreferenceStore?: ModelPreferenceStore;
  private oauthStateStore?: ProviderOAuthStateStore;
  private secretProxy?: SecretProxy;
  private secretStore?: SecretStoreRegistry;
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
  // Bundled Provider Registry
  // ============================================================================
  private providerRegistryService?: ProviderRegistryService;
  private providerConfigResolver?: ProviderConfigResolver;

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
  private bedrockOpenAIService?: BedrockOpenAIService;
  private artifactStore?: ArtifactStore;
  private userAgentsStore?: UserAgentsStore;
  private agentMetadataStore?: AgentMetadataStore;

  // ============================================================================
  // External OAuth
  // ============================================================================
  private externalAuthClient?: ExternalAuthClient;

  // ============================================================================
  // Provider Catalog
  // ============================================================================
  private providerCatalogService?: ProviderCatalogService;

  // ============================================================================
  // Command Registry
  // ============================================================================
  private commandRegistry?: CommandRegistry;

  // ============================================================================
  // Schedule Service
  // ============================================================================
  private scheduleService?: ScheduleService;

  // ============================================================================
  // Agent Sub-Stores (injectable — host can provide its own implementations)
  // ============================================================================
  private configStore?: AgentConfigStore;
  private connectionStore?: AgentConnectionStore;
  private accessStore?: AgentAccessStore;
  private settingsResolver?: SettingsResolver;

  // File-first architecture state
  private fileLoadedAgents: FileLoadedAgent[] = [];
  private projectPath: string | null = null;
  private configAgents: AgentConfig[] = [];

  // Listeners notified when `reloadFromFiles` finishes so downstream
  // caches (e.g. BaseDeploymentManager.grantSyncCache) can drop stale
  // entries for the reloaded agents. Registered by `startGateway`.
  private reloadListeners: Array<(agentIds: string[]) => void> = [];

  // Options stored for deferred initialization
  private options?: {
    configStore?: AgentConfigStore;
    connectionStore?: AgentConnectionStore;
    accessStore?: AgentAccessStore;
    providerRegistry?: ProviderRegistryEntry[];
    secretStore?: SecretStoreRegistry;
    providerCredentialResolver?: RuntimeProviderCredentialResolver;
  };

  constructor(
    private readonly config: GatewayConfig,
    options?: {
      configStore?: AgentConfigStore;
      connectionStore?: AgentConnectionStore;
      accessStore?: AgentAccessStore;
      providerRegistry?: ProviderRegistryEntry[];
      secretStore?: SecretStoreRegistry;
      providerCredentialResolver?: RuntimeProviderCredentialResolver;
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

    // 6. Schedule service (depends on queue)
    await this.initializeScheduleService();
    logger.debug("Schedule service initialized");

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
  // Schedule Service Initialization
  // ============================================================================

  private async initializeScheduleService(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before schedule service");
    }

    this.scheduleService = new ScheduleService(this.queue);
    await this.scheduleService.start();
    setScheduleServiceInstance(this.scheduleService);
    await this.syncDeclaredSchedulesFromFiles();
    logger.debug("Schedule service initialized");
  }

  /**
   * Push the `toml:` namespaced schedules from currently-loaded files into
   * ScheduleService. Called at startup and on every `reloadFromFiles` so the
   * file is the single source of truth for declared schedules.
   */
  private async syncDeclaredSchedulesFromFiles(): Promise<void> {
    if (!this.scheduleService) return;
    const defs = this.fileLoadedAgents.flatMap((a) => a.schedules);
    await this.scheduleService.replaceByPrefix("toml:", defs);
  }

  // ============================================================================
  // 2. Session Services Initialization
  // ============================================================================

  private async initializeSessionServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before session services");
    }

    const redisClient = this.queue.getRedisClient();

    const stateAdapter = await createGatewayStateAdapter(redisClient);
    await stateAdapter.connect();
    const sessionStore = new StateAdapterSessionStore(
      new ConversationStateStore(stateAdapter)
    );
    this.sessionManager = new SessionManager(sessionStore);
    logger.debug("Session manager initialized");

    this.interactionService = new InteractionService();
    logger.debug("Interaction service initialized");

    // Initialize grant store for unified permissions
    this.grantStore = new GrantStore(redisClient);
    logger.debug("Grant store initialized");

    const redisSecretStore = new RedisSecretStore(
      redisClient,
      this.config.secrets.redis.prefix
    );
    this.secretStore =
      this.options?.secretStore ??
      new SecretStoreRegistry(
        redisSecretStore,
        { secret: redisSecretStore },
        {
          readOnlyStores: {
            "aws-sm": new AwsSecretsManagerSecretStore(
              this.config.secrets.aws.region
            ),
          },
        }
      );
    logger.debug("Secret store initialized");

    // Initialize agent configuration stores
    this.agentSettingsStore = new AgentSettingsStore(redisClient);
    this.channelBindingService = new ChannelBindingService(redisClient);
    this.userAgentsStore = new UserAgentsStore(redisClient);
    this.agentMetadataStore = new AgentMetadataStore(redisClient);
    logger.debug(
      "Agent settings, channel binding, user agents & metadata stores initialized"
    );

    // Initialize agent sub-stores
    if (!this.configStore || !this.connectionStore || !this.accessStore) {
      if (this.config.agents?.length) {
        const inMemoryStore = new InMemoryAgentStore();
        if (!this.configStore) this.configStore = inMemoryStore;
        if (!this.connectionStore) this.connectionStore = inMemoryStore;
        if (!this.accessStore) this.accessStore = inMemoryStore;

        await this.populateStoreFromAgentConfigs(
          inMemoryStore,
          this.config.agents
        );
        logger.debug(
          `Agent sub-stores initialized (in-memory, ${this.config.agents.length} agent(s) from config)`
        );
      } else {
        // Check if lobu.toml exists (file-first dev mode)
        const { existsSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const workspaceRoot = process.env.LOBU_WORKSPACE_ROOT?.trim();
        const candidatePaths = [
          ...(workspaceRoot ? [resolve(workspaceRoot, "lobu.toml")] : []),
          resolve(process.cwd(), "lobu.toml"),
          resolve("/app/lobu.toml"),
        ];
        const tomlPath = candidatePaths.find((p) => existsSync(p));

        if (tomlPath) {
          const inMemoryStore = new InMemoryAgentStore();
          if (!this.configStore) this.configStore = inMemoryStore;
          if (!this.connectionStore) this.connectionStore = inMemoryStore;
          if (!this.accessStore) this.accessStore = inMemoryStore;

          // File-first dev mode: use InMemoryAgentStore populated from files
          this.projectPath = resolve(tomlPath, "..");
          await applyOwlettoMemoryEnvFromProject(this.projectPath);

          // Load agents from files and populate store
          this.fileLoadedAgents = await loadAgentConfigFromFiles(
            this.projectPath
          );
          await this.populateStoreFromFiles(
            inMemoryStore,
            this.fileLoadedAgents
          );
          logger.debug(
            `Agent sub-stores initialized (in-memory, ${this.fileLoadedAgents.length} agent(s) from files)`
          );
        } else {
          if (!this.configStore) {
            this.configStore = new RedisAgentConfigStore(
              this.agentSettingsStore,
              this.agentMetadataStore
            );
          }
          if (!this.connectionStore) {
            this.connectionStore = new RedisAgentConnectionStore(
              redisClient,
              this.channelBindingService
            );
          }
          if (!this.accessStore) {
            this.accessStore = new RedisAgentAccessStore(
              this.grantStore,
              this.userAgentsStore
            );
          }
          logger.debug("Agent sub-stores initialized (Redis-backed defaults)");
        }
      }
    } else {
      logger.debug("Using host-provided agent sub-stores (embedded mode)");
    }

    // Create settings resolver (template fallback logic)
    this.settingsResolver = new SettingsResolver(
      this.configStore,
      this.connectionStore
    );

    // Initialize external OAuth client if configured
    this.externalAuthClient =
      ExternalAuthClient.fromEnv(this.config.mcp.publicGatewayUrl, {
        get: (key) => redisClient.get(key),
        set: (key, value, ttlSeconds) =>
          redisClient.setex(key, ttlSeconds, value),
      }) ?? undefined;
    if (this.externalAuthClient) {
      logger.debug("External OAuth client initialized");
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
    if (!this.secretStore) {
      throw new Error("Secret store must be initialized before auth services");
    }

    // Declared registry: read-only snapshot of file/SDK-declared agents.
    // No Redis copy is kept — declared settings live in memory and are
    // rebuilt wholesale on hot-reload.
    this.declaredAgentRegistry = new DeclaredAgentRegistry();
    this.declaredAgentRegistry.replaceAll(
      buildRegistryMap(this.fileLoadedAgents, this.configAgents)
    );
    // Plumb registry into the settings store so getEffectiveSettings
    // returns declared settings for declared agents (no Redis copy exists
    // by design — see one-shot cleanup below).
    this.agentSettingsStore.setDeclaredAgents(this.declaredAgentRegistry);

    // User-scoped auth profile store: durable per-(userId, agentId)
    // OAuth/BYOK state. Replaces the authProfiles field that used to
    // live on AgentSettingsStore.
    this.userAuthProfileStore = new UserAuthProfileStore(
      redisClient,
      this.secretStore
    );

    // One-shot cleanup: declared agents must not have stale Redis settings
    // hanging around. Deleting the key keeps `agent:settings:*` reserved
    // for runtime-created agents only.
    for (const agentId of this.declaredAgentRegistry.agentIds()) {
      try {
        await this.agentSettingsStore.deleteSettings(agentId);
      } catch (error) {
        logger.warn("Failed to clear stale settings for declared agent", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.authProfilesManager = new AuthProfilesManager({
      ephemeralProfiles: this.agentSettingsStore.getEphemeralAuthProfiles(),
      declaredAgents: this.declaredAgentRegistry,
      userAuthProfiles: this.userAuthProfileStore,
      secretStore: this.secretStore,
      runtimeCredentialResolver: this.options?.providerCredentialResolver,
    });
    this.transcriptionService = new TranscriptionService(
      this.authProfilesManager
    );
    this.imageGenerationService = new ImageGenerationService(
      this.authProfilesManager
    );
    this.artifactStore = new ArtifactStore();
    this.modelPreferenceStore = new ModelPreferenceStore(redisClient, "claude");

    // Embedded SDK mode: per-agent in-memory credentials supplied via
    // `provider.key` are exposed as ephemeral profiles. Credentials with
    // a `secretRef` come through the declared registry (no separate
    // ephemeral copy needed).
    if (this.configAgents.length > 0) {
      for (const agent of this.configAgents) {
        for (const provider of agent.providers || []) {
          if (!provider.key || provider.secretRef) continue;
          this.authProfilesManager.registerEphemeralProfile({
            agentId: agent.id,
            provider: provider.id,
            credential: provider.key,
            authType: "api-key",
            label: `${provider.id} (from config)`,
            makePrimary: true,
          });
        }
      }
    }

    logger.debug(
      "Auth profile, model preference, transcription, and image generation services initialized"
    );

    // Initialize secret injection proxy (will be finalized after provider modules are registered)
    this.secretProxy = new SecretProxy(
      {
        defaultUpstreamUrl:
          this.config.anthropicProxy.anthropicBaseUrl ||
          "https://api.anthropic.com",
      },
      this.secretStore
    );
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
    this.tokenRefreshJob = new TokenRefreshJob(this.authProfilesManager, [
      { providerId: "claude", oauthClient: new OAuthClient(CLAUDE_PROVIDER) },
    ]);
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
    const chatgptOAuthModule = new ChatGPTOAuthModule(this.authProfilesManager);
    moduleRegistry.register(chatgptOAuthModule);
    logger.debug(
      `ChatGPT OAuth module registered (system token: ${chatgptOAuthModule.hasSystemKey() ? "available" : "not available"})`
    );

    const bedrockModelCatalog = new BedrockModelCatalog();
    const bedrockProviderModule = new BedrockProviderModule(
      this.authProfilesManager,
      bedrockModelCatalog
    );
    moduleRegistry.register(bedrockProviderModule);
    this.bedrockOpenAIService = new BedrockOpenAIService({
      modelCatalog: bedrockModelCatalog,
    });
    logger.debug("Bedrock provider module registered");

    // Initialize bundled provider registry — use injected providers if
    // provided, else load from config/providers.json.
    const injectedProviders = this.options?.providerRegistry;
    if (injectedProviders) {
      this.providerRegistryService = new ProviderRegistryService(
        undefined,
        injectedProviders
      );
    } else {
      this.providerRegistryService = new ProviderRegistryService(
        "config/providers.json"
      );
    }
    this.providerConfigResolver = new ProviderConfigResolver(
      this.providerRegistryService
    );
    logger.debug("Provider registry service initialized");

    this.transcriptionService?.setProviderConfigSource(() =>
      this.providerConfigResolver
        ? this.providerConfigResolver.getProviderConfigs()
        : Promise.resolve({})
    );

    // Register config-driven providers from the bundled providers registry
    const configProviders =
      await this.providerConfigResolver.getProviderConfigs();
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
        authProfilesManager: this.authProfilesManager,
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
      this.authProfilesManager,
      this.declaredAgentRegistry
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
      configResolver: this.providerConfigResolver,
    });

    this.syncOwlettoMcpFromEnv();

    // Initialize instruction service (needed by WorkerGateway)
    this.instructionService = new InstructionService(
      this.mcpConfigService,
      this.agentSettingsStore
    );
    logger.debug("Instruction service initialized");

    // Initialize MCP tool cache and proxy
    if (!this.secretStore) {
      throw new Error("Secret store must be initialized before MCP proxy");
    }
    const mcpToolCache = new McpToolCache(redisClient);
    this.mcpProxy = new McpProxy(this.mcpConfigService, this.queue, {
      secretStore: this.secretStore,
      toolCache: mcpToolCache,
      grantStore: this.grantStore,
      publicGatewayUrl: this.config.mcp.publicGatewayUrl,
    });
    this.mcpProxy.onToolBlocked = async (
      requestId,
      agentId,
      userId,
      mcpId,
      toolName,
      args,
      grantPattern,
      channelId,
      conversationId,
      teamId,
      connectionId,
      approver
    ) => {
      // Scheduled fires: prefer the schedule's `approver` target if set,
      // so destructive tool calls can still be approved out-of-band even
      // when delivery is headless. Fail closed only when no approver is
      // configured.
      const isHeadlessScheduler =
        userId === "system:scheduler" &&
        (!connectionId || channelId.startsWith("scheduled:"));

      if (isHeadlessScheduler) {
        if (approver?.connectionId && approver.channelId) {
          await this.interactionService?.postToolApproval(
            requestId,
            agentId,
            userId,
            approver.conversationId || approver.channelId,
            approver.channelId,
            approver.teamId,
            approver.connectionId,
            mcpId,
            toolName,
            args,
            grantPattern
          );
          return;
        }
        logger.info(
          { requestId, agentId, mcpId, toolName, grantPattern },
          "tool call blocked for headless scheduled fire — no approver configured"
        );
        return;
      }
      await this.interactionService?.postToolApproval(
        requestId,
        agentId,
        userId,
        conversationId,
        channelId,
        teamId,
        connectionId,
        mcpId,
        toolName,
        args,
        grantPattern
      );
    };
    this.mcpProxy.onAuthRequired = async (
      _agentId,
      userId,
      mcpId,
      payload,
      channelId,
      conversationId,
      teamId,
      connectionId,
      platform
    ) => {
      if (payload.url) {
        await this.interactionService?.postOauthLink(
          userId,
          conversationId,
          channelId,
          teamId,
          connectionId,
          platform || "unknown",
          payload.url,
          `Connect ${mcpId}`,
          `Sign in to ${mcpId} so I can use its tools on your behalf.`
        );
        return;
      }

      await this.interactionService?.postStatusMessage(
        conversationId,
        channelId,
        teamId,
        connectionId,
        platform || "unknown",
        payload.message
      );
    };
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
      this.secretStore
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
    this.commandRegistry = new CommandRegistry();
    registerBuiltInCommands(this.commandRegistry, {
      agentSettingsStore: this.agentSettingsStore,
    });
    logger.debug("Command registry initialized with built-in commands");
  }

  // ============================================================================
  // File-First Helpers
  // ============================================================================

  /**
   * Mirror the resolved `MEMORY_URL` env var into the MCP config service as a
   * global `owletto` server. Without this, requests to `/mcp/owletto` (issued
   * by the Owletto plugin running inside workers) fail with "MCP server
   * 'owletto' not found" because `getHttpServer("owletto")` would otherwise
   * return undefined — the upstream URL only lives in env, not in any
   * agent settings entry.
   *
   * NOTE: do NOT set `oauth: {}` here. Owletto auth is owned by the
   * worker-side `owletto_login` plugin tool (device-code flow). Adding
   * `oauth: {}` would trigger the gateway's MCP OAuth auth-code/PKCE
   * discovery as a parallel flow, producing two competing login links
   * for the user.
   */
  private syncOwlettoMcpFromEnv(): void {
    if (!this.mcpConfigService) return;
    const memoryUrl = process.env.MEMORY_URL?.trim();
    if (!memoryUrl) return;
    this.mcpConfigService.upsertGlobalServer("owletto", {
      url: memoryUrl,
      type: "streamable-http",
    });
  }

  private async populateStoreFromFiles(
    store: InMemoryAgentStore,
    agents: FileLoadedAgent[]
  ): Promise<void> {
    for (const agent of agents) {
      await store.saveMetadata(agent.agentId, {
        agentId: agent.agentId,
        name: agent.name,
        description: agent.description,
        owner: { platform: "system", userId: "manifest" },
        createdAt: Date.now(),
      });
      await store.saveSettings(agent.agentId, {
        ...agent.settings,
        updatedAt: Date.now(),
      } as any);
    }
  }

  private async populateStoreFromAgentConfigs(
    store: InMemoryAgentStore,
    agents: AgentConfig[]
  ): Promise<void> {
    for (const agent of agents) {
      await store.saveMetadata(agent.id, {
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
        owner: { platform: "system", userId: "config" },
        createdAt: Date.now(),
      });
      await store.saveSettings(agent.id, {
        ...entryFromAgentConfig(agent).settings,
        updatedAt: Date.now(),
      } as any);
    }

    // Store agent configs for credential seeding and connection seeding later
    this.configAgents = agents;
  }

  /**
   * Reload agent config from files (dev mode only).
   * Re-reads lobu.toml + markdown, clears and re-populates the in-memory store.
   */
  async reloadFromFiles(): Promise<{ reloaded: boolean; agents: string[] }> {
    if (!this.projectPath) {
      return { reloaded: false, agents: [] };
    }

    await applyOwlettoMemoryEnvFromProject(this.projectPath);
    this.syncOwlettoMcpFromEnv();

    // Re-load from disk
    this.fileLoadedAgents = await loadAgentConfigFromFiles(this.projectPath);

    // Re-populate the in-memory store (clear existing data first)
    if (this.configStore instanceof InMemoryAgentStore) {
      const store = this.configStore as InMemoryAgentStore;
      // Clear existing agents by loading fresh
      const existing = await store.listAgents();
      for (const meta of existing) {
        // Only clear file-managed agents (owner: system/manifest)
        if (
          meta.owner?.platform === "system" &&
          meta.owner?.userId === "manifest"
        ) {
          await store.deleteSettings(meta.agentId);
          await store.deleteMetadata(meta.agentId);
        }
      }
      await this.populateStoreFromFiles(store, this.fileLoadedAgents);
    }

    // Repopulate the declared registry so subsequent credential lookups
    // see the new file-declared providers/keys. No Redis sync, no
    // additive seeding — the registry IS the source of truth.
    if (this.declaredAgentRegistry) {
      this.declaredAgentRegistry.replaceAll(
        buildRegistryMap(this.fileLoadedAgents, this.configAgents)
      );
    }

    // Push the new schedules into ScheduleService. `replaceByPrefix("toml:")`
    // drops any in-memory toml: defs that disappeared from the file.
    await this.syncDeclaredSchedulesFromFiles();

    const agentIds = this.fileLoadedAgents.map((a) => a.agentId);

    // Notify listeners (e.g. the orchestrator's BaseDeploymentManager)
    // so they can drop caches keyed on per-agent config — without this,
    // changes to `networkConfig.allowedDomains` or `preApprovedTools`
    // would be masked by the grantSyncCache hash on the next message.
    for (const listener of this.reloadListeners) {
      try {
        listener(agentIds);
      } catch (error) {
        logger.warn("Reload listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info(`Reloaded ${agentIds.length} agent(s) from files`);
    return { reloaded: true, agents: agentIds };
  }

  /**
   * Register a callback invoked after `reloadFromFiles` completes with the
   * list of reloaded agent ids. Used by `startGateway` to wire the
   * orchestrator's grant-sync cache invalidation into the reload path.
   */
  onReloadFromFiles(listener: (agentIds: string[]) => void): void {
    this.reloadListeners.push(listener);
  }

  getFileLoadedAgents(): FileLoadedAgent[] {
    return this.fileLoadedAgents;
  }

  getConfigAgents(): AgentConfig[] {
    return this.configAgents;
  }

  getProjectPath(): string | null {
    return this.projectPath;
  }

  isFileFirstMode(): boolean {
    return this.projectPath !== null;
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

  getSecretStore(): SecretStoreRegistry {
    if (!this.secretStore) throw new Error("Secret store not initialized");
    return this.secretStore;
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

  getArtifactStore(): ArtifactStore {
    if (!this.artifactStore) throw new Error("Artifact store not initialized");
    return this.artifactStore;
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

  getScheduleService(): ScheduleService | undefined {
    return this.scheduleService;
  }

  getTranscriptionService(): TranscriptionService | undefined {
    return this.transcriptionService;
  }

  getImageGenerationService(): ImageGenerationService | undefined {
    return this.imageGenerationService;
  }

  getBedrockOpenAIService(): BedrockOpenAIService | undefined {
    return this.bedrockOpenAIService;
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

  getDeclaredAgentRegistry(): DeclaredAgentRegistry | undefined {
    return this.declaredAgentRegistry;
  }

  getUserAuthProfileStore(): UserAuthProfileStore | undefined {
    return this.userAuthProfileStore;
  }

  getGrantStore(): GrantStore | undefined {
    return this.grantStore;
  }

  getProviderRegistryService(): ProviderRegistryService | undefined {
    return this.providerRegistryService;
  }

  getProviderConfigResolver(): ProviderConfigResolver | undefined {
    return this.providerConfigResolver;
  }

  getExternalAuthClient(): ExternalAuthClient | undefined {
    return this.externalAuthClient;
  }
}
