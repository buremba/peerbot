import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import { ApiPlatform } from "./api";
import { createGatewayApp, startGatewayServer } from "./cli/gateway";
import { buildGatewayConfig, type GatewayConfig } from "./config";
import { ChatInstanceManager, ChatResponseBridge } from "./connections";
import { Gateway } from "./gateway-main";
import { InMemoryAgentStore } from "./stores/in-memory-agent-store";

const logger = createLogger("lobu");

// ── Public Config Types ────────────────────────────────────────────────────

export interface LobuAgentConfig {
  id: string;
  name?: string;
  description?: string;
  identity?: string;
  soul?: string;
  user?: string;
  providers?: Array<{ id: string; model?: string; key?: string }>;
  connections?: Array<{ type: string; [key: string]: string }>;
  skills?: string[];
  network?: { allowed?: string[]; denied?: string[] };
  nixPackages?: string[];
}

export interface LobuConfig {
  redis: string;
  memory?: string;
  agents?: LobuAgentConfig[];
  port?: number;
  deploymentMode?: "embedded" | "docker";
  /** Public URL of the gateway (used for OAuth callbacks). Defaults to http://localhost:{port}. */
  publicUrl?: string;
  /** Admin password for API auth. Auto-generated if not provided. */
  adminPassword?: string;
}

// ── Lobu Facade ────────────────────────────────────────────────────────────

export class Lobu {
  private gateway: Gateway;
  private gatewayConfig: GatewayConfig;
  private agentConfigs: LobuAgentConfig[];
  private httpServer: Server | null = null;
  private chatInstanceManager: ChatInstanceManager | null = null;
  private initialized = false;
  private port: number;

  constructor(config: LobuConfig) {
    this.agentConfigs = config.agents ?? [];
    this.port = config.port ?? 8080;

    if (config.memory) {
      process.env.MEMORY_URL = config.memory;
    }

    // Set ADMIN_PASSWORD in env so gateway.ts picks it up.
    // Auto-generate one if not provided.
    if (config.adminPassword) {
      process.env.ADMIN_PASSWORD = config.adminPassword;
    } else if (!process.env.ADMIN_PASSWORD) {
      const crypto = require("node:crypto");
      process.env.ADMIN_PASSWORD = crypto.randomBytes(16).toString("base64url");
    }

    const defaultPublicUrl = `http://localhost:${this.port}`;

    // Convert LobuConfig -> GatewayConfig via buildGatewayConfig overrides
    this.gatewayConfig = buildGatewayConfig({
      queues: { connectionString: config.redis },
      orchestration: {
        deploymentMode: config.deploymentMode ?? "embedded",
      },
      mcp: {
        publicGatewayUrl: config.publicUrl ?? defaultPublicUrl,
      },
    });

    // Build InMemoryAgentStore pre-populated with agents from config
    const store = new InMemoryAgentStore();
    this.gateway = new Gateway(this.gatewayConfig, {
      configStore: store,
      connectionStore: store,
      accessStore: store,
    });

    // Register API platform (always enabled)
    this.gateway.registerPlatform(new ApiPlatform());
  }

  /**
   * Initialize services, populate agents, and seed connections without starting
   * an HTTP server. Call this when embedding Lobu in an existing server, then
   * use `getApp()` to get the Hono handler.
   *
   * Safe to call multiple times — initialization runs only once.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Start the gateway (initializes CoreServices, platforms, consumer)
    await this.gateway.start();

    const coreServices = this.gateway.getCoreServices();

    // Populate agents from config into the InMemoryAgentStore
    await this.populateAgents();

    // Initialize Chat SDK connection manager for platform connections
    this.chatInstanceManager = new ChatInstanceManager();
    try {
      await this.chatInstanceManager.initialize(coreServices);

      // Register chat platform adapters
      for (const adapter of this.chatInstanceManager.createPlatformAdapters()) {
        this.gateway.registerPlatform(adapter);
      }

      // Seed connections from agent configs
      await this.seedConnections();

      // Wire ChatResponseBridge into unified thread consumer
      const unifiedConsumer = this.gateway.getUnifiedConsumer();
      if (unifiedConsumer) {
        const chatResponseBridge = new ChatResponseBridge(
          this.chatInstanceManager
        );
        unifiedConsumer.setChatResponseBridge(chatResponseBridge);
      }
    } catch (error) {
      logger.warn(
        { error: String(error) },
        "ChatInstanceManager initialization failed — connections feature disabled"
      );
    }

    this.initialized = true;
    logger.info("Lobu gateway initialized");
  }

  /**
   * Start the gateway and an HTTP server. Shorthand for `initialize()` + bind
   * to a port. Use `initialize()` + `getApp()` instead when mounting Lobu in
   * an existing framework.
   */
  async start(): Promise<void> {
    await this.initialize();

    const app = this.getApp();
    this.httpServer = startGatewayServer(app, this.port);

    logger.info(`Lobu gateway running on port ${this.port}`);
  }

  /**
   * Stop the gateway and HTTP server.
   */
  async stop(): Promise<void> {
    if (this.chatInstanceManager) {
      await this.chatInstanceManager.shutdown();
    }
    await this.gateway.stop();
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    logger.info("Lobu gateway stopped");
  }

  /**
   * Get the Hono app for mounting in another server (no HTTP server started).
   * Call this instead of start() when embedding in an existing HTTP server.
   */
  getApp() {
    const coreServices = this.gateway.getCoreServices();
    return createGatewayApp({
      secretProxy: coreServices.getSecretProxy(),
      workerGateway: coreServices.getWorkerGateway(),
      mcpProxy: coreServices.getMcpProxy(),
      interactionService: coreServices.getInteractionService(),
      platformRegistry: this.gateway.getPlatformRegistry(),
      coreServices,
      chatInstanceManager: this.chatInstanceManager,
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Populate InMemoryAgentStore + seed credentials from LobuAgentConfig[].
   * Mirrors what CoreServices.populateStoreFromFiles() does for file-loaded agents.
   */
  private async populateAgents(): Promise<void> {
    if (this.agentConfigs.length === 0) return;

    const coreServices = this.gateway.getCoreServices();
    const configStore = coreServices.getConfigStore();
    if (!configStore) return;

    const store = configStore as InMemoryAgentStore;
    const authProfilesManager = coreServices.getAuthProfilesManager();

    for (const agent of this.agentConfigs) {
      // Save metadata
      await store.saveMetadata(agent.id, {
        agentId: agent.id,
        name: agent.name ?? agent.id,
        description: agent.description,
        owner: { platform: "system", userId: "sdk" },
        createdAt: Date.now(),
      });

      // Build settings (same shape as FileLoadedAgent.settings)
      const settings: Record<string, any> = {};

      if (agent.identity) settings.identityMd = agent.identity;
      if (agent.soul) settings.soulMd = agent.soul;
      if (agent.user) settings.userMd = agent.user;

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

      if (agent.network) {
        settings.networkConfig = {
          allowedDomains: agent.network.allowed,
          deniedDomains: agent.network.denied,
        };
      }

      if (agent.nixPackages?.length) {
        settings.nixConfig = { packages: agent.nixPackages };
      }

      await store.saveSettings(agent.id, {
        ...settings,
        updatedAt: Date.now(),
      } as any);

      // Seed provider credentials
      if (authProfilesManager && agent.providers) {
        for (const provider of agent.providers) {
          if (!provider.key) continue;
          await authProfilesManager.upsertProfile({
            agentId: agent.id,
            provider: provider.id,
            credential: provider.key,
            authType: "api-key",
            label: `${provider.id} (from SDK config)`,
            makePrimary: true,
          });
        }
      }
    }

    logger.info(
      `Populated ${this.agentConfigs.length} agent(s) from SDK config`
    );
  }

  /**
   * Seed platform connections from agent configs.
   * Mirrors the file-loaded agent connection seeding in gateway.ts startGateway().
   */
  private async seedConnections(): Promise<void> {
    if (!this.chatInstanceManager) return;

    for (const agent of this.agentConfigs) {
      if (!agent.connections?.length) continue;

      for (const conn of agent.connections) {
        const { type, ...configFields } = conn;

        const existing = await this.chatInstanceManager.listConnections({
          platform: type,
          templateAgentId: agent.id,
        });
        if (existing.length > 0) continue;

        try {
          await this.chatInstanceManager.addConnection(
            type,
            agent.id,
            { platform: type as any, ...configFields },
            { allowGroups: true }
          );
          logger.debug(`Created ${type} connection for agent "${agent.id}"`);
        } catch (err) {
          logger.error(
            `Failed to create ${type} connection for agent "${agent.id}"`,
            { error: err instanceof Error ? err.message : String(err) }
          );
        }
      }
    }
  }
}
