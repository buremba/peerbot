import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createLogger } from "@lobu/core";
import { ApiPlatform } from "./api/index.js";
import { createGatewayApp, startGatewayServer } from "./cli/gateway.js";
import {
  type AgentConfig,
  buildGatewayConfig,
  type GatewayConfig,
} from "./config/index.js";
import {
  ChatInstanceManager,
  ChatResponseBridge,
} from "./connections/index.js";
import type {
  EmbeddedAuthProvider,
  RuntimeProviderCredentialResolver,
} from "./embedded.js";
import { Gateway } from "./gateway-main.js";
import type { SecretStoreRegistry } from "./secrets/index.js";

const logger = createLogger("lobu");

// ── Public Config Types ────────────────────────────────────────────────────

export interface LobuAgentConfig {
  id: string;
  name?: string;
  description?: string;
  identity?: string;
  soul?: string;
  user?: string;
  providers?: Array<{
    id: string;
    model?: string;
    key?: string;
    secretRef?: string;
  }>;
  /**
   * Platform connections. Use `name` to disambiguate when an agent has
   * multiple connections of the same `type` (e.g. two Slack workspaces).
   */
  connections?: Array<{
    type: string;
    name?: string;
    [key: string]: string | undefined;
  }>;
  skills?: string[];
  network?: { allowed?: string[]; denied?: string[] };
  nixPackages?: string[];
}

export interface LobuConfig {
  redis: string;
  memory?: string;
  agents?: LobuAgentConfig[];
  port?: number;
  /** Public URL of the gateway (used for OAuth callbacks). Defaults to http://localhost:{port}. */
  publicUrl?: string;
  /** Admin password for API auth. Auto-generated if not provided. */
  adminPassword?: string;
  /** Custom auth provider for embedded settings access. */
  authProvider?: EmbeddedAuthProvider;
  /** Override the default secret-store registry in embedded mode. */
  secretStore?: SecretStoreRegistry;
  /** Resolve provider credentials dynamically at runtime in embedded mode. */
  providerCredentialResolver?: RuntimeProviderCredentialResolver;
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
  private readonly authProvider?: EmbeddedAuthProvider;

  constructor(config: LobuConfig) {
    this.agentConfigs = config.agents ?? [];
    this.port = config.port ?? 8080;
    this.authProvider = config.authProvider;

    if (config.memory) {
      process.env.MEMORY_URL = config.memory;
    }

    // Set ADMIN_PASSWORD in env so gateway.ts picks it up.
    // Auto-generate one if not provided.
    if (config.adminPassword) {
      process.env.ADMIN_PASSWORD = config.adminPassword;
    } else if (!process.env.ADMIN_PASSWORD) {
      process.env.ADMIN_PASSWORD = randomBytes(16).toString("base64url");
    }

    const defaultPublicUrl = `http://localhost:${this.port}`;

    // Convert LobuConfig -> GatewayConfig via buildGatewayConfig overrides.
    // Passing `agents` lets core-services own InMemoryAgentStore population
    // and DeclaredAgentRegistry seeding; avoids a parallel SDK seeding path.
    this.gatewayConfig = buildGatewayConfig({
      agents: this.agentConfigs.map(toAgentConfig),
      queues: { connectionString: config.redis },
      mcp: {
        publicGatewayUrl: config.publicUrl ?? defaultPublicUrl,
      },
    });

    this.gateway = new Gateway(this.gatewayConfig, {
      secretStore: config.secretStore,
      providerCredentialResolver: config.providerCredentialResolver,
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

    // Start the gateway (initializes CoreServices, platforms, consumer).
    // CoreServices populates agents + the declared registry from
    // `gatewayConfig.agents` automatically — no separate seeding needed.
    await this.gateway.start();

    const coreServices = this.gateway.getCoreServices();

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
      authProvider: this.authProvider,
    });
  }

  // ── Private Helpers ──────────────────────────────────────────────────────

  /**
   * Seed platform connections from agent configs.
   * Mirrors the file-loaded agent connection seeding in gateway.ts startGateway().
   */
  private async seedConnections(): Promise<void> {
    if (!this.chatInstanceManager) return;

    const { buildStableConnectionId } = await import("./config/file-loader.js");

    for (const agent of this.agentConfigs) {
      if (!agent.connections?.length) continue;

      // Reject duplicate `(type, name)` pairs so stable IDs stay collision-free.
      const seenConnKeys = new Set<string>();
      for (const conn of agent.connections) {
        const key = `${conn.type}:${conn.name ?? ""}`;
        if (seenConnKeys.has(key)) {
          throw new Error(
            conn.name
              ? `agent "${agent.id}" has duplicate connection (type=${conn.type}, name=${conn.name})`
              : `agent "${agent.id}" has multiple "${conn.type}" connections — add a unique \`name\` to each to disambiguate`
          );
        }
        seenConnKeys.add(key);
      }

      // Pre-fetch existing connections once per agent and match by stable id.
      const existingForAgent = await this.chatInstanceManager.listConnections({
        platform: undefined,
        templateAgentId: agent.id,
      });
      const existingIds = new Set(existingForAgent.map((c: any) => c.id));

      for (const conn of agent.connections) {
        const { type, name, ...configFields } = conn;
        const stableId = buildStableConnectionId(agent.id, type, name);

        if (existingIds.has(stableId)) continue;

        try {
          await this.chatInstanceManager.addConnection(
            type,
            agent.id,
            { platform: type as any, ...configFields },
            { allowGroups: true },
            {},
            stableId
          );
          logger.debug(
            `Created ${type} connection for agent "${agent.id}" as "${stableId}"`
          );
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

/**
 * Convert a public LobuAgentConfig into the internal AgentConfig shape so
 * `buildGatewayConfig` and `CoreServices` can populate the agent store and
 * declared registry from a single source.
 */
function toAgentConfig(agent: LobuAgentConfig): AgentConfig {
  return {
    id: agent.id,
    name: agent.name ?? agent.id,
    description: agent.description,
    identityMd: agent.identity,
    soulMd: agent.soul,
    userMd: agent.user,
    providers: agent.providers,
    network: agent.network,
    nixPackages: agent.nixPackages,
  };
}
