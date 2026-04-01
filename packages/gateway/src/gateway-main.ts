#!/usr/bin/env bun

import {
  type AgentAccessStore,
  type AgentConfigStore,
  type AgentConnectionStore,
  createLogger,
  type RegistryEntry,
  type SystemSkillEntry,
} from "@lobu/core";
import type { GatewayConfig } from "./config";
import { type PlatformAdapter, platformRegistry } from "./platform";
import { UnifiedThreadResponseConsumer } from "./platform/unified-thread-consumer";
import { CoreServices } from "./services/core-services";

const logger = createLogger("gateway");

/**
 * Main Gateway class that orchestrates all platform adapters
 *
 * Architecture:
 * - CoreServices: Platform-agnostic services (Redis, MCP, Anthropic)
 * - PlatformAdapters: Platform-specific integrations (Slack, Discord, etc.)
 *
 * Lifecycle:
 * 1. Gateway initializes CoreServices
 * 2. Platforms register themselves via registerPlatform()
 * 3. Gateway calls initialize() on each platform with CoreServices
 * 4. Gateway calls start() on each platform
 */
export interface GatewayOptions {
  /** Agent settings + metadata store. Defaults to RedisAgentStore. */
  configStore?: AgentConfigStore;
  /** Connections + channel bindings store. Defaults to RedisAgentStore. */
  connectionStore?: AgentConnectionStore;
  /** Grants + user-agent associations store. Defaults to RedisAgentStore. */
  accessStore?: AgentAccessStore;
  /** Provide system skills programmatically (skips file loading). */
  systemSkills?: SystemSkillEntry[];
  /** Provide skill registries programmatically (skips file loading). */
  skillRegistries?: RegistryEntry[];
}

export class Gateway {
  private coreServices: CoreServices;
  private platforms: Map<string, PlatformAdapter> = new Map();
  private unifiedConsumer?: UnifiedThreadResponseConsumer;
  private isRunning = false;

  constructor(
    private readonly config: GatewayConfig,
    options?: GatewayOptions
  ) {
    this.coreServices = new CoreServices(config, {
      configStore: options?.configStore,
      connectionStore: options?.connectionStore,
      accessStore: options?.accessStore,
      systemSkills: options?.systemSkills,
      skillRegistries: options?.skillRegistries,
    });
  }

  /**
   * Register a platform adapter
   * Platforms register themselves via dependency injection
   *
   * @param platform - Platform adapter to register
   * @returns This gateway for chaining
   */
  registerPlatform(platform: PlatformAdapter): this {
    if (this.platforms.has(platform.name)) {
      throw new Error(`Platform ${platform.name} is already registered`);
    }

    this.platforms.set(platform.name, platform);
    // Also register in global platform registry for deployment managers
    platformRegistry.register(platform);
    logger.debug(`Platform registered: ${platform.name}`);
    return this;
  }

  /**
   * Start the gateway
   * 1. Initialize core services
   * 2. Initialize all platforms
   * 3. Register instruction providers from platforms
   * 4. Start all platforms
   */
  async start(): Promise<void> {
    logger.debug("Starting gateway...");

    // 1. Initialize core services (Redis, MCP, Anthropic, etc.)
    await this.coreServices.initialize();

    // 2. Initialize each platform with core services
    for (const [name, platform] of this.platforms) {
      logger.debug(`Initializing platform: ${name}`);
      await platform.initialize(this.coreServices);
    }

    // 3. Register instruction providers from platforms
    const instructionService = this.coreServices.getInstructionService();
    if (instructionService) {
      for (const [name, platform] of this.platforms) {
        if (platform.getInstructionProvider) {
          const provider = platform.getInstructionProvider();
          if (provider) {
            instructionService.registerPlatformProvider(name, provider);
          }
        }
      }
    }

    // 4. Start all platforms
    for (const [name, platform] of this.platforms) {
      logger.debug(`Starting platform: ${name}`);
      await platform.start();
    }

    // 5. Start unified thread response consumer
    // Single consumer routes responses to platforms via registry
    this.unifiedConsumer = new UnifiedThreadResponseConsumer(
      this.coreServices.getQueue(),
      platformRegistry
    );
    await this.unifiedConsumer.start();

    this.isRunning = true;
  }

  /**
   * Stop the gateway gracefully
   * 1. Stop unified consumer if running
   * 2. Stop all platforms
   * 3. Shutdown core services
   */
  async stop(): Promise<void> {
    logger.info("Stopping gateway...");

    // Stop unified consumer if running
    if (this.unifiedConsumer) {
      logger.info("Stopping unified thread response consumer");
      try {
        await this.unifiedConsumer.stop();
      } catch (error) {
        logger.error("Failed to stop unified consumer:", error);
      }
    }

    // Stop all platforms
    for (const [name, platform] of this.platforms) {
      logger.info(`Stopping platform: ${name}`);
      try {
        await platform.stop();
      } catch (error) {
        logger.error(`Failed to stop platform ${name}:`, error);
      }
    }

    // Shutdown core services
    await this.coreServices.shutdown();

    this.isRunning = false;
    logger.info("✅ Gateway stopped");
  }

  /**
   * Get gateway status
   */
  getStatus(): {
    isRunning: boolean;
    platforms: string[];
    config: Partial<GatewayConfig>;
  } {
    return {
      isRunning: this.isRunning,
      platforms: Array.from(this.platforms.keys()),
      config: {
        queues: this.config.queues,
      },
    };
  }

  /**
   * Get core services (for platform adapters during initialization)
   */
  getCoreServices(): CoreServices {
    return this.coreServices;
  }

  /**
   * Get platform registry (for routes that need to access platform adapters)
   */
  getPlatformRegistry() {
    return platformRegistry;
  }

  /**
   * Get unified thread response consumer (for wiring Chat SDK response bridge)
   */
  getUnifiedConsumer() {
    return this.unifiedConsumer;
  }
}
