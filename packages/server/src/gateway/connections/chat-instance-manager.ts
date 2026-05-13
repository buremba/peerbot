/**
 * ChatInstanceManager — manages Chat SDK instances for API-driven platform
 * connections. Owns Chat lifecycle and webhook dispatch.
 *
 * Persistence uses `agent_connections` (via AgentConnectionStore) as the
 * single source of truth — one row per connection, no separate
 * `chat_connections` table. Secret fields in the row's `config` JSON are
 * stored as `secret://...` refs that route through `SecretStoreRegistry`
 * at runtime, so any pluggable backend (Postgres / AWS SM / k8s / Vault)
 * can serve the underlying value. Plaintext values handed in by callers
 * are persisted via `secretStore.put()` and replaced with their refs
 * before the row is written.
 */

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { Chat } from "chat";
import type {
  AgentConnectionStore,
  StoredConnection,
} from "@lobu/core";
import { createLogger, isSecretRef } from "@lobu/core";
import type { CoreServices, PlatformAdapter } from "../platform.js";
import type { IFileHandler } from "../platform/file-handler.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  resolveSecretValue,
} from "../secrets/index.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import { orgContext, tryGetOrgId } from "../../lobu/stores/org-context.js";
import { getAgentOrganizationId } from "../../lobu/stores/postgres-stores.js";
import {
  ConversationStateStore,
  type HistoryEntry,
} from "./conversation-state-store.js";
import { createGatewayStateAdapter } from "./state-adapter.js";
import { SlackConnectionCoordinator } from "./slack-connection-coordinator.js";
import { SlackInstructionProvider } from "./slack-instruction-provider.js";
import {
  registerSlackAppHome,
  registerSlackPlatformHandlers,
} from "./slack-platform-bridge.js";
import { registerInteractionBridge } from "./interaction-bridge.js";
import {
  type MessageHandlerBridge,
  registerMessageHandlers,
} from "./message-handler-bridge.js";
import {
  type ConnectionSettings,
  isSlackConfig,
  isSecretField,
  isTelegramConfig,
  type PlatformAdapterConfig,
  type PlatformConnection,
  type TelegramAdapterConfig,
} from "./types.js";

/** Drain a Readable into a single Buffer. */
async function streamToBuffer(readable: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Read `botToken` from a Telegram connection config, or undefined. */
function telegramBotToken(config: TelegramAdapterConfig): string | undefined {
  return typeof config.botToken === "string" ? config.botToken : undefined;
}

/** Read `apiBaseUrl` from a Telegram connection config (with default). */
function telegramApiBase(config: TelegramAdapterConfig): string {
  return typeof config.apiBaseUrl === "string" && config.apiBaseUrl
    ? config.apiBaseUrl
    : "https://api.telegram.org";
}

/** Shallow structural equality for plain config objects. */
function configsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

const logger = createLogger("chat-instance-manager");

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
  gchat: async (c) =>
    (await import("@chat-adapter/gchat")).createGoogleChatAdapter(c),
};

interface ManagedInstance {
  connection: PlatformConnection;
  chat: any; // Chat SDK instance
  conversationState: ConversationStateStore;
  /**
   * Shared bridge exposing the inbound-enqueue pipeline. Kept on the instance
   * so the interaction bridge can feed button-clicks through the same
   * appendHistory + enqueueMessage path as typed messages.
   */
  messageBridge: MessageHandlerBridge;
  cleanup?: () => Promise<void>;
  interactionCleanup?: () => void;
}

export class ChatInstanceManager {
  private instances = new Map<string, ManagedInstance>();
  private services!: CoreServices;
  private publicGatewayUrl = "";
  private slackCoordinator!: SlackConnectionCoordinator;
  private connectionStore!: AgentConnectionStore;

  async initialize(services: CoreServices): Promise<void> {
    this.services = services;
    this.publicGatewayUrl = services.getPublicGatewayUrl();
    this.slackCoordinator = this.buildSlackCoordinator();

    const store = services.getConnectionStore();
    if (!store) {
      logger.warn("No AgentConnectionStore — chat connections disabled");
      return;
    }
    this.connectionStore = store;

    const connections = await this.connectionStore.listConnections();
    logger.debug(
      { count: connections.length },
      "Loading chat connections from agent_connections"
    );

    for (const stored of connections) {
      // StoredConnection.config holds `secret://` refs for sensitive
      // fields. startInstance() resolves them before handing config to
      // the Chat SDK adapter; if a ref is unresolvable (e.g. the
      // underlying secret was wiped), the connection is marked as
      // errored so an operator can repair or remove it.
      const connection = storedToPlatform(stored);

      try {
        if (connection.status === "active") {
          // Boot runs without an HTTP request, so AsyncLocalStorage has
          // no orgId. startInstance() now self-binds the connection's
          // agent org so PostgresSecretStore.get() resolves per-org
          // refs correctly; see comment on startInstance().
          await this.startInstance(connection);
        }
      } catch (error) {
        logger.error({ id: connection.id, error: String(error) }, "Failed to load connection");
        await this.connectionStore.updateConnection(connection.id, {
          status: "error",
          errorMessage: `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
        });
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
          instance.interactionCleanup?.();
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
    agentId: string | undefined,
    config: PlatformAdapterConfig,
    settings?: ConnectionSettings,
    metadata: Record<string, any> = {},
    stableId?: string
  ): Promise<PlatformConnection> {
    if (!(platform in ADAPTER_FACTORIES)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    if (config.platform !== platform) {
      throw new Error(
        `Config platform mismatch: expected ${platform}, got ${config.platform}`
      );
    }

    const id = stableId ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();

    const connection: PlatformConnection = {
      id,
      platform,
      ...(agentId ? { agentId } : {}),
      config,
      settings: settings ?? { allowGroups: true },
      metadata,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    // Persist first (sensitive fields are moved into the secret store as
    // refs) so a startInstance failure can't leave a running instance
    // with no row, and a persist failure can't leave a half-baked entry.
    await this.persistConnection(connection);

    try {
      await this.startInstance(connection);
    } catch (error) {
      // Roll back in the safe order: secrets first, then the row that
      // anchors them. If secret cleanup throws, the row stays so an
      // operator can retry deletion via the same code path; the
      // alternative (delete row first) leaves orphaned secrets with no
      // anchor for retry.
      try {
        await deleteSecretsByPrefix(
          this.services.getSecretStore(),
          `connections/${connection.id}/`
        );
      } catch {
        // best-effort
      }
      try {
        await this.connectionStore.deleteConnection(connection.id);
      } catch {
        // best-effort
      }
      throw error;
    }

    logger.info({ id, platform, agentId }, "Connection added");
    return connection;
  }

  async removeConnection(id: string): Promise<void> {
    const instance = await this.stopInstance(id);

    const conversationState =
      instance?.conversationState ??
      new ConversationStateStore(await this.createStateAdapter());

    // Cascade cleanups first, then drop the row last so a cleanup failure
    // leaves the row in place for an operator-driven retry rather than
    // orphaning history/secrets with no anchoring connection record.
    const historyDeleted = await conversationState.clearAllHistory(id);
    const secretsDeleted = await deleteSecretsByPrefix(
      this.services.getSecretStore(),
      `connections/${id}/`
    );
    await this.connectionStore.deleteConnection(id);

    logger.info(
      { id, historyDeleted, secretsDeleted },
      "Connection removed"
    );
  }

  async restartConnection(id: string): Promise<void> {
    await this.stopInstance(id);

    const stored = await this.connectionStore.getConnection(id);
    if (!stored) throw new Error(`Connection ${id} not found`);
    const connection = storedToPlatform(stored);

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
    await this.stopInstance(id);

    await this.connectionStore.updateConnection(id, {
      status: "stopped",
    });

    logger.info({ id }, "Connection stopped");
  }

  async updateConnection(
    id: string,
    updates: {
      agentId?: string | null;
      config?: PlatformAdapterConfig;
      settings?: ConnectionSettings;
      metadata?: Record<string, any>;
    }
  ): Promise<PlatformConnection> {
    const stored = await this.connectionStore.getConnection(id);
    if (!stored) throw new Error(`Connection ${id} not found`);
    const connection = storedToPlatform(stored);

    // Compute the merged config (skipping sanitized `***...` placeholders),
    // then decide whether a restart is needed.
    const previousConfig = connection.config as Record<string, unknown>;
    let nextConfig: Record<string, unknown> | undefined;
    if (updates.config !== undefined) {
      const merged = { ...previousConfig };
      for (const [key, value] of Object.entries(updates.config)) {
        if (typeof value === "string" && value.startsWith("***")) continue;
        merged[key] = value;
      }
      merged.platform = updates.config.platform;
      nextConfig = merged;
    }

    // previousConfig holds `secret://` refs; nextConfig from the caller
    // holds plaintext values. Resolve previous to plaintext before
    // comparing so an idempotent re-apply with the same bot token
    // doesn't trip a spurious restart.
    const previousResolved =
      nextConfig !== undefined
        ? ((await this.resolveConfigForRuntime(
            id,
            previousConfig as PlatformAdapterConfig
          )) as Record<string, unknown>)
        : previousConfig;

    const needsRestart =
      nextConfig !== undefined && !configsEqual(nextConfig, previousResolved);

    if (updates.agentId !== undefined) {
      if (updates.agentId) {
        connection.agentId = updates.agentId;
      } else {
        delete connection.agentId;
      }
    }
    if (nextConfig !== undefined) {
      connection.config = nextConfig as PlatformAdapterConfig;
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
      await this.stopInstance(id);
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
    agentId?: string;
  }): Promise<PlatformConnection[]> {
    const all = await this.connectionStore.listConnections(filter);
    return all.map((c) => this.sanitizeConnection(storedToPlatform(c)));
  }

  async getConnection(id: string): Promise<PlatformConnection | null> {
    const conn = await this.connectionStore.getConnection(id);
    return conn ? this.sanitizeConnection(storedToPlatform(conn)) : null;
  }

  has(id: string): boolean {
    return this.instances.has(id);
  }

  getInstance(id: string): ManagedInstance | undefined {
    return this.instances.get(id);
  }

  /**
   * Surface the channels with stored history for a given connection. Used
   * by the local-test-default-target route; falls back to constructing a
   * fresh state-store when the connection isn't currently active.
   */
  async listHistoryChannels(connectionId: string): Promise<string[]> {
    const instance = this.instances.get(connectionId);
    if (instance) {
      return instance.conversationState.listHistoryChannels(connectionId);
    }
    const conversationState = new ConversationStateStore(
      await this.createStateAdapter()
    );
    return conversationState.listHistoryChannels(connectionId);
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
      logger.warn(
        { connectionId, platform },
        "No webhook handler found for platform"
      );
      return new Response("No webhook handler", { status: 404 });
    }

    try {
      return await webhookHandler(request);
    } catch (error) {
      logger.error(
        { connectionId, platform, error: String(error) },
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
    return this.slackCoordinator.findConnectionByTeamId(teamId);
  }

  async getDefaultSlackConnection(): Promise<PlatformConnection | null> {
    return this.slackCoordinator.getDefaultConnection();
  }

  async ensureSlackWorkspaceConnection(
    teamId: string,
    installation: {
      botToken: string;
      botUserId?: string;
      teamName?: string;
    }
  ): Promise<PlatformConnection> {
    return this.slackCoordinator.ensureWorkspaceConnection(
      teamId,
      installation
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
    return this.slackCoordinator.completeOAuthInstall(request, redirectUri);
  }

  async handleSlackAppWebhook(request: Request): Promise<Response> {
    return this.slackCoordinator.handleAppWebhook(request);
  }

  // --- Private ---

  /**
   * Tear down a running managed instance (interaction bridge + chat shutdown)
   * and drop it from the registry. No-op if no instance is tracked for `id`.
   * Returns the instance that was removed, if any, so callers can reuse its
   * conversation-state store.
   */
  private async stopInstance(
    id: string
  ): Promise<ManagedInstance | undefined> {
    const instance = this.instances.get(id);
    if (instance) {
      instance.interactionCleanup?.();
      await instance.cleanup?.();
      this.instances.delete(id);
    }
    return instance;
  }

  private async startInstance(connection: PlatformConnection): Promise<void> {
    // Multi-tenant secret resolution: PostgresSecretStore.get/put route
    // by AsyncLocalStorage org context (see #516). Some callers reach
    // here with org context already bound (HTTP routes via agent-routes
    // middleware); others don't (boot-time initialize(), the public
    // /slack/events webhook, anywhere ensureConnectionRunning() is
    // triggered without an HTTP request). Self-binding the connection's
    // owning org keeps per-org secret refs resolvable from every entry
    // point — no caller has to remember.
    const callerOrgId = tryGetOrgId();
    if (!callerOrgId && connection.agentId) {
      const organizationId = await getAgentOrganizationId(
        connection.agentId
      );
      if (organizationId) {
        return orgContext.run({ organizationId }, () =>
          this.startInstanceUnscoped(connection)
        );
      }
    }
    return this.startInstanceUnscoped(connection);
  }

  private async startInstanceUnscoped(
    connection: PlatformConnection
  ): Promise<void> {
    try {
      // Resolve any `secret://` refs in the connection config to plaintext
      // values for the Chat SDK adapter. This is idempotent — addConnection
      // calls us with plaintext (the caller-supplied values), and reload /
      // restart paths call us with refs read from agent_connections; the
      // resolver leaves non-ref values alone.
      connection.config = await this.resolveConfigForRuntime(
        connection.id,
        connection.config
      );

      const adapter = await this.createAdapter(connection);
      const stateAdapter = await this.createStateAdapter();
      const conversationState = new ConversationStateStore(stateAdapter);

      const adapterKey = connection.platform;
      const chat = new Chat({
        userName: connection.metadata.botUsername || `bot-${connection.id}`,
        adapters: { [adapterKey]: adapter },
        state: stateAdapter,
        logger: "warn",
      });

      const commandDispatcher = new CommandDispatcher({
        registry: this.services.getCommandRegistry(),
        channelBindingService: this.services.getChannelBindingService(),
      });
      const messageBridge = registerMessageHandlers(
        chat,
        connection,
        this.services,
        this,
        commandDispatcher
      );
      registerSlackPlatformHandlers(chat, connection, commandDispatcher);
      registerSlackAppHome(chat, connection, {
        // The initialized adapter (with the live Slack WebClient) — `chat.initialize()`
        // below mutates it to add `.client`; event handlers fire only afterwards.
        adapter,
        mcpConfigService: this.services.getMcpConfigService(),
        secretStore: this.services.getSecretStore(),
        publicGatewayUrl: this.publicGatewayUrl,
      });

      chat.registerSingleton();

      // Initialize adapters (starts long-polling for Telegram, etc.)
      await chat.initialize();

      // Set webhook URL if applicable
      const mode = isTelegramConfig(connection.config)
        ? (connection.config.mode ?? "auto")
        : "auto";
      const useWebhook =
        mode === "webhook" || (mode === "auto" && !!this.publicGatewayUrl);
      if (useWebhook && this.publicGatewayUrl) {
        const webhookUrl = `${this.publicGatewayUrl}/api/v1/webhooks/${connection.id}`;
        logger.info({ id: connection.id, webhookUrl }, "Setting webhook");
        try {
          await this.configurePlatformWebhook(connection, webhookUrl);
        } catch (error) {
          // Webhook registration failure is non-fatal — the adapter can still
          // receive messages if the webhook URL was set externally (e.g. from
          // a previous deploy or manual configuration).
          logger.warn(
            { id: connection.id, error: String(error) },
            "Webhook registration failed, continuing without it"
          );
        }
      }

      const cleanup = async () => {
        try {
          await chat.shutdown();
        } catch {
          // best effort
        }
      };

      // Populate metadata (bot username, bot user id) from adapter properties.
      // Slack adapters call `auth.test` during initialize and expose `botUserId`
      // via a getter; we mirror it onto connection.metadata so message-bridge
      // mention-strip and the Slack instruction provider can find it.
      try {
        const metadataUpdate: Record<string, string> = {};
        if (!connection.metadata.botUsername) {
          const userName = adapter.userName || adapter.botUsername;
          if (userName) {
            metadataUpdate.botUsername = userName;
          }
        }
        if (!connection.metadata.botUserId) {
          const botUserId = adapter.botUserId;
          if (botUserId) {
            metadataUpdate.botUserId = botUserId;
          }
        }
        if (Object.keys(metadataUpdate).length > 0) {
          Object.assign(connection.metadata, metadataUpdate);
          await this.updateConnection(connection.id, {
            metadata: metadataUpdate,
          });
        }
      } catch {
        // non-critical
      }

      this.instances.set(connection.id, {
        connection,
        chat,
        conversationState,
        messageBridge,
        cleanup,
      });

      const mcpProxy = this.services.getMcpProxy();
      const interactionCleanup = registerInteractionBridge(
        this.services.getInteractionService(),
        this,
        connection,
        chat,
        this.services.getGrantStore(),
        mcpProxy?.executeToolDirect.bind(mcpProxy)
      );
      this.instances.get(connection.id)!.interactionCleanup =
        interactionCleanup;

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
    return createGatewayStateAdapter();
  }

  /**
   * Register slash commands with the platform's native command menu.
   * Currently supports Telegram (setMyCommands) and Slack (via manifest).
   */
  private async configurePlatformWebhook(
    connection: PlatformConnection,
    webhookUrl: string
  ): Promise<void> {
    if (!isTelegramConfig(connection.config)) return;
    const config = connection.config;

    const botToken = telegramBotToken(config);
    if (!botToken) return;

    const apiBase = telegramApiBase(config);
    const body: Record<string, unknown> = { url: webhookUrl };
    const secretToken = config.secretToken;
    if (typeof secretToken === "string" && secretToken.length > 0) {
      body.secret_token = secretToken;
    }

    const resp = await fetch(`${apiBase}/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Telegram setWebhook failed: ${resp.status} ${text}`);
    }
  }

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

    if (isTelegramConfig(connection.config)) {
      const botToken = telegramBotToken(connection.config);
      if (!botToken) return;

      const apiBase = telegramApiBase(connection.config);
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

  private findRunningInstanceByPlatform(
    platform: string
  ): ManagedInstance | undefined {
    return Array.from(this.instances.values()).find(
      (instance) => instance.connection.platform === platform
    );
  }

  private buildSlackCoordinator(): SlackConnectionCoordinator {
    return new SlackConnectionCoordinator({
      addConnection: this.addConnection.bind(this),
      createStateAdapter: this.createStateAdapter.bind(this),
      ensureConnectionRunning: this.ensureConnectionRunning.bind(this),
      forwardWebhook: this.handleWebhook.bind(this),
      getCurrentSlackConfig: () => {
        const slackInstance = this.findRunningInstanceByPlatform("slack");
        const currentConfig = (slackInstance?.connection.config || {}) as
          | Record<string, any>
          | undefined;

        return {
          signingSecret: currentConfig?.signingSecret,
          clientId: currentConfig?.clientId,
          clientSecret: currentConfig?.clientSecret,
          encryptionKey: currentConfig?.encryptionKey,
          installationKeyPrefix: currentConfig?.installationKeyPrefix,
          userName:
            currentConfig?.userName ||
            slackInstance?.connection.metadata?.botUsername,
          botToken: currentConfig?.botToken,
        };
      },
      getRunningChat: (connectionId) => this.getInstance(connectionId)?.chat,
      hasConnection: this.has.bind(this),
      listSlackConnections: () => this.listConnections({ platform: "slack" }),
      restartConnection: this.restartConnection.bind(this),
      updateConnection: this.updateConnection.bind(this),
    });
  }

  private async ensureConnectionRunning(id: string): Promise<boolean> {
    if (this.has(id)) {
      return true;
    }

    // Don't auto-restart intentionally stopped connections
    const stored = await this.connectionStore.getConnection(id);
    if (stored?.status === "stopped") {
      logger.info({ id }, "Connection is stopped, not auto-restarting");
      return false;
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
    // Move plaintext secrets into the SecretStoreRegistry and store only
    // the returned `secret://` refs in the row's config JSON. Idempotent
    // — already-ref values pass through untouched.
    const persistedConfig = await this.normalizeConfigForStorage(
      connection.id,
      connection.config
    );
    await this.connectionStore.saveConnection({
      ...connection,
      config: persistedConfig,
    });
  }

  /**
   * Replace any plaintext secret-field value with a `secret://` ref by
   * persisting it via the secret store. Already-ref values are left as-is
   * so re-saving an unchanged config is a no-op.
   */
  private async normalizeConfigForStorage(
    connectionId: string,
    config: PlatformAdapterConfig
  ): Promise<PlatformAdapterConfig> {
    const normalized = { ...config } as Record<string, unknown>;
    const secretStore = this.services.getSecretStore();

    for (const field of Object.keys(normalized)) {
      const value = normalized[field];
      if (!isSecretField(field) || typeof value !== "string") continue;
      if (isSecretRef(value)) continue;
      normalized[field] = await persistSecretValue(
        secretStore,
        `connections/${connectionId}/${field}`,
        value
      );
    }

    return normalized as PlatformAdapterConfig;
  }

  /**
   * Resolve every `secret://` ref in a connection's config back to its
   * underlying value. Throws if any ref points at a missing/deleted secret
   * — the caller (startInstance / restartConnection) should mark the
   * connection as errored rather than boot with a half-resolved config.
   */
  private async resolveConfigForRuntime(
    connectionId: string,
    config: PlatformAdapterConfig
  ): Promise<PlatformAdapterConfig> {
    const resolved = { ...config } as Record<string, unknown>;
    const secretStore = this.services.getSecretStore();

    for (const field of Object.keys(resolved)) {
      const value = resolved[field];
      if (!isSecretField(field) || typeof value !== "string") continue;
      if (!isSecretRef(value)) continue;

      const secretValue = await resolveSecretValue(secretStore, value);
      if (secretValue === undefined) {
        throw new Error(
          `Failed to resolve secret ref for connection ${connectionId} field "${field}"`
        );
      }
      resolved[field] = secretValue;
    }

    return resolved as PlatformAdapterConfig;
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

  // ============================================================================
  // Platform adapter methods (used via PlatformRegistry)
  // ============================================================================

  /**
   * Create PlatformAdapter objects for each chat platform.
   * These are lightweight adapters that delegate to this manager.
   */
  createPlatformAdapters(): PlatformAdapter[] {
    return Object.keys(ADAPTER_FACTORIES).map((name) =>
      this.createPlatformAdapter(name)
    );
  }

  private createPlatformAdapter(name: string): PlatformAdapter {
    return {
      name,
      initialize: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      start: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      stop: async () => {
        /* no-op: lifecycle managed by ChatInstanceManager */
      },
      isHealthy: () => true,
      extractRoutingInfo: (body: Record<string, unknown>) =>
        this.extractPlatformRoutingInfo(name, body),
      sendMessage: (
        token: string,
        message: string,
        options: {
          agentId: string;
          channelId: string;
          conversationId?: string;
          teamId: string;
          files?: Array<{ buffer: Buffer; filename: string }>;
        }
      ) => this.routePlatformMessage(name, token, message, options),
      getFileHandler: (options) => this.getPlatformFileHandler(name, options),
      ...(name === "slack"
        ? {
            getInstructionProvider: () => new SlackInstructionProvider(this),
          }
        : {}),
      getConversationHistory: (
        channelId: string,
        conversationId: string | undefined,
        limit: number,
        before: string | undefined
      ) =>
        this.getPlatformConversationHistory(
          name,
          channelId,
          conversationId,
          limit,
          before
        ),
    };
  }

  private getPlatformFileHandler(
    name: string,
    options?: {
      connectionId?: string;
      channelId?: string;
      conversationId?: string;
      teamId?: string;
    }
  ): IFileHandler | undefined {
    const instance = this.resolveFileHandlerInstance(name, options);
    if (!instance) {
      return undefined;
    }

    if (name === "telegram") {
      return this.createTelegramFileHandler(instance.connection);
    }

    if (name === "slack") {
      return this.createSlackFileHandler(instance);
    }

    if (name === "discord" || name === "teams") {
      return this.createChatSdkFileHandler(instance);
    }

    return undefined;
  }

  private resolveFileHandlerInstance(
    name: string,
    options?: {
      connectionId?: string;
      channelId?: string;
      conversationId?: string;
      teamId?: string;
    }
  ): ManagedInstance | undefined {
    if (options?.connectionId) {
      const directInstance = this.instances.get(options.connectionId);
      if (directInstance?.connection.platform === name) {
        return directInstance;
      }
    }

    return Array.from(this.instances.values()).find((instance) => {
      if (instance.connection.platform !== name) {
        return false;
      }
      if (options?.teamId) {
        const configuredTeamId =
          typeof instance.connection.metadata.teamId === "string"
            ? instance.connection.metadata.teamId
            : undefined;
        if (configuredTeamId && configuredTeamId !== options.teamId) {
          return false;
        }
      }
      return true;
    });
  }

  private createTelegramFileHandler(
    connection: PlatformConnection
  ): IFileHandler | undefined {
    if (!isTelegramConfig(connection.config)) return undefined;
    const botToken = telegramBotToken(connection.config);
    if (!botToken) return undefined;

    const apiBaseUrl = telegramApiBase(connection.config).replace(/\/$/, "");
    const botUsername =
      typeof connection.metadata.botUsername === "string"
        ? connection.metadata.botUsername.replace(/^@/, "")
        : undefined;

    const parseTelegramTarget = (
      channelId: string,
      conversationId?: string
    ): { chatId: string; messageThreadId?: number } => {
      if (conversationId?.startsWith("telegram:")) {
        const [, chatId, rawThreadId] = conversationId.split(":");
        const messageThreadId = Number.parseInt(rawThreadId || "", 10);
        return {
          chatId: chatId || channelId,
          messageThreadId: Number.isFinite(messageThreadId)
            ? messageThreadId
            : undefined,
        };
      }
      return { chatId: channelId };
    };

    const buildTelegramPermalink = (
      chatId: string,
      messageId: number
    ): string => {
      if (/^-100\d+$/.test(chatId)) {
        return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
      }
      if (botUsername) {
        return `https://t.me/${botUsername}`;
      }
      return `telegram://chat/${chatId}/${messageId}`;
    };

    const telegramApiRequest = async (
      method: string,
      body: FormData | URLSearchParams
    ) => {
      const response = await fetch(`${apiBaseUrl}/bot${botToken}/${method}`, {
        method: "POST",
        body,
      });
      const text = await response.text();
      let payload: any = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok || payload?.ok === false || !payload?.result) {
        throw new Error(
          `Telegram ${method} failed: ${response.status} ${text}`
        );
      }
      return payload.result;
    };

    return {
      uploadFile: async (fileStream, options) => {
        const target = parseTelegramTarget(options.channelId, options.threadTs);
        const buffer = await streamToBuffer(fileStream);
        const form = new FormData();
        form.set("chat_id", target.chatId);
        if (target.messageThreadId) {
          form.set("message_thread_id", String(target.messageThreadId));
        }
        if (options.initialComment) {
          form.set("caption", options.initialComment);
        }
        form.set(
          options.voiceMessage ? "voice" : "document",
          new Blob([buffer]),
          options.filename
        );

        const result = await telegramApiRequest(
          options.voiceMessage ? "sendVoice" : "sendDocument",
          form
        );
        const media = options.voiceMessage ? result.voice : result.document;
        const fileId = String(media?.file_id || result.document?.file_id || "");
        if (!fileId) {
          throw new Error("Telegram upload did not return a file_id");
        }
        const messageId = Number(result.message_id || 0);
        return {
          fileId,
          permalink: buildTelegramPermalink(target.chatId, messageId),
          name: options.filename,
          size: buffer.length,
        };
      },
    };
  }

  /**
   * Post a Postable (carrying a file buffer) to a thread or channel on a
   * managed Chat instance. Shared by every Chat-SDK-backed file handler
   * (Slack, Discord, Teams). `threadId` / `channelKey` are already the
   * canonical platform-prefixed ids the Chat SDK expects.
   */
  private async postFileToChatTarget(
    instance: ManagedInstance,
    target: { threadId?: string; channelKey: string },
    postable: { raw: string; files: Array<{ data: Buffer; filename: string }> }
  ): Promise<any> {
    const { chat } = instance;
    const platform = instance.connection.platform;

    if (target.threadId) {
      const adapter = chat.getAdapter?.(platform);
      const createThread = (chat as any).createThread;
      if (!adapter || typeof createThread !== "function") {
        throw new Error(`Chat instance has no createThread for ${platform}`);
      }
      // `undefined` (not `{}`) — empty object makes Chat SDK crash in
      // handleStream reading `_currentMessage.author.userId`.
      const thread = await createThread.call(
        chat,
        adapter,
        target.threadId,
        undefined,
        false
      );
      if (!thread) {
        throw new Error(
          `Unable to resolve ${platform} thread ${target.threadId} for upload`
        );
      }
      return thread.post(postable);
    }

    const channel = chat.channel?.(target.channelKey);
    if (!channel) {
      throw new Error(
        `Unable to resolve ${platform} channel ${target.channelKey} for upload`
      );
    }
    return channel.post(postable);
  }

  private createSlackFileHandler(
    instance: ManagedInstance
  ): IFileHandler | undefined {
    if (!isSlackConfig(instance.connection.config)) return undefined;
    if (typeof instance.connection.config.botToken !== "string") {
      return undefined;
    }
    const platform = instance.connection.platform;

    // For Slack, `conversationId` is the Chat SDK's canonical `thread.id`
    // (`slack:{channel}:{parent_thread_ts}`) for group threads, or the bare
    // channel id for DMs/channel-level posts (no thread_ts).
    const parseSlackThread = (
      channelId: string,
      conversationId?: string
    ): { channel: string; threadTs?: string } => {
      if (conversationId?.startsWith("slack:")) {
        const [, channel, threadTs] = conversationId.split(":");
        return {
          channel: channel || channelId,
          threadTs: threadTs && threadTs !== "" ? threadTs : undefined,
        };
      }
      return { channel: channelId };
    };

    return {
      // Use the Chat SDK's Postable.files mechanism — the slack adapter handles
      // files.uploadV2 internally. We resolve a Thread (in-thread reply) or
      // Channel (top-level) and post a Postable carrying the file buffer.
      uploadFile: async (fileStream, options) => {
        const target = parseSlackThread(options.channelId, options.threadTs);
        const buffer = await streamToBuffer(fileStream);

        const sent = await this.postFileToChatTarget(
          instance,
          {
            threadId: target.threadTs
              ? `${platform}:${target.channel}:${target.threadTs}`
              : undefined,
            channelKey: `${platform}:${target.channel}`,
          },
          {
            raw: options.initialComment || "",
            files: [{ data: buffer, filename: options.filename }],
          }
        );

        const uploadedFile = (sent?.attachments || sent?.files || [])[0] as
          | { id?: string; permalink?: string; name?: string; size?: number }
          | undefined;
        const fileId = String(
          uploadedFile?.id || sent?.id || sent?.messageId || sent?.ts || ""
        );
        return {
          fileId,
          permalink: uploadedFile?.permalink || "",
          name: uploadedFile?.name || options.filename,
          size: Number(uploadedFile?.size || buffer.length),
        };
      },
    };
  }

  // Generic file handler for platforms whose Chat SDK adapter already supports
  // Postable.files (Discord, Teams). The conversationId arriving as `threadTs`
  // is the canonical platform-prefixed thread ID (e.g. `discord:guildId:channelId`).
  private createChatSdkFileHandler(instance: ManagedInstance): IFileHandler {
    const platform = instance.connection.platform;

    return {
      uploadFile: async (fileStream, options) => {
        const buffer = await streamToBuffer(fileStream);
        const sent = await this.postFileToChatTarget(
          instance,
          {
            threadId: options.threadTs,
            channelKey: `${platform}:${options.channelId}`,
          },
          {
            raw: options.initialComment || "",
            files: [{ data: buffer, filename: options.filename }],
          }
        );

        return {
          fileId: String(sent?.id || sent?.messageId || sent?.ts || Date.now()),
          permalink: "",
          name: options.filename,
          size: buffer.length,
        };
      },
    };
  }

  private extractPlatformRoutingInfo(
    name: string,
    body: Record<string, unknown>
  ): { channelId: string; conversationId?: string; teamId?: string } | null {
    if (name === "slack") {
      const slack = body.slack as
        | { channel?: string; thread?: string; team?: string }
        | undefined;
      if (!slack?.channel) return null;
      return {
        channelId: slack.channel,
        conversationId: slack.thread,
        teamId: slack.team,
      };
    }

    if (name === "telegram") {
      const telegram = body.telegram as
        | { chatId?: string | number }
        | undefined;
      if (!telegram?.chatId) return null;
      return {
        channelId: String(telegram.chatId),
        conversationId: String(telegram.chatId),
      };
    }

    const whatsapp = body.whatsapp as { chat?: string } | undefined;
    if (!whatsapp?.chat) return null;
    return {
      channelId: whatsapp.chat,
      conversationId: whatsapp.chat,
    };
  }

  async routePlatformMessage(
    name: string,
    token: string,
    message: string,
    options: {
      agentId: string;
      channelId: string;
      conversationId?: string;
      teamId: string;
      files?: Array<{ buffer: Buffer; filename: string }>;
    }
  ): Promise<{
    messageId: string;
    eventsUrl?: string;
    queued?: boolean;
  }> {
    if (options.files?.length) {
      throw new Error(
        `Platform "${name}" does not support file uploads via Chat SDK routing yet`
      );
    }

    const connection = await this.selectConnectionForPlatform(
      name,
      options.channelId,
      options.teamId
    );
    if (!connection) {
      throw new Error(`No active ${name} connection is available`);
    }

    const sessionManager = this.services.getSessionManager();
    const queueProducer = this.services.getQueueProducer();
    const agentSettingsStore = this.services.getAgentSettingsStore();
    const messageId = randomUUID();
    const conversationId = options.conversationId || options.channelId;
    const sessionId = `platform-chat:${name}:${options.channelId}:${conversationId}`;
    const sessionUserId = `${name}-${token.slice(0, 8) || "anonymous"}`;

    const agentOptions = await resolveAgentOptions(
      options.agentId,
      {},
      agentSettingsStore
    );

    await sessionManager.setSession({
      conversationId: sessionId,
      channelId: sessionId,
      userId: sessionUserId,
      threadCreator: sessionUserId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      status: "created",
      agentId: options.agentId,
    });

    await queueProducer.enqueueMessage({
      userId: options.channelId,
      conversationId,
      messageId,
      channelId: options.channelId,
      teamId: options.teamId,
      agentId: options.agentId,
      botId: `${name}-platform`,
      platform: name,
      messageText: message,
      platformMetadata: {
        connectionId: connection.id,
        chatId: options.channelId,
        // Construct the platform-prefixed full thread id so the Chat SDK's
        // `createThread` can decode it. Only set for real threaded replies
        // (conversationId !== channelId); otherwise leave unset and let the
        // DM shortcut in resolveTarget handle routing.
        ...(options.conversationId &&
        options.conversationId !== options.channelId
          ? {
              responseThreadId: `${name}:${options.channelId}:${options.conversationId}`,
            }
          : {}),
        sessionId,
        source: "platform-cli",
      },
      agentOptions,
    });

    logger.info(
      `Queued platform message via ${name}: agentId=${options.agentId}, channelId=${options.channelId}, conversationId=${conversationId}, sessionId=${sessionId}`
    );

    return {
      messageId,
      eventsUrl: `/api/v1/agents/${encodeURIComponent(sessionId)}/events`,
      queued: true,
    };
  }

  async getPlatformConversationHistory(
    name: string,
    channelId: string,
    _conversationId: string | undefined,
    limit: number,
    before: string | undefined
  ): Promise<{
    messages: Array<{
      timestamp: string;
      user: string;
      text: string;
      isBot?: boolean;
    }>;
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const connection = await this.selectConnectionForPlatform(name, channelId);
    if (!connection) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    const instance = this.getInstance(connection.id);
    if (!instance) {
      return { messages: [], nextCursor: null, hasMore: false };
    }

    let entries: HistoryEntry[] = await instance.conversationState.getEntries(
      connection.id,
      channelId
    );

    if (before) {
      const cutoff = Date.parse(before);
      if (!Number.isNaN(cutoff)) {
        entries = entries.filter((entry) => entry.timestamp < cutoff);
      }
    }

    const hasMore = entries.length > limit;
    const selected = entries.slice(-limit);
    const nextCursor =
      hasMore && selected[0]
        ? new Date(selected[0].timestamp).toISOString()
        : null;

    return {
      messages: selected.map((entry) => ({
        timestamp: new Date(entry.timestamp).toISOString(),
        user:
          entry.authorName ||
          (entry.role === "assistant" ? "assistant" : "user"),
        text: entry.content,
        isBot: entry.role === "assistant",
      })),
      nextCursor,
      hasMore,
    };
  }

  private async selectConnectionForPlatform(
    name: string,
    channelId: string,
    teamId?: string
  ): Promise<PlatformConnection | null> {
    const connections = await this.listConnections({ platform: name });
    const activeConnections = connections.filter((connection) =>
      this.has(connection.id)
    );
    if (activeConnections.length === 0) return null;
    if (activeConnections.length === 1) return activeConnections[0] || null;

    const teamMatch = activeConnections.find(
      (connection) => connection.metadata?.teamId === teamId
    );
    if (teamMatch) return teamMatch;

    // Fallback: prefer a connection that already has history for this channel.
    for (const connection of activeConnections) {
      const instance = this.getInstance(connection.id);
      if (!instance) continue;
      if (
        await instance.conversationState.hasHistory(connection.id, channelId)
      ) {
        return connection;
      }
    }

    return activeConnections[0] || null;
  }
}

/** Convert a StoredConnection (decrypted config) to a PlatformConnection. */
function storedToPlatform(stored: StoredConnection): PlatformConnection {
  const out: PlatformConnection = {
    id: stored.id,
    platform: stored.platform,
    config: stored.config as PlatformAdapterConfig,
    // @lobu/core's ConnectionSettings widens userConfigScopes to string[]
    // for cross-package portability; the values are still members of the
    // local UserConfigScope union (validated at the API boundary).
    settings: stored.settings as ConnectionSettings,
    metadata: stored.metadata,
    status: stored.status,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
  if (stored.agentId) out.agentId = stored.agentId;
  if (stored.errorMessage) out.errorMessage = stored.errorMessage;
  return out;
}
