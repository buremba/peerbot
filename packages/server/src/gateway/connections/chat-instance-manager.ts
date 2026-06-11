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
import type { AgentConnectionStore, StoredConnection } from "@lobu/core";
import { createLogger, isSecretRef } from "@lobu/core";
import { type AdapterPostableMessage, Chat } from "chat";
import { orgContext, tryGetOrgId } from "../../lobu/stores/org-context.js";
import { CommandDispatcher } from "../commands/command-dispatcher.js";
import type { IFileHandler } from "../platform/file-handler.js";
import type { CoreServices, PlatformAdapter } from "../platform.js";
import {
  deleteSecretsByPrefix,
  persistSecretValue,
  resolveSecretValue,
} from "../secrets/index.js";
import { resolveAgentOptions } from "../services/platform-helpers.js";
import {
  ConversationStateStore,
  type HistoryEntry,
} from "./conversation-state-store.js";
import { registerInteractionBridge } from "./interaction-bridge.js";
import {
  type MessageHandlerBridge,
  registerMessageHandlers,
} from "./message-handler-bridge.js";
import { getPlatformDescriptor, PLATFORM_REGISTRY } from "./platforms/index.js";
import { SlackConnectionCoordinator } from "./slack-connection-coordinator.js";
import {
  registerSlackAppHome,
  registerSlackPlatformHandlers,
} from "./slack-platform-bridge.js";
import { createGatewayStateAdapter } from "./state-adapter.js";
import {
  type ConnectionSettings,
  isSecretField,
  type PlatformAdapterConfig,
  type PlatformConnection,
} from "./types.js";

/**
 * Stable canonical JSON serialization: object keys sorted recursively so two
 * structurally-equal configs serialize identically regardless of key insertion
 * order. Arrays preserve order (order is significant for things like scope
 * lists). Used by `configsEqual` to deep-compare nested config (Discord/Teams
 * OAuth blocks, scope arrays) — a shallow `!==` compares nested objects by
 * reference and never sees a changed inner field, so a stale config would
 * persist without restarting the adapter.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(
          (value as Record<string, unknown>)[key]
        )}`
    );
  return `{${entries.join(",")}}`;
}

/** Deep structural equality for plain config objects (nested-aware). */
function configsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return stableStringify(a) === stableStringify(b);
}

const logger = createLogger("chat-instance-manager");


/**
 * Platforms that are valid to declare on an agent but have no chat adapter to
 * run. `rest` is the HTTP Agent API (`POST /lobu/api/v1/agents/:id/messages`),
 * which is registered unconditionally in gateway/routes/public/agent.ts —
 * declaring it just persists the `agent_connections` row so `lobu apply`
 * converges; there is no instance to start/stop/restart and no webhook to
 * route. Deliberately NOT in the platform descriptor registry:
 * createPlatformAdapters() derives the PlatformRegistry entries from it, and
 * an adapterless platform must not get a registry entry either. Stateless by
 * construction, so it is multi-replica safe — every pod's boot reconciliation
 * sees the row as healthy (`active`) rather than retrying a doomed adapter
 * start.
 */
const ADAPTERLESS_PLATFORMS = new Set<string>(["rest"]);

function isAdapterlessPlatform(platform: string): boolean {
  return ADAPTERLESS_PLATFORMS.has(platform);
}

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

  /**
   * Public gateway base URL (`PUBLIC_WEB_URL` or derived) — exposed so the
   * response bridge can build links into the admin UI (e.g. the
   * provider-settings page) for user-facing error messages.
   */
  getPublicGatewayUrl(): string {
    return this.publicGatewayUrl;
  }

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

      // Apply platform config guards before startInstance (e.g. Telegram's
      // cloud-mode polling rejection) — otherwise a previously-persisted
      // refused config would silently start at boot and bypass the
      // create-time rejection in `addConnection()`. Mark the row errored so
      // an operator notices.
      const message =
        connection.status === "active"
          ? getPlatformDescriptor(connection.platform)?.getConfigRejection?.(
              connection.config
            )
          : undefined;
      if (message) {
        logger.warn(
          { id: connection.id, agentId: connection.agentId },
          `Refusing to boot ${connection.platform} connection: ${message}`
        );
        // Self-bind the connection's owning org so the PostgreSQL-backed
        // store's per-tenant predicate is satisfied — boot has no HTTP
        // request and thus no ALS org context.
        try {
          const orgId = connection.organizationId;
          const markErrored = () =>
            this.connectionStore.updateConnection(connection.id, {
              status: "error",
              errorMessage: message,
            });
          if (orgId) {
            await orgContext.run({ organizationId: orgId }, markErrored);
          } else {
            await markErrored();
          }
        } catch (markErr) {
          logger.error(
            { id: connection.id, error: String(markErr) },
            "Failed to mark Telegram polling connection as errored"
          );
        }
        continue;
      }

      try {
        // Retry `error` rows alongside `active`: a previous boot's failure
        // (transient deploy issue, temporary env breakage like the #692
        // encryption-key parser regression) leaves the row stuck in `error`
        // forever even after the underlying bug is fixed, because nothing
        // else flips it back. `stopped` is operator-driven so we still
        // skip those. On success startInstance() clears the error state
        // when persistConnection() runs through a later restart/update.
        if (connection.status === "active" || connection.status === "error") {
          // Boot runs without an HTTP request, so AsyncLocalStorage has
          // no orgId. startInstance() now self-binds the connection's
          // agent org so PostgresSecretStore.get() resolves per-org
          // refs correctly; see comment on startInstance().
          await this.startInstance(connection);
          if (connection.status === "error") {
            // Recovered from a previous boot's failure — clear the error
            // marker so the UI reflects reality. Bound to the connection's
            // own org so the per-tenant WHERE predicate is satisfied.
            const recoveryOrgId = connection.organizationId;
            const clearError = () =>
              this.connectionStore.updateConnection(connection.id, {
                status: "active",
                errorMessage: undefined,
              });
            if (recoveryOrgId) {
              await orgContext.run(
                { organizationId: recoveryOrgId },
                clearError
              );
            } else {
              await clearError();
            }
            logger.info(
              { id: connection.id },
              "Recovered previously-errored connection"
            );
          }
        }
      } catch (error) {
        logger.error(
          { id: connection.id, error: String(error) },
          "Failed to load connection"
        );
        // Mark the row errored under the connection's own org context:
        // boot has no HTTP request and no ALS org id, and the postgres
        // store's saveConnection() requires getOrgId() — without the
        // wrap the error-marker write itself throws and the row is left
        // in `active`, masking the failure.
        const errOrgId = connection.organizationId;
        const markErrored = () =>
          this.connectionStore.updateConnection(connection.id, {
            status: "error",
            errorMessage: `Startup failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        try {
          if (errOrgId) {
            await orgContext.run({ organizationId: errOrgId }, markErrored);
          } else {
            await markErrored();
          }
        } catch (markErr) {
          logger.error(
            { id: connection.id, error: String(markErr) },
            "Failed to mark connection as errored"
          );
        }
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
    const descriptor = getPlatformDescriptor(platform);
    if (!descriptor && !isAdapterlessPlatform(platform)) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    if (config.platform !== platform) {
      throw new Error(
        `Config platform mismatch: expected ${platform}, got ${config.platform}`
      );
    }

    // Platform-specific config refusal (e.g. Telegram rejects explicit
    // polling mode in Lobu Cloud — see the telegram descriptor for why).
    // Adapterless platforms have no descriptor and no config to vet.
    const rejection = descriptor?.getConfigRejection?.(config);
    if (rejection) {
      throw new Error(rejection);
    }

    // Let the platform prime a brand-new config before it is persisted —
    // e.g. Telegram auto-generates a strong webhook `secretToken` when the
    // caller didn't supply one, so its inbound webhook is never forgeable.
    descriptor?.prepareNewConnectionConfig?.(config);

    const id = stableId ?? randomUUID().replace(/-/g, "").slice(0, 16);
    const now = Date.now();
    const organizationId = tryGetOrgId() ?? undefined;

    const connection: PlatformConnection = {
      id,
      platform,
      ...(agentId ? { agentId } : {}),
      ...(organizationId ? { organizationId } : {}),
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

    logger.info({ id, historyDeleted, secretsDeleted }, "Connection removed");
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
      // startInstance sets connection.status = "error" — persist so UI reflects it.
      // Bind the connection's owning org so the per-tenant saveConnection() write
      // succeeds even on the org-less restart paths (see persistConnectionScoped).
      await this.persistConnectionScoped(connection);
      throw error;
    }
    await this.persistConnectionScoped(connection);

    logger.info({ id }, "Connection restarted");
  }

  async stopConnection(id: string): Promise<void> {
    await this.stopInstance(id);

    // updateConnection() routes through saveConnection() which requires
    // getOrgId(); bind the connection's owning org so the stop write succeeds
    // even when reached without an HTTP request's ALS org context.
    const stored = await this.connectionStore.getConnection(id);
    const markStopped = () =>
      this.connectionStore.updateConnection(id, {
        status: "stopped",
      });
    const orgId = stored?.organizationId;
    if (orgId) {
      await orgContext.run({ organizationId: orgId }, markStopped);
    } else {
      await markStopped();
    }

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
   * Post a message to a channel as the bot — a one-shot outbound post, NOT an
   * inbound message that triggers an agent run (that's `routePlatformMessage`).
   * Used by the notification fan-out (`deliverToBotConnections`) to surface a
   * watcher digest / approval in a bound channel.
   *
   * `content` is any `chat` `AdapterPostableMessage` — `{ markdown }` (rendered
   * to each platform's native format rather than HTML-escaped), `{ card }` (a
   * `CardElement` → Block Kit / Adaptive Cards / Google Chat Cards), or plain
   * text. All ride the same Chat SDK primitives, so one call works across every
   * connected platform.
   *
   * `channelKey` is the platform-prefixed channel id, e.g. "slack:C0123ABCD".
   * Multi-replica: a connection created or restarted on another replica has no
   * live instance on this pod, so we lazily start it from the store first
   * (`ensureConnectionRunning` is a no-op when it's already running and won't
   * revive a `stopped` connection). That lets any pod that fires the
   * notification deliver it — no cross-pod routing needed.
   */
  async postMessageToChannel(
    connectionId: string,
    channelKey: string,
    content: AdapterPostableMessage
  ): Promise<void> {
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
    if (!instance) {
      throw new Error(
        `No active chat instance for connection ${connectionId} (could not start it on this pod)`
      );
    }
    const channel = instance.chat?.channel?.(channelKey);
    if (!channel) {
      throw new Error(
        `Could not resolve channel ${channelKey} for connection ${connectionId}`
      );
    }
    await channel.post(content);
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
    // Multi-replica: the per-connection webhook route (`/api/v1/webhooks/:id`)
    // calls us directly — unlike the Slack `/slack/events` coordinator path,
    // which pre-warms the connection via `ensureConnectionRunning` before
    // forwarding here. A connection created or restarted on another replica has
    // no live instance on this pod, so lazily start it from the store first;
    // otherwise an inbound webhook (a platform event OR a slash command) that
    // lands on a pod which hasn't warmed this connection 404s. Slack events
    // mostly survive that via Slack's retries, but a one-shot slash command
    // (e.g. `/lobu link <code>`) does not. `ensureConnectionRunning` is a no-op
    // when the instance is already running, so the coordinator's existing
    // pre-call stays harmless. Mirrors `postMessageToChannel`.
    let instance = this.instances.get(connectionId);
    if (!instance) {
      const running = await this.ensureConnectionRunning(connectionId);
      instance = running ? this.instances.get(connectionId) : undefined;
    }
    if (!instance) {
      return new Response("Connection not found", { status: 404 });
    }

    // Inbound webhook authentication is performed by the platform's Chat SDK
    // adapter, which owns the per-platform secret and the documented scheme:
    //   - slack    → HMAC-SHA256 over `v0:{ts}:{rawBody}` vs `x-slack-signature`
    //                (`@chat-adapter/slack` `verifySignature`, 401 on mismatch)
    //   - telegram → constant-time compare of `x-telegram-bot-api-secret-token`
    //                to the configured `secretToken` (`@chat-adapter/telegram`)
    //   - discord  → Ed25519 verify of `x-signature-ed25519` /
    //                `x-signature-timestamp` with the app public key
    //   - whatsapp → HMAC-SHA256 over the raw body vs `x-hub-signature-256`
    //                using the Meta app secret
    //   - teams    → Bot Framework bearer-JWT validation in `bridgeAdapter`
    // Each adapter returns 401/403 on failure, so a forged payload never
    // reaches the message pipeline below.
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
  private async stopInstance(id: string): Promise<ManagedInstance | undefined> {
    const instance = this.instances.get(id);
    if (instance) {
      instance.interactionCleanup?.();
      await instance.cleanup?.();
      this.instances.delete(id);
    }
    return instance;
  }

  private async startInstance(connection: PlatformConnection): Promise<void> {
    // Adapterless platforms (`rest`) have nothing to boot: no Chat SDK
    // adapter, no webhook, no `instances` entry. Returning early keeps the
    // connection `active` (not `error`), so boot-time reconciliation on every
    // replica treats the row as healthy instead of retrying a doomed adapter
    // start. All lifecycle paths funnel through here (initialize(),
    // addConnection(), restartConnection(), updateConnection()'s restart),
    // so this is the single skip point.
    if (isAdapterlessPlatform(connection.platform)) {
      logger.debug(
        { id: connection.id, platform: connection.platform },
        "Adapterless platform — persisted only, no chat instance to start"
      );
      return;
    }

    // Multi-tenant secret resolution: PostgresSecretStore.get/put route
    // by AsyncLocalStorage org context (see #516). Some callers reach
    // here with org context already bound (HTTP routes via agent-routes
    // middleware); others don't (boot-time initialize(), the public
    // /slack/events webhook, anywhere ensureConnectionRunning() is
    // triggered without an HTTP request). Always rebind to the
    // connection's owning org id so the per-tenant secret-store query
    // hits the right bucket — including when a caller's org happens to
    // differ from the connection's (a Slack webhook resolved by team_id
    // can land in an admin's session context whose org doesn't match
    // the connection's row).
    if (connection.organizationId) {
      return orgContext.run({ organizationId: connection.organizationId }, () =>
        this.startInstanceUnscoped(connection)
      );
    }
    // Pre-org-scoping rows (legacy connections without organizationId)
    // fall through to the caller's context. PostgresSecretStore.get()
    // accepts the global bucket too, so legacy secrets keep resolving.
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

      // Backfill a webhook verification secret for connections persisted
      // before auto-generation existed (addConnection only protects
      // newly-created rows) — today only Telegram implements this hook.
      // Without a secretToken the Telegram adapter accepts unsigned webhook
      // payloads, so an EXISTING no-token row would stay forgeable across
      // deploys/restarts. The descriptor generates + persists one here so
      // this boot's adapter verifies it and configurePlatformWebhook
      // registers it, with a row-locked claim so concurrent replicas
      // converge on a single token.
      await this.ensurePlatformWebhookSecret(connection);

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
      const mode =
        getPlatformDescriptor(connection.platform)?.resolveWebhookMode?.(
          connection.config
        ) ?? "auto";
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
    const descriptor = getPlatformDescriptor(connection.platform);
    if (!descriptor) {
      throw new Error(`No adapter factory for: ${connection.platform}`);
    }
    return descriptor.createAdapter(connection.config);
  }

  /**
   * Delegate webhook-secret bootstrapping to the platform descriptor (today
   * only Telegram implements the hook — see `platforms/telegram.ts` for the
   * row-locked multi-replica convergence story). No-op for platforms without
   * the hook.
   */
  private async ensurePlatformWebhookSecret(
    connection: PlatformConnection
  ): Promise<void> {
    const descriptor = getPlatformDescriptor(connection.platform);
    if (!descriptor?.ensureWebhookSecret) return;
    await descriptor.ensureWebhookSecret(connection, {
      secretStore: this.services.getSecretStore(),
      persistConnection: (c) => this.persistConnection(c),
      getStoredConnection: (id) => this.connectionStore.getConnection(id),
    });
  }

  /**
   * Back-compat name for `ensurePlatformWebhookSecret` — existing gateway
   * tests drive the Telegram backfill through this method directly. (Not
   * `private`: nothing inside the class calls it, and `noUnusedLocals`
   * rejects unused private members.)
   */
  async ensureTelegramWebhookSecret(
    connection: PlatformConnection
  ): Promise<void> {
    return this.ensurePlatformWebhookSecret(connection);
  }

  private async createStateAdapter(): Promise<any> {
    return createGatewayStateAdapter();
  }

  /**
   * Register the public per-connection webhook URL with the platform via its
   * descriptor hook (today only Telegram implements it — setWebhook with the
   * verification secret_token). No-op for platforms without the hook.
   */
  private async configurePlatformWebhook(
    connection: PlatformConnection,
    webhookUrl: string
  ): Promise<void> {
    await getPlatformDescriptor(connection.platform)?.configureWebhook?.(
      connection,
      webhookUrl
    );
  }

  /**
   * Register slash commands with the platform's native command menu via its
   * descriptor hook (today only Telegram implements it — setMyCommands).
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

    await getPlatformDescriptor(connection.platform)?.registerCommands?.(
      connection,
      commands
    );
  }

  private buildSlackCoordinator(): SlackConnectionCoordinator {
    return new SlackConnectionCoordinator({
      addConnection: this.addConnection.bind(this),
      createStateAdapter: this.createStateAdapter.bind(this),
      ensureConnectionRunning: this.ensureConnectionRunning.bind(this),
      forwardWebhook: this.handleWebhook.bind(this),
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
   * persistConnection() rebound to the connection's owning org context.
   *
   * saveConnection() (and the per-org secret-store put() inside
   * normalizeConfigForStorage()) require getOrgId() from AsyncLocalStorage.
   * The restart path is reachable WITHOUT an HTTP request's org context —
   * `ensureConnectionRunning()` is fired from the public per-connection
   * webhook (`/api/v1/webhooks/:id`) and the notification fan-out
   * (`postMessageToChannel`) on a cold pod that hasn't warmed the connection.
   * Without rebinding, getOrgId() throws, the persist aborts, and the inbound
   * message/notification is dropped (multi-replica). Bind the connection's
   * own org so the per-tenant write hits the right bucket — mirroring
   * startInstance()'s self-rebind. Legacy rows without an organizationId fall
   * through to the caller's context (the global bucket still resolves).
   */
  private async persistConnectionScoped(
    connection: PlatformConnection
  ): Promise<void> {
    if (connection.organizationId) {
      return orgContext.run(
        { organizationId: connection.organizationId },
        () => this.persistConnection(connection)
      );
    }
    return this.persistConnection(connection);
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
    return Object.keys(PLATFORM_REGISTRY).map((name) =>
      this.createPlatformAdapter(name)
    );
  }

  private createPlatformAdapter(name: string): PlatformAdapter {
    const descriptor = getPlatformDescriptor(name);
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
        descriptor?.extractRoutingInfo?.(body) ?? null,
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
      ...(descriptor?.getInstructionProvider
        ? {
            getInstructionProvider: () =>
              descriptor.getInstructionProvider!(this),
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

    return getPlatformDescriptor(name)?.createFileHandler?.(instance);
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
      organizationId: connection.organizationId,
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
  if (stored.organizationId) out.organizationId = stored.organizationId;
  if (stored.errorMessage) out.errorMessage = stored.errorMessage;
  return out;
}
