#!/usr/bin/env bun

import { createLogger } from "@peerbot/core";
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
export class Gateway {
  private coreServices: CoreServices;
  private platforms: Map<string, PlatformAdapter> = new Map();
  private unifiedConsumer?: UnifiedThreadResponseConsumer;
  private isRunning = false;

  constructor(private readonly config: GatewayConfig) {
    this.coreServices = new CoreServices(config);
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
    logger.info(`Platform registered: ${platform.name}`);
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
    logger.info("Starting gateway...");

    // 1. Initialize core services (Redis, MCP, Anthropic, etc.)
    logger.info("Step 1/4: Initializing core services");
    await this.coreServices.initialize();

    // 2. Initialize each platform with core services
    logger.info(`Step 2/4: Initializing ${this.platforms.size} platform(s)`);
    for (const [name, platform] of this.platforms) {
      logger.info(`Initializing platform: ${name}`);
      await platform.initialize(this.coreServices);
    }

    // 3. Register instruction providers from platforms
    logger.info("Step 3/4: Registering instruction providers");
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
    logger.info(`Step 4/4: Starting ${this.platforms.size} platform(s)`);
    for (const [name, platform] of this.platforms) {
      logger.info(`Starting platform: ${name}`);
      await platform.start();
    }

    // 5. Start unified thread response consumer
    // Single consumer routes responses to platforms via registry
    logger.info("Starting unified thread response consumer");
    this.unifiedConsumer = new UnifiedThreadResponseConsumer(
      this.coreServices.getQueue(),
      platformRegistry
    );
    await this.unifiedConsumer.start();
    logger.info("Unified thread response consumer started");

    this.isRunning = true;
    logger.info(
      `Gateway started successfully with ${this.platforms.size} platform(s)`
    );
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
}
