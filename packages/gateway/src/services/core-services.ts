#!/usr/bin/env bun

import { createLogger, moduleRegistry } from "@peerbot/core";
import { ClaudeCredentialStore } from "../auth/claude/credential-store";
import { ClaudeModelPreferenceStore } from "../auth/claude/model-preference-store";
import { ClaudeOAuthModule } from "../auth/claude/oauth-module";
import { ClaudeOAuthStateStore } from "../auth/claude/oauth-state-store";
import { McpConfigService } from "../auth/mcp/config-service";
import { McpCredentialStore } from "../auth/mcp/credential-store";
import { McpInputStore } from "../auth/mcp/input-store";
import { mcpConfigStore } from "../auth/mcp/mcp-config-store";
import { McpOAuthModule } from "../auth/mcp/oauth-module";
import { McpOAuthStateStore } from "../auth/mcp/oauth-state-store";
import { McpProxy } from "../auth/mcp/proxy";
import { OAuthDiscoveryService } from "../auth/oauth/discovery";
import { AgentSettingsStore } from "../auth/settings";
import { ChannelBindingService } from "../channels";
import type { GatewayConfig } from "../config";
import { WorkerGateway } from "../gateway";
import { AnthropicProxy } from "../infrastructure/model-provider";
import type { IMessageQueue } from "../infrastructure/queue";
import {
  QueueProducer,
  RedisQueue,
  type RedisQueueConfig,
} from "../infrastructure/queue";
import { InteractionService } from "../interactions";
import { GitFilesystemModule } from "../modules/git-filesystem";
import {
  ScheduledWakeupService,
  setScheduledWakeupService,
} from "../orchestration/scheduled-wakeup";
import { networkConfigStore } from "../proxy/network-config-store";
import { InstructionService } from "./instruction-service";
import { RedisSessionStore, SessionManager } from "./session-manager";

const logger = createLogger("core-services");

/**
 * Core Services - Centralized service initialization and lifecycle management
 *
 * Manages all platform-agnostic services shared across platform adapters.
 * Organized into logical groups:
 *
 * 1. Queue Services: Redis queue and producer for job management
 * 2. Session Services: Session tracking and instruction providers
 * 3. Claude Services: OAuth, credentials, model preferences, Anthropic proxy
 * 4. MCP Services: Config, discovery, OAuth, proxy for Model Context Protocol
 * 5. Worker Gateway: Worker connection management and routing
 *
 * Initialization order is important - dependencies are initialized in sequence.
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
  // Claude Services
  // ============================================================================
  private claudeCredentialStore?: ClaudeCredentialStore;
  private claudeModelPreferenceStore?: ClaudeModelPreferenceStore;
  private claudeOAuthStateStore?: ClaudeOAuthStateStore;
  private anthropicProxy?: AnthropicProxy;

  // ============================================================================
  // MCP Services
  // ============================================================================
  private mcpConfigService?: McpConfigService;
  private mcpProxy?: McpProxy;

  // ============================================================================
  // OAuth Modules
  // ============================================================================
  private claudeOAuthModule?: ClaudeOAuthModule;
  private mcpOAuthModule?: McpOAuthModule;

  // ============================================================================
  // Worker Gateway
  // ============================================================================
  private workerGateway?: WorkerGateway;

  // ============================================================================
  // Agent Configuration Services
  // ============================================================================
  private agentSettingsStore?: AgentSettingsStore;
  private channelBindingService?: ChannelBindingService;

  // ============================================================================
  // Modules
  // ============================================================================
  private gitFilesystemModule?: GitFilesystemModule;

  // ============================================================================
  // Scheduled Wakeup Service
  // ============================================================================
  private scheduledWakeupService?: ScheduledWakeupService;

  constructor(private readonly config: GatewayConfig) {}

  /**
   * Initialize all core services in dependency order
   */
  async initialize(): Promise<void> {
    logger.info("Initializing core services...");

    // 1. Queue (foundation for everything else)
    await this.initializeQueue();
    logger.debug("Queue initialized");

    // 2. Session management
    await this.initializeSessionServices();
    logger.debug("Session services initialized");

    // 3. Claude authentication & API
    await this.initializeClaudeServices();
    logger.debug("Claude services initialized");

    // 4. MCP ecosystem (depends on queue and Claude services)
    await this.initializeMcpServices();
    logger.debug("MCP services initialized");

    // 5. Queue producer (depends on queue being ready)
    await this.initializeQueueProducer();
    logger.debug("Queue producer initialized");

    // 6. Scheduled wakeup service (depends on queue)
    await this.initializeScheduledWakeupService();
    logger.debug("Scheduled wakeup service initialized");

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
    logger.info("✅ Queue connection established");
  }

  private async initializeQueueProducer(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before queue producer");
    }

    this.queueProducer = new QueueProducer(this.queue);
    await this.queueProducer.start();
    logger.info("✅ Queue producer initialized");
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
    logger.info("✅ Scheduled wakeup service initialized");
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
    logger.info("✅ Session manager initialized");

    this.interactionService = new InteractionService(redisClient);
    logger.info("✅ Interaction service initialized");

    // Initialize per-deployment config stores (Redis-backed)
    await mcpConfigStore.initialize(redisClient);
    await networkConfigStore.initialize(redisClient);
    logger.info("✅ MCP/network config stores initialized");

    // Initialize agent configuration stores
    this.agentSettingsStore = new AgentSettingsStore(redisClient);
    this.channelBindingService = new ChannelBindingService(redisClient);
    logger.info("✅ Agent settings & channel binding services initialized");
  }

  // ============================================================================
  // 3. Claude Services Initialization
  // ============================================================================

  private async initializeClaudeServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before Claude services");
    }

    const redisClient = this.queue.getRedisClient();

    // Initialize credential and preference stores
    this.claudeCredentialStore = new ClaudeCredentialStore(redisClient);
    this.claudeModelPreferenceStore = new ClaudeModelPreferenceStore(
      redisClient
    );
    logger.info("✅ Claude credential & preference stores initialized");

    // Initialize Anthropic API proxy
    this.anthropicProxy = new AnthropicProxy(
      this.config.anthropicProxy,
      this.claudeCredentialStore
    );
    logger.info("✅ Anthropic proxy initialized");

    // Register Claude OAuth module
    const systemTokenAvailable = !!this.config.anthropicProxy.anthropicApiKey;
    this.claudeOAuthStateStore = new ClaudeOAuthStateStore(redisClient);
    this.claudeOAuthModule = new ClaudeOAuthModule(
      this.claudeCredentialStore,
      this.claudeOAuthStateStore,
      this.claudeModelPreferenceStore,
      this.queue,
      this.config.mcp.publicGatewayUrl,
      systemTokenAvailable
    );
    moduleRegistry.register(this.claudeOAuthModule);
    logger.info(
      `✅ Claude OAuth module registered (system token: ${systemTokenAvailable ? "available" : "not available"})`
    );
  }

  // ============================================================================
  // 4. MCP Services Initialization
  // ============================================================================

  private async initializeMcpServices(): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue must be initialized before MCP services");
    }

    const redisClient = this.queue.getRedisClient();

    // Initialize MCP credential and state management
    const mcpCredentialStore = new McpCredentialStore(redisClient);
    const mcpOAuthStateStore = new McpOAuthStateStore(redisClient);
    const mcpInputStore = new McpInputStore(this.queue);

    // Initialize MCP OAuth discovery service
    const mcpDiscoveryService = new OAuthDiscoveryService({
      cacheStore: {
        get: async (key: string) => {
          try {
            return await redisClient.get(key);
          } catch (error) {
            logger.error("Failed to get from cache", { key, error });
            return null;
          }
        },
        set: async (key: string, value: string, ttl: number) => {
          try {
            await redisClient.set(key, value, "EX", ttl);
          } catch (error) {
            logger.error("Failed to set cache", { key, error });
          }
        },
        delete: async (key: string) => {
          try {
            await redisClient.del(key);
          } catch (error) {
            logger.error("Failed to delete from cache", { key, error });
          }
        },
      },
      callbackUrl: this.config.mcp.callbackUrl,
      protocolVersion: "2025-03-26",
      cacheTtl: 86400,
    });
    logger.info("✅ MCP OAuth Discovery Service initialized");

    // Initialize MCP config service
    this.mcpConfigService = new McpConfigService({
      configUrl: this.config.mcp.serversUrl,
      discoveryService: mcpDiscoveryService,
      credentialStore: mcpCredentialStore,
      inputStore: mcpInputStore,
    });

    // Initialize instruction service (needed by WorkerGateway)
    // Pass agentSettingsStore so skills instructions can be fetched per-agent
    this.instructionService = new InstructionService(
      this.mcpConfigService,
      this.agentSettingsStore
    );
    logger.info("Instruction service initialized");

    // Initialize worker gateway
    if (!this.sessionManager) {
      throw new Error(
        "Session manager must be initialized before worker gateway"
      );
    }
    if (!this.interactionService) {
      throw new Error(
        "Interaction service must be initialized before worker gateway"
      );
    }
    this.workerGateway = new WorkerGateway(
      this.queue,
      this.config.mcp.publicGatewayUrl,
      this.sessionManager,
      this.mcpConfigService,
      this.instructionService,
      this.interactionService
    );
    logger.info("Worker gateway initialized");

    // Initialize MCP proxy
    this.mcpProxy = new McpProxy(
      this.mcpConfigService,
      mcpCredentialStore,
      mcpInputStore,
      this.queue
    );
    logger.info("MCP proxy initialized");

    // Discover OAuth capabilities for all MCP servers
    logger.info("Discovering OAuth capabilities for MCP servers...");
    await this.mcpConfigService.enrichWithDiscovery();
    logger.info("MCP OAuth discovery completed");

    // Register MCP OAuth module
    this.mcpOAuthModule = new McpOAuthModule(
      this.mcpConfigService,
      mcpCredentialStore,
      mcpOAuthStateStore,
      mcpInputStore,
      this.config.mcp.publicGatewayUrl,
      this.config.mcp.callbackUrl
    );
    moduleRegistry.register(this.mcpOAuthModule);
    logger.info("MCP OAuth module registered");

    // Register Git Filesystem module
    this.gitFilesystemModule = new GitFilesystemModule();
    moduleRegistry.register(this.gitFilesystemModule);
    logger.info("Git Filesystem module registered");

    // Discover and initialize all available modules
    await moduleRegistry.registerAvailableModules();
    await moduleRegistry.initAll();
    logger.info("Modules initialized");
  }

  // ============================================================================
  // Shutdown
  // ============================================================================

  async shutdown(): Promise<void> {
    logger.info("Shutting down core services...");

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

    logger.info("✅ Core services shutdown complete");
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

  getAnthropicProxy(): AnthropicProxy | undefined {
    return this.anthropicProxy;
  }

  getWorkerGateway(): WorkerGateway | undefined {
    return this.workerGateway;
  }

  getMcpProxy(): McpProxy | undefined {
    return this.mcpProxy;
  }

  getClaudeCredentialStore(): ClaudeCredentialStore | undefined {
    return this.claudeCredentialStore;
  }

  getClaudeModelPreferenceStore(): ClaudeModelPreferenceStore | undefined {
    return this.claudeModelPreferenceStore;
  }

  getClaudeOAuthStateStore(): ClaudeOAuthStateStore | undefined {
    return this.claudeOAuthStateStore;
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

  getClaudeOAuthModule(): ClaudeOAuthModule | undefined {
    return this.claudeOAuthModule;
  }

  getMcpOAuthModule(): McpOAuthModule | undefined {
    return this.mcpOAuthModule;
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

  getGitFilesystemModule(): GitFilesystemModule | undefined {
    return this.gitFilesystemModule;
  }

  getScheduledWakeupService(): ScheduledWakeupService | undefined {
    return this.scheduledWakeupService;
  }
}
