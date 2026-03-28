/**
 * ChatInstanceManager — manages Chat SDK instances for API-driven platform connections.
 * Owns Redis persistence, Chat lifecycle, and webhook dispatch.
 */

import { randomUUID } from "node:crypto";
import { createLogger, decrypt, encrypt } from "@lobu/core";
import type Redis from "ioredis";
import type { CoreServices } from "../platform";
import {
  type ConnectionSettings,
  isSecretField,
  type PlatformAdapterConfig,
  type PlatformConnection,
  SUPPORTED_PLATFORMS,
} from "./types";

const logger = createLogger("chat-instance-manager");
const SLACK_SYSTEM_AGENT_PREFIX = "system:connection:slack";

const ADAPTER_FACTORIES: Record<string, (config: any) => Promise<any>> = {
  telegram: async (c) =>
    (await import("@chat-adapter/telegram")).createTelegramAdapter(c),
  slack: async (c) =>
    (await import("@chat-adapter/slack")).createSlackAdapter(c),
  discord: async (c) =>
    (await import("@chat-adapter/discord")).createDiscordAdapter(c),
  whatsapp: async (c) =>
    (await import("@chat-adapter/whatsapp")).createWhatsAppAdapter(c),
  teams: async (c) =>
    (await import("@chat-adapter/teams")).createTeamsAdapter(c),
};

interface ManagedInstance {
  connection: PlatformConnection;
  chat: any; // Chat SDK instance
  cleanup?: () => Promise<void>;
}

export class ChatInstanceManager {
  private instances = new Map<string, ManagedInstance>();
  private redis!: Redis;
  private services!: CoreServices;
  private publicGatewayUrl = "";

  async initialize(services: CoreServices): Promise<void> {
    this.services = services;
    this.redis = services.getQueue().getRedisClient();
    this.publicGatewayUrl = services.getPublicGatewayUrl();

    // Load all connections from Redis and start active ones
    const connectionIds = await this.redis.smembers("connections:all");
    logger.debug(
      { count: connectionIds.length },
      "Loading connections from Redis"
    );

    for (const id of connectionIds) {
      try {
        const raw = await this.redis.get(`connection:${id}`);
        if (!raw) {
          await this.redis.srem("connections:all", id);
          continue;
        }
        const connection = JSON.parse(raw) as PlatformConnection;
        try {
          connection.config = this.decryptConfig(connection.config);
        } catch (decryptError) {
          // ENCRYPTION_KEY changed — remove stale connection so the seeder can recreate it
          logger.warn(
            { id, platform: connection.platform, error: String(decryptError) },
            "Removing connection with undecryptable config (ENCRYPTION_KEY changed?)"
          );
          await this.redis.del(`connection:${id}`);
          await this.redis.srem("connections:all", id);
          if (connection.templateAgentId) {
            await this.redis.srem(
              `connections:agent:${connection.templateAgentId}`,
              id
            );
          }
          continue;
        }

        // Migrate legacy agentId → templateAgentId
        const legacy = connection as PlatformConnection & {
          agentId?: string;
        };
        if (legacy.agentId && !connection.templateAgentId) {
          connection.templateAgentId = legacy.agentId;
          delete legacy.agentId;
          await this.persistConnection(connection);
          logger.info(
            { id, templateAgentId: connection.templateAgentId },
            "Migrated agentId → templateAgentId"
          );
        }

        // Migrate legacy scope values: "mcp-servers"/"tools" → "skills"
        if (connection.settings?.userConfigScopes?.length) {
          const oldScopes = connection.settings.userConfigScopes as string[];
          const hasLegacy = oldScopes.some(
            (s) => s === "mcp-servers" || s === "tools"
          );
          if (hasLegacy) {
            const migrated = new Set<string>();
            for (const s of oldScopes) {
              if (s === "mcp-servers" || s === "tools") {
                migrated.add("skills");
              } else {
                migrated.add(s);
              }
            }
            connection.settings.userConfigScopes = [...migrated] as any;
            await this.persistConnection(connection);
            logger.info({ id }, "Migrated legacy scopes → skills");
          }
        }

        if (connection.status === "active") {
          await this.startInstance(connection);
        }
      } catch (error) {
        logger.error({ id, error: String(error) }, "Failed to load connection");
      }
    }
  }

  async shutdown(): Promise<void> {
    logger.info(
      { count: this.instances.size },
      "Shutting down all connections"
    );
    const shutdownPromises = Array.from(this.instances.values()).map(
      async (instance) => {
        try {
          await instance.cleanup?.();
        } catch (error) {
          logger.error(
            { id: instance.connection.id, error: String(error) },
            "Error shutting down connection"
          );
        }
      }
    );
    await Promise.allSettled(shutdownPromises);
    this.instances.clear();
  }

  async addConnection(
    platform: string,
    templateAgentId: string | undefined,
    config: PlatformAdapterConfig,
    settings?: ConnectionSettings,
    metadata: Record<string, any> = {}
  ): Promise<PlatformConnection> {
    if (!SUPPORTED_PLATFORMS.includes(platform as any)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    if (config.platform !== platform) {
      throw new Error(
        `Config platform mismatch: expected ${platform}, got ${config.platform}`
      );
    }

    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();

    const connection: PlatformConnection = {
      id,
      platform,
      ...(templateAgentId ? { templateAgentId } : {}),
      config,
      settings: settings ?? { allowGroups: true },
      metadata,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    // Start the Chat SDK instance
    await this.startInstance(connection);

    // Persist (secrets encrypted)
    await this.persistConnection(connection);

    logger.info({ id, platform, templateAgentId }, "Connection added");
    return connection;
  }

  async removeConnection(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (instance) {
      await instance.cleanup?.();
      this.instances.delete(id);
    }

    // Clean up Redis
    const raw = await this.redis.get(`connection:${id}`);
    if (raw) {
      const conn = JSON.parse(raw) as PlatformConnection;
      if (conn.templateAgentId) {
        await this.redis.srem(`connections:agent:${conn.templateAgentId}`, id);
      }
    }
    await this.redis.del(`connection:${id}`);
    await this.redis.srem("connections:all", id);

    logger.info({ id }, "Connection removed");
  }

  async restartConnection(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (instance) {
      await instance.cleanup?.();
      this.instances.delete(id);
    }

    const raw = await this.redis.get(`connection:${id}`);
    if (!raw) throw new Error(`Connection ${id} not found`);

    const connection = JSON.parse(raw) as PlatformConnection;
    connection.config = this.decryptConfig(connection.config);
    connection.status = "active";
    connection.errorMessage = undefined;
    connection.updatedAt = Date.now();

    try {
      await this.startInstance(connection);
    } catch (error) {
      // startInstance sets connection.status = "error" — persist so UI reflects it
      await this.persistConnection(connection);
      throw error;
    }
    await this.persistConnection(connection);

    logger.info({ id }, "Connection restarted");
  }

  async stopConnection(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (instance) {
      await instance.cleanup?.();
      this.instances.delete(id);
    }

    const raw = await this.redis.get(`connection:${id}`);
    if (!raw) throw new Error(`Connection ${id} not found`);

    const connection = JSON.parse(raw) as PlatformConnection;
    connection.config = this.decryptConfig(connection.config);
    connection.status = "stopped";
    connection.updatedAt = Date.now();
    await this.persistConnection(connection);

    logger.info({ id }, "Connection stopped");
  }

  async updateConnection(
    id: string,
    updates: {
      templateAgentId?: string | null;
      config?: PlatformAdapterConfig;
      settings?: ConnectionSettings;
      metadata?: Record<string, any>;
    }
  ): Promise<PlatformConnection> {
    const raw = await this.redis.get(`connection:${id}`);
    if (!raw) throw new Error(`Connection ${id} not found`);

    const connection = JSON.parse(raw) as PlatformConnection;
    connection.config = this.decryptConfig(connection.config);

    const needsRestart =
      updates.config !== undefined &&
      JSON.stringify(updates.config) !== JSON.stringify(connection.config);

    if (updates.templateAgentId !== undefined) {
      // Update agent index — remove old, add new
      if (connection.templateAgentId) {
        await this.redis.srem(
          `connections:agent:${connection.templateAgentId}`,
          id
        );
      }
      if (updates.templateAgentId) {
        connection.templateAgentId = updates.templateAgentId;
        await this.redis.sadd(
          `connections:agent:${connection.templateAgentId}`,
          id
        );
      } else {
        delete connection.templateAgentId;
      }
    }
    if (updates.config !== undefined) {
      const merged = { ...connection.config } as any;
      for (const [key, value] of Object.entries(updates.config)) {
        if (typeof value === "string" && value.startsWith("***")) continue;
        merged[key] = value;
      }
      merged.platform = updates.config.platform;
      connection.config = merged as PlatformAdapterConfig;
    }
    if (updates.settings !== undefined) {
      connection.settings = { ...connection.settings, ...updates.settings };
    }
    if (updates.metadata !== undefined) {
      connection.metadata = {
        ...(connection.metadata || {}),
        ...updates.metadata,
      };
    }
    connection.updatedAt = Date.now();

    if (needsRestart && connection.status === "active") {
      const instance = this.instances.get(id);
      if (instance) {
        await instance.cleanup?.();
        this.instances.delete(id);
      }
      await this.startInstance(connection);
    } else {
      const instance = this.instances.get(id);
      if (instance) {
        instance.connection = connection;
      }
    }

    await this.persistConnection(connection);
    return this.sanitizeConnection(connection);
  }

  async listConnections(filter?: {
    platform?: string;
    templateAgentId?: string;
  }): Promise<PlatformConnection[]> {
    let ids: string[];
    if (filter?.templateAgentId) {
      ids = await this.redis.smembers(
        `connections:agent:${filter.templateAgentId}`
      );
    } else {
      ids = await this.redis.smembers("connections:all");
    }

    const connections: PlatformConnection[] = [];
    for (const id of ids) {
      const raw = await this.redis.get(`connection:${id}`);
      if (!raw) continue;
      const conn = JSON.parse(raw) as PlatformConnection;
      if (filter?.platform && conn.platform !== filter.platform) continue;
      connections.push(this.sanitizeConnection(conn));
    }
    return connections;
  }

  async getConnection(id: string): Promise<PlatformConnection | null> {
    const raw = await this.redis.get(`connection:${id}`);
    if (!raw) return null;
    return this.sanitizeConnection(JSON.parse(raw));
  }

  has(id: string): boolean {
    return this.instances.has(id);
  }

  getInstance(id: string): ManagedInstance | undefined {
    return this.instances.get(id);
  }

  /** Get a decrypted secret from a running connection's config. */
  getConnectionConfigSecret(
    connectionId: string,
    field: string
  ): string | undefined {
    const instance = this.instances.get(connectionId);
    if (!instance) return undefined;
    const config = instance.connection.config as Record<string, unknown>;
    const val = config[field];
    return typeof val === "string" ? val : undefined;
  }

  async handleWebhook(
    connectionId: string,
    request: Request
  ): Promise<Response> {
    const instance = this.instances.get(connectionId);
    if (!instance) {
      return new Response("Connection not found", { status: 404 });
    }

    const { platform } = instance.connection;
    const webhookHandler = instance.chat.webhooks?.[platform];
    if (!webhookHandler) {
      return new Response("No webhook handler", { status: 404 });
    }

    try {
      return await webhookHandler(request);
    } catch (error) {
      logger.error(
        { connectionId, error: String(error) },
        "Webhook handling failed"
      );
      return new Response("Internal error", { status: 500 });
    }
  }

  getServices(): CoreServices {
    return this.services;
  }

  async findSlackConnectionByTeamId(
    teamId: string
  ): Promise<PlatformConnection | null> {
    const connections = await this.listConnections({ platform: "slack" });
    return (
      connections.find(
        (connection) => connection.metadata?.teamId === teamId
      ) || null
    );
  }

  async getDefaultSlackConnection(): Promise<PlatformConnection | null> {
    const connections = await this.listConnections({ platform: "slack" });
    if (connections.length === 1) {
      return connections[0] || null;
    }

    return (
      connections.find((connection) => !connection.metadata?.teamId) || null
    );
  }

  async ensureSlackWorkspaceConnection(
    teamId: string,
    installation: {
      botToken: string;
      botUserId?: string;
      teamName?: string;
    }
  ): Promise<PlatformConnection> {
    const baseConfig = this.resolveSlackAdapterConfig({
      requireOAuth: true,
    }) as Extract<PlatformAdapterConfig, { platform: "slack" }>;
    const config: PlatformAdapterConfig = {
      ...baseConfig,
      botToken: installation.botToken,
      ...(installation.botUserId ? { botUserId: installation.botUserId } : {}),
    };
    const agentId = `${SLACK_SYSTEM_AGENT_PREFIX}:${teamId}`;
    const metadata = {
      teamId,
      teamName: installation.teamName,
      botUserId: installation.botUserId,
    };

    const existing = await this.findSlackConnectionByTeamId(teamId);
    if (existing) {
      const updated = await this.updateConnection(existing.id, {
        templateAgentId: agentId,
        config,
        metadata,
      });
      if (!this.has(existing.id)) {
        await this.restartConnection(existing.id);
      }
      return updated;
    }

    return this.addConnection(
      "slack",
      agentId,
      config,
      { allowGroups: true },
      metadata
    );
  }

  async completeSlackOAuthInstall(
    request: Request,
    redirectUri?: string
  ): Promise<{
    teamId: string;
    teamName?: string;
    connectionId: string;
  }> {
    const { chat, adapter } = await this.createSlackOAuthChat({
      requireOAuth: true,
    });

    try {
      const url = new URL(request.url);
      if (redirectUri) {
        url.searchParams.set("redirect_uri", redirectUri);
      }

      const callbackRequest = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
      });

      const { teamId, installation } =
        await adapter.handleOAuthCallback(callbackRequest);
      let connection: PlatformConnection;
      try {
        connection = await this.ensureSlackWorkspaceConnection(
          teamId,
          installation
        );
      } catch (error) {
        await adapter.deleteInstallation(teamId).catch(() => undefined);
        throw error;
      }

      return {
        teamId,
        teamName: installation.teamName,
        connectionId: connection.id,
      };
    } finally {
      await chat.shutdown().catch(() => undefined);
    }
  }

  async handleSlackAppWebhook(request: Request): Promise<Response> {
    const body = await request.text();
    const teamId = this.extractSlackTeamId(
      body,
      request.headers.get("content-type") || ""
    );

    if (teamId) {
      const connection = await this.findSlackConnectionByTeamId(teamId);
      if (connection) {
        if (!(await this.ensureConnectionRunning(connection.id))) {
          return new Response("Slack connection unavailable", { status: 503 });
        }
        return this.handleWebhook(
          connection.id,
          this.cloneRequestWithBody(request, body)
        );
      }
    }

    const fallbackConnection = await this.getDefaultSlackConnection();
    if (fallbackConnection) {
      if (!(await this.ensureConnectionRunning(fallbackConnection.id))) {
        return new Response("Slack connection unavailable", { status: 503 });
      }
      return this.handleWebhook(
        fallbackConnection.id,
        this.cloneRequestWithBody(request, body)
      );
    }

    const { chat, adapter } = await this.createSlackOAuthChat();
    try {
      return await adapter.handleWebhook(
        this.cloneRequestWithBody(request, body)
      );
    } finally {
      await chat.shutdown().catch(() => undefined);
    }
  }

  // --- Private ---

  private async startInstance(connection: PlatformConnection): Promise<void> {
    try {
      const { Chat } = await import("chat");
      const adapter = await this.createAdapter(connection);
      const stateAdapter = await this.createStateAdapter();

      const adapterKey = connection.platform;
      const chat = new Chat({
        userName: connection.metadata.botUsername || `bot-${connection.id}`,
        adapters: { [adapterKey]: adapter },
        state: stateAdapter,
        logger: "warn",
      });

      // Register message handlers (imported lazily to avoid circular deps)
      const { registerMessageHandlers } = await import(
        "./message-handler-bridge"
      );
      const { CommandDispatcher } = await import(
        "../commands/command-dispatcher"
      );
      const commandDispatcher = new CommandDispatcher({
        registry: this.services.getCommandRegistry(),
        channelBindingService: this.services.getChannelBindingService(),
      });
      registerMessageHandlers(
        chat,
        connection,
        this.services,
        this,
        commandDispatcher
      );

      chat.registerSingleton();

      // Initialize adapters (starts long-polling for Telegram, etc.)
      await chat.initialize();

      // Set webhook URL if applicable
      const mode = (connection.config as any).mode ?? "auto";
      const useWebhook =
        mode === "webhook" || (mode === "auto" && !!this.publicGatewayUrl);
      if (useWebhook && this.publicGatewayUrl) {
        const webhookUrl = `${this.publicGatewayUrl}/api/v1/webhooks/${connection.id}`;
        logger.info({ id: connection.id, webhookUrl }, "Setting webhook");
      }

      const cleanup = async () => {
        try {
          await chat.shutdown();
        } catch {
          // best effort
        }
      };

      // Populate metadata (bot username etc.) from adapter properties
      if (!connection.metadata.botUsername) {
        try {
          const userName = adapter.userName || adapter.botUsername;
          if (userName) {
            connection.metadata.botUsername = userName;
            await this.updateConnection(connection.id, {
              metadata: { botUsername: userName },
            });
          }
        } catch {
          // non-critical
        }
      }

      this.instances.set(connection.id, { connection, chat, cleanup });

      const { registerInteractionBridge } = await import(
        "./interaction-bridge"
      );
      registerInteractionBridge(
        this.services.getInteractionService(),
        this,
        connection,
        chat,
        this.services.getGrantStore()
      );

      // Register slash commands with the platform (e.g. Telegram menu)
      this.registerPlatformCommands(connection).catch((err) => {
        logger.warn(
          { id: connection.id, error: String(err) },
          "Failed to register platform commands"
        );
      });

      logger.info(
        { id: connection.id, platform: connection.platform },
        "Chat instance started"
      );
    } catch (error) {
      connection.status = "error";
      connection.errorMessage = String(error);
      logger.error(
        { id: connection.id, error: String(error) },
        "Failed to start Chat instance"
      );
      throw error;
    }
  }

  private async createAdapter(connection: PlatformConnection): Promise<any> {
    const factory = ADAPTER_FACTORIES[connection.platform];
    if (!factory) {
      throw new Error(`No adapter factory for: ${connection.platform}`);
    }
    return factory(connection.config);
  }

  private async createStateAdapter(): Promise<any> {
    const { createIoRedisState } = await import("@chat-adapter/state-ioredis");
    return createIoRedisState({
      client: this.redis,
      keyPrefix: "chat-conn",
      logger: "warn",
    } as any);
  }

  /**
   * Register slash commands with the platform's native command menu.
   * Currently supports Telegram (setMyCommands) and Slack (via manifest).
   */
  private async registerPlatformCommands(
    connection: PlatformConnection
  ): Promise<void> {
    const commands = this.services
      .getCommandRegistry()
      .getAll()
      .map((cmd) => ({
        command: cmd.name,
        description: cmd.description,
      }));

    if (connection.platform === "telegram") {
      const botToken = (connection.config as any).botToken;
      if (!botToken) return;

      const apiBase =
        (connection.config as any).apiBaseUrl || "https://api.telegram.org";
      const resp = await fetch(`${apiBase}/bot${botToken}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Telegram setMyCommands failed: ${resp.status} ${text}`
        );
      }

      logger.info(
        { id: connection.id, count: commands.length },
        "Telegram bot commands menu registered"
      );
    }
  }

  private resolveSlackAdapterConfig(options?: {
    requireOAuth?: boolean;
  }): PlatformAdapterConfig {
    const slackInstance = Array.from(this.instances.values()).find(
      (instance) => instance.connection.platform === "slack"
    );
    const currentConfig = (slackInstance?.connection.config || {}) as Record<
      string,
      any
    >;

    const signingSecret =
      process.env.SLACK_SIGNING_SECRET || currentConfig.signingSecret;
    const clientId = process.env.SLACK_CLIENT_ID || currentConfig.clientId;
    const clientSecret =
      process.env.SLACK_CLIENT_SECRET || currentConfig.clientSecret;
    const encryptionKey =
      process.env.SLACK_ENCRYPTION_KEY || currentConfig.encryptionKey;
    const installationKeyPrefix =
      process.env.SLACK_INSTALLATION_KEY_PREFIX ||
      currentConfig.installationKeyPrefix;
    const userName =
      process.env.SLACK_BOT_USERNAME ||
      currentConfig.userName ||
      slackInstance?.connection.metadata?.botUsername;

    if (!signingSecret) {
      throw new Error("Slack signing secret is not configured");
    }

    if (options?.requireOAuth) {
      if (!clientId || !clientSecret) {
        throw new Error(
          "Slack OAuth is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET."
        );
      }

      return {
        platform: "slack",
        signingSecret,
        clientId,
        clientSecret,
        ...(encryptionKey ? { encryptionKey } : {}),
        ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
        ...(userName ? { userName } : {}),
      };
    }

    const botToken = process.env.SLACK_BOT_TOKEN || currentConfig.botToken;
    if (!botToken && (!clientId || !clientSecret)) {
      throw new Error(
        "Slack adapter is not configured. Provide SLACK_BOT_TOKEN or Slack OAuth credentials."
      );
    }

    return {
      platform: "slack",
      signingSecret,
      ...(botToken ? { botToken } : {}),
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(encryptionKey ? { encryptionKey } : {}),
      ...(installationKeyPrefix ? { installationKeyPrefix } : {}),
      ...(userName ? { userName } : {}),
    };
  }

  private async createSlackOAuthChat(options?: { requireOAuth?: boolean }) {
    const { Chat } = await import("chat");
    const { createSlackAdapter } = await import("@chat-adapter/slack");

    const adapter = createSlackAdapter(
      this.resolveSlackAdapterConfig(options) as any
    );
    const state = await this.createStateAdapter();

    const chat = new Chat({
      userName: "lobu-slack-oauth",
      adapters: { slack: adapter },
      state,
      logger: "warn",
    });

    await chat.initialize();
    return { chat, adapter };
  }

  private cloneRequestWithBody(request: Request, body: string): Request {
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : body,
    });
  }

  private extractSlackTeamId(body: string, contentType: string): string | null {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(body);
      const directTeamId = params.get("team_id");
      if (directTeamId) {
        return directTeamId;
      }

      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return null;
      }

      try {
        const payload = JSON.parse(payloadStr) as {
          team?: { id?: string };
          team_id?: string;
        };
        return payload.team?.id || payload.team_id || null;
      } catch {
        return null;
      }
    }

    try {
      const payload = JSON.parse(body) as {
        team_id?: string;
        team?: string;
        event?: { team_id?: string; team?: string };
      };
      return (
        payload.team_id ||
        payload.team ||
        payload.event?.team_id ||
        payload.event?.team ||
        null
      );
    } catch {
      return null;
    }
  }

  private async ensureConnectionRunning(id: string): Promise<boolean> {
    if (this.has(id)) {
      return true;
    }

    // Don't auto-restart intentionally stopped connections
    const raw = await this.redis.get(`connection:${id}`);
    if (raw) {
      const connection = JSON.parse(raw) as PlatformConnection;
      if (connection.status === "stopped") {
        logger.info({ id }, "Connection is stopped, not auto-restarting");
        return false;
      }
    }

    try {
      await this.restartConnection(id);
      return this.has(id);
    } catch (error) {
      logger.error(
        { id, error: String(error) },
        "Failed to restart connection"
      );
      return false;
    }
  }

  private async persistConnection(
    connection: PlatformConnection
  ): Promise<void> {
    const encrypted = {
      ...connection,
      config: this.encryptConfig(connection.config),
    };
    const json = JSON.stringify(encrypted);

    const pipeline = this.redis
      .pipeline()
      .set(`connection:${connection.id}`, json)
      .sadd("connections:all", connection.id);

    if (connection.templateAgentId) {
      pipeline.sadd(
        `connections:agent:${connection.templateAgentId}`,
        connection.id
      );
    }

    await pipeline.exec();
  }

  private encryptConfig(config: PlatformAdapterConfig): PlatformAdapterConfig {
    const encrypted = { ...config } as any;
    for (const field of Object.keys(encrypted)) {
      if (isSecretField(field) && typeof encrypted[field] === "string") {
        try {
          encrypted[field] = `enc:v1:${encrypt(encrypted[field])}`;
        } catch {
          // encryption not available — store as-is (dev mode)
        }
      }
    }
    return encrypted;
  }

  private decryptConfig(config: PlatformAdapterConfig): PlatformAdapterConfig {
    const decrypted = { ...config } as any;
    for (const field of Object.keys(decrypted)) {
      const val = decrypted[field];
      if (
        isSecretField(field) &&
        typeof val === "string" &&
        val.startsWith("enc:v1:")
      ) {
        try {
          decrypted[field] = decrypt(val.slice(7));
        } catch {
          throw new Error(
            `Failed to decrypt field "${field}" — ENCRYPTION_KEY may have changed`
          );
        }
      }
    }
    return decrypted;
  }

  /** Return connection with secrets redacted for API responses. */
  private sanitizeConnection(
    connection: PlatformConnection
  ): PlatformConnection {
    const sanitized = {
      ...connection,
      config: { ...connection.config } as any,
    };
    for (const field of Object.keys(sanitized.config)) {
      if (isSecretField(field) && sanitized.config[field]) {
        const val = String(sanitized.config[field]);
        sanitized.config[field] = `***${val.slice(-4)}`;
      }
    }
    return sanitized;
  }
}
