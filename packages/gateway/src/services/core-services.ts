#!/usr/bin/env bun

import {
  type AgentAccessStore,
  type AgentConfigStore,
  type AgentConnectionStore,
  CommandRegistry,
  createLogger,
  moduleRegistry,
  type SystemSkillEntry,
} from "@lobu/core";
import { AgentMetadataStore } from "../auth/agent-metadata-store";
import { ApiKeyProviderModule } from "../auth/api-key-provider-module";
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
import { UserAgentsStore } from "../auth/user-agents-store";
import { ChannelBindingService } from "../channels";
import { registerBuiltInCommands } from "../commands/built-in-commands";
import type { AgentConfig, GatewayConfig } from "../config";
import {
  type FileLoadedAgent,
  loadAgentConfigFromFiles,
} from "../config/file-loader";
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
import { InMemoryAgentStore } from "../stores/in-memory-agent-store";
import {
  RedisAgentAccessStore,
  RedisAgentConfigStore,
  RedisAgentConnectionStore,
} from "../stores/redis-agent-store";
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

  // File-first architecture state
  private fileLoadedAgents: FileLoadedAgent[] = [];
  private projectPath: string | null = null;
  private configAgents: AgentConfig[] = [];

  // Options stored for deferred initialization
  private options?: {
    configStore?: AgentConfigStore;
    connectionStore?: AgentConnectionStore;
    accessStore?: AgentAccessStore;
    systemSkills?: SystemSkillEntry[];
  };

  constructor(
    private readonly config: GatewayConfig,
    options?: {
      configStore?: AgentConfigStore;
      connectionStore?: AgentConnectionStore;
      accessStore?: AgentAccessStore;
      systemSkills?: SystemSkillEntry[];
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

    // Initialize grant store for unified permissions
    this.grantStore = new GrantStore(redisClient);
    logger.debug("Grant store initialized");

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

    if (this.fileLoadedAgents.length > 0) {
      for (const agent of this.fileLoadedAgents) {
        await this.syncAgentSettingsToRuntimeStore(
          agent.agentId,
          agent.settings
        );
      }
      logger.debug(
        `Synced settings for ${this.fileLoadedAgents.length} file-loaded agent(s)`
      );
    }

    if (this.configAgents.length > 0) {
      for (const agent of this.configAgents) {
        await this.syncAgentSettingsToRuntimeStore(
          agent.id,
          this.buildSettingsFromAgentConfig(agent)
        );
      }
      logger.debug(
        `Synced settings for ${this.configAgents.length} config agent(s)`
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

    // Seed provider credentials from file-loaded agents
    if (this.authProfilesManager && this.fileLoadedAgents.length > 0) {
      for (const agent of this.fileLoadedAgents) {
        for (const cred of agent.credentials) {
          await this.authProfilesManager.upsertProfile({
            agentId: agent.agentId,
            provider: cred.provider,
            credential: cred.key,
            authType: "api-key",
            label: `${cred.provider} (from lobu.toml)`,
            makePrimary: true,
          });
        }
      }
      logger.debug(
        `Seeded credentials for ${this.fileLoadedAgents.length} file-loaded agent(s)`
      );
    }

    // Seed provider credentials from config agents (embedded mode)
    if (this.authProfilesManager && this.configAgents.length > 0) {
      for (const agent of this.configAgents) {
        for (const provider of agent.providers || []) {
          if (!provider.key) continue;
          await this.authProfilesManager.upsertProfile({
            agentId: agent.id,
            provider: provider.id,
            credential: provider.key,
            authType: "api-key",
            label: `${provider.id} (from config)`,
            makePrimary: true,
          });
        }
      }
      logger.debug(
        `Seeded credentials for ${this.configAgents.length} config agent(s)`
      );
    }

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
      this.systemSkillsService = new SystemSkillsService(
        "config/system-skills.json"
      );
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
    this.commandRegistry = new CommandRegistry();
    registerBuiltInCommands(this.commandRegistry, {
      agentSettingsStore: this.agentSettingsStore,
    });
    logger.debug("Command registry initialized with built-in commands");
  }

  // ============================================================================
  // File-First Helpers
  // ============================================================================

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

  private buildSettingsFromAgentConfig(
    agent: AgentConfig
  ): Record<string, any> {
    const settings: Record<string, any> = {};
    if (agent.identityMd) settings.identityMd = agent.identityMd;
    if (agent.soulMd) settings.soulMd = agent.soulMd;
    if (agent.userMd) settings.userMd = agent.userMd;

    if (agent.providers?.length) {
      settings.installedProviders = agent.providers.map((p) => ({
        providerId: p.id,
        installedAt: Date.now(),
      }));
      settings.modelSelection = { mode: "auto" };
      const providerModelPreferences = Object.fromEntries(
        agent.providers
          .filter((p) => !!p.model?.trim())
          .map((p) => [p.id, p.model!.trim()])
      );
      if (Object.keys(providerModelPreferences).length > 0) {
        settings.providerModelPreferences = providerModelPreferences;
      }
    }

    if (agent.skills?.mcp) {
      settings.mcpServers = agent.skills.mcp;
    }

    if (agent.network) {
      settings.networkConfig = {
        allowedDomains: agent.network.allowed,
        deniedDomains: agent.network.denied,
      };
    }

    if (agent.nixPackages?.length) {
      settings.nixConfig = { packages: agent.nixPackages };
    }

    return settings;
  }

  private async syncAgentSettingsToRuntimeStore(
    agentId: string,
    settings: Record<string, any>
  ): Promise<void> {
    if (!this.agentSettingsStore) {
      throw new Error("Agent settings store must be initialized");
    }

    const existing = await this.agentSettingsStore.getSettings(agentId);
    await this.agentSettingsStore.saveSettings(agentId, {
      ...settings,
      authProfiles: existing?.authProfiles,
      mcpInstallNotified: existing?.mcpInstallNotified,
    });
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
        ...this.buildSettingsFromAgentConfig(agent),
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

    if (this.agentSettingsStore) {
      for (const agent of this.fileLoadedAgents) {
        await this.syncAgentSettingsToRuntimeStore(
          agent.agentId,
          agent.settings
        );
      }
    }

    // Re-seed credentials
    if (this.authProfilesManager) {
      for (const agent of this.fileLoadedAgents) {
        for (const cred of agent.credentials) {
          await this.authProfilesManager.upsertProfile({
            agentId: agent.agentId,
            provider: cred.provider,
            credential: cred.key,
            authType: "api-key",
            label: `${cred.provider} (from lobu.toml)`,
            makePrimary: true,
          });
        }
      }
    }

    const agentIds = this.fileLoadedAgents.map((a) => a.agentId);
    logger.info(`Reloaded ${agentIds.length} agent(s) from files`);
    return { reloaded: true, agents: agentIds };
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

  getExternalAuthClient(): ExternalAuthClient | undefined {
    return this.externalAuthClient;
  }
}
