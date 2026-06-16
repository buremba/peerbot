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
import { getDb } from "../../db/client.js";
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
import {
  handleWebhookIngest,
  prepareWebhookIngestConfig,
} from "./webhook-ingest.js";
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
import { configsEqual } from "./config-equal.js";


const logger = createLogger("chat-instance-manager");

/**
 * Exclusive-transport lease cadence. Each replica ticks every
 * `EXCLUSIVE_TICK_MS`; a tick renews the heartbeats of held claims, so a
 * claim whose heartbeat is older than `CLAIM_TTL_SECONDS` (3 missed ticks)
 * belongs to a dead pod and is reclaimable by any replica.
 */
const EXCLUSIVE_TICK_MS = 15_000;
const CLAIM_TTL_SECONDS = 45;

/**
 * Platforms that are valid to declare on an agent but have no chat adapter to
 * run. `rest` is the HTTP Agent API (`POST /lobu/api/v1/agents/:id/messages`),
 * which is registered unconditionally in gateway/routes/public/agent.ts —
 * declaring it just persists the `agent_connections` row so `lobu apply`
 * converges; there is no instance to start/stop/restart and no webhook to
 * route. `webhook` is the inbound push-source primitive (#1235): deliveries
 * are handled per-request by `handleIngestWebhook` below, which reads the
 * row + secret directly — no warm instance, no per-pod state. Deliberately
 * NOT in the platform descriptor registry: createPlatformAdapters() derives
 * the PlatformRegistry entries from it, and an adapterless platform must not
 * get a registry entry either. Stateless by construction, so it is
 * multi-replica safe — hydration and the health sweep skip it rather than
 * retrying a doomed adapter start.
 */
const ADAPTERLESS_PLATFORMS = new Set<string>(["rest", "webhook"]);

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
  /**
   * `agent_connections.updated_at` of the row this instance was hydrated
   * from. A pod-local instance is a pure memo of the row: when the stored
   * row is newer (config edited on any replica), the next use re-hydrates,
   * so replicas converge without cross-pod restart fan-out.
   */
  rowVersion: number;
  cleanup?: () => Promise<void>;
  interactionCleanup?: () => void;
}

export class ChatInstanceManager {
  private instances = new Map<string, ManagedInstance>();
  private services!: CoreServices;
  private publicGatewayUrl = "";
  private slackCoordinator!: SlackConnectionCoordinator;
  private connectionStore!: AgentConnectionStore;
  /** Identity for `connection_claims.claimed_by` — unique per process. */
  private podId = randomUUID();
  private exclusiveTimer: ReturnType<typeof setInterval> | undefined;
  /** Exclusive connections this replica currently holds the lease for. */
  private exclusiveOwned = new Set<string>();
  /**
   * rowVersion of the last failed exclusive start per connection, so a
   * broken config is retried once per row edit instead of every tick.
   * Pod-local on purpose: retry bookkeeping is a local decision.
   */
  private lastExclusiveFailure = new Map<string, number>();
  private exclusiveTickInFlight = false;

  /**
   * Public gateway base URL (`PUBLIC_WEB_URL` or derived) — exposed so the
   * response bridge can build links into the admin UI (e.g. the
   * provider-settings page) for user-facing error messages.
   */
  getPublicGatewayUrl(): string {
    return this.publicGatewayUrl;
  }

  /**
   * Lazy-first initialization: NO eager warm-start. A connection is a row,
   * not a process — webhook-transport connections are hydrated on demand by
   * `ensureConnectionRunning()` (inbound webhook, notification fan-out,
   * platform routing, file uploads), keyed by the row's `updated_at` so
   * config edits on any replica converge here on next use. Status health is
   * owned by the periodic single-claimant `connection-health` task (see
   * `sweepConnectionHealth`), not by boot side-effects racing across pods.
   *
   * The only connections that need a process identity are *exclusive*
   * transports (Telegram long-polling), which the claim runner below starts
   * on exactly one replica via the `connection_claims` lease.
   */
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
    this.startExclusiveRunner();
  }

  async shutdown(): Promise<void> {
    logger.info(
      { count: this.instances.size },
      "Shutting down all connections"
    );
    if (this.exclusiveTimer) {
      clearInterval(this.exclusiveTimer);
      this.exclusiveTimer = undefined;
    }
    // Release exclusive leases eagerly so a peer replica can claim within one
    // tick instead of waiting out the TTL. Best-effort: pod death skips this
    // and the TTL covers it.
    if (this.exclusiveOwned.size > 0) {
      try {
        await getDb()`
          DELETE FROM connection_claims WHERE claimed_by = ${this.podId}
        `;
      } catch (error) {
        logger.warn(
          { error: String(error) },
          "Failed to release exclusive connection claims on shutdown"
        );
      }
      this.exclusiveOwned.clear();
    }
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

    // Webhook ingest connections are adapterless (no descriptor) but still
    // need the same never-unauthenticated guarantee: auto-generate the
    // bearer token when the caller didn't supply one.
    if (platform === "webhook") {
      prepareWebhookIngestConfig(config as Record<string, unknown>);
    }

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
    // refs) so a start failure can't leave a running instance with no row,
    // and a persist failure can't leave a half-baked entry. The instance is
    // then hydrated from the persisted row — the same path every replica
    // uses — so the memo key matches the row from the first start.
    await this.persistConnection(connection);

    const stored = await this.connectionStore.getConnection(id);
    if (!stored) {
      throw new Error(`Connection ${id} did not persist`);
    }

    if (isAdapterlessPlatform(platform)) {
      logger.info({ id, platform, agentId }, "Connection added");
      return connection;
    }

    if (this.isExclusiveStored(stored)) {
      // Exclusive transports start under the connection_claims lease — kick
      // a tick now so a single-replica/dev setup gets its polling loop
      // immediately. Runtime startup errors surface as status=error within
      // a tick rather than failing the create: the lease owner may be a
      // different replica, so synchronous start feedback is impossible here.
      void this.exclusiveTick().catch((error) => {
        logger.warn(
          { id, error: String(error) },
          "Exclusive tick after connection create failed"
        );
      });
      logger.info({ id, platform, agentId }, "Connection added (lease-owned)");
      return connection;
    }

    try {
      await this.hydrateFromRow(stored);
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

    let stored = await this.connectionStore.getConnection(id);
    if (!stored) throw new Error(`Connection ${id} not found`);

    // Restart is the explicit "make it run" operation: it un-stops stopped
    // rows and clears error state, regardless of how the row got there.
    if (stored.status !== "active" || stored.errorMessage) {
      await this.writeConnectionStatus(stored, "active", undefined);
      stored = (await this.connectionStore.getConnection(id)) ?? stored;
    }

    if (isAdapterlessPlatform(stored.platform)) return;

    // Exclusive transports are lease-owned: the status reset above makes the
    // claim runner (here or on the owning replica) retry on its next tick,
    // but a request path never starts the polling loop itself.
    if (this.isExclusiveStored(stored)) {
      this.lastExclusiveFailure.delete(id);
      return;
    }

    try {
      await this.hydrateFromRow(stored);
    } catch (error) {
      await this.writeConnectionStatus(
        stored,
        "error",
        `Startup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }

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

    // Refuse a merged config the platform rejects (e.g. flipping a Telegram
    // connection to polling mode under LOBU_CLOUD_MODE) BEFORE persisting —
    // otherwise the refused config would be saved `active` and only the next
    // lease tick / hydrate would error it, mirroring addConnection's
    // create-time rejection.
    if (nextConfig !== undefined) {
      const rejection = getPlatformDescriptor(
        connection.platform
      )?.getConfigRejection?.(nextConfig as PlatformAdapterConfig);
      if (rejection) {
        throw new Error(rejection);
      }
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

    // Persist FIRST, then (re)start from the persisted row: the row is the
    // source of truth and its post-write `updated_at` is the memo key every
    // replica converges on. Starting before persisting would stamp the
    // instance with a pre-write version and force a spurious re-hydrate on
    // the next inbound request.
    await this.persistConnection(connection);
    const reread = await this.connectionStore.getConnection(id);
    if (!reread) throw new Error(`Connection ${id} disappeared during update`);

    if (
      needsRestart &&
      connection.status === "active" &&
      !isAdapterlessPlatform(connection.platform)
    ) {
      if (this.isExclusiveStored(reread)) {
        // Lease-owned: drop any local loop; the claim owner re-hydrates on
        // its next tick via the rowVersion mismatch.
        await this.stopInstance(id);
        this.lastExclusiveFailure.delete(id);
      } else {
        // Eager restart on the serving pod for immediate config validation;
        // other replicas converge lazily via the rowVersion memo. On failure
        // mark the row errored before rethrowing — the new config is already
        // persisted, and leaving it `active` would misreport a connection
        // that provably cannot start.
        try {
          await this.hydrateFromRow(reread);
        } catch (error) {
          await this.writeConnectionStatus(
            reread,
            "error",
            `Startup failed: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }
      }
    } else {
      const instance = this.instances.get(id);
      if (instance) {
        instance.connection = connection;
        instance.rowVersion = reread.updatedAt;
      }
    }

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

  /**
   * Inbound delivery for a `platform: "webhook"` connection (#1235). The
   * public webhook route branches here BEFORE `handleWebhook` — a webhook
   * source has no Chat SDK instance to warm (it's adapterless), so the
   * handler reads the raw row + secret directly. Runs under the connection's
   * own org context: this is an unauthenticated-route path, and both the
   * Postgres secret store and the event insert are org-scoped.
   */
  async handleIngestWebhook(
    connectionId: string,
    request: Request,
    peerAddress?: string | null
  ): Promise<Response> {
    // A stopped row is deliberately off — refuse deliveries exactly like a
    // stopped chat connection (whose instance would not be running). Error
    // status stays accepting: webhook connections have no startup that can
    // fail, and a stray error row should not silently drop deliveries.
    const stored = await this.connectionStore.getConnection(connectionId);
    if (!stored || stored.platform !== "webhook" || stored.status === "stopped") {
      return new Response(JSON.stringify({ error: "Connection not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (!stored.organizationId) {
      // handleWebhookIngest refuses org-less rows; no context to scope to.
      return handleWebhookIngest(
        stored,
        request,
        this.services.getSecretStore(),
        peerAddress
      );
    }
    return orgContext.run({ organizationId: stored.organizationId }, () =>
      handleWebhookIngest(
        stored,
        request,
        this.services.getSecretStore(),
        peerAddress
      )
    );
  }

  async handleWebhook(
    connectionId: string,
    request: Request
  ): Promise<Response> {
    // Multi-replica: hydration is per-request and row-versioned. Any replica
    // can receive any connection's webhook (the LB sprays platform deliveries
    // across pods), so the instance is treated as a memo of the
    // `agent_connections` row: fresh memo → serve, stale/missing → re-hydrate
    // from the row, gone/stopped row → 404. The coordinator's `/slack/events`
    // pre-call goes through the same check and stays harmless. Mirrors
    // `postMessageToChannel`.
    const running = await this.ensureConnectionRunning(connectionId);
    const instance = running ? this.instances.get(connectionId) : undefined;
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
        // Callers that hydrate from a stored row (hydrateFromRow) overwrite
        // this with the row's updated_at; this default covers direct starts.
        rowVersion: connection.updatedAt,
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

  /**
   * Make sure this replica serves the CURRENT row for `id`. The local
   * instance is a memo keyed on `agent_connections.updated_at`: a fresh memo
   * is served as-is (one PK read), a stale or missing one is re-hydrated
   * from the row, and a deleted/stopped row tears the local instance down.
   * This is the single convergence point that lets any replica handle any
   * webhook-transport connection with no boot warm-start and no cross-pod
   * restart fan-out.
   */
  private async ensureConnectionRunning(id: string): Promise<boolean> {
    if (!this.connectionStore) return false;

    const stored = await this.connectionStore.getConnection(id);
    if (!stored || stored.status === "stopped") {
      if (this.instances.has(id)) {
        await this.stopInstance(id);
      }
      if (stored) logger.info({ id }, "Connection is stopped, not starting");
      return false;
    }

    if (isAdapterlessPlatform(stored.platform)) return false;

    const existing = this.instances.get(id);
    if (existing && existing.rowVersion === stored.updatedAt) return true;

    // Exclusive transports (long-polling) belong to the connection_claims
    // lease holder; a request path on a non-owner replica must not start a
    // second loop. A stale owned instance is refreshed by the claim runner
    // on its next tick.
    if (this.isExclusiveStored(stored)) {
      return existing !== undefined;
    }

    try {
      await this.hydrateFromRow(stored);
      return true;
    } catch (error) {
      logger.error(
        { id, error: String(error) },
        "Failed to hydrate connection"
      );
      await this.writeConnectionStatus(
        stored,
        "error",
        `Startup failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Public hydration hook for out-of-class consumers that need a warm
   * instance before a synchronous lookup (e.g. the internal file-upload
   * route resolving a platform file handler on a pod that has never seen
   * this connection).
   */
  async warmConnection(id: string): Promise<boolean> {
    return this.ensureConnectionRunning(id);
  }

  /**
   * Stop any stale local instance and start one from the given row,
   * stamping the memo key. Throws on startup failure (caller decides how to
   * persist the error). A successful start clears a pre-existing `error`
   * status — the row provably works.
   */
  private async hydrateFromRow(stored: StoredConnection): Promise<void> {
    // Config refusals (e.g. Telegram polling under LOBU_CLOUD_MODE) gate
    // EVERY start path here — request hydration, the claim runner, restart —
    // so a persisted refused config can never run, matching the create-time
    // rejection in addConnection().
    const rejection = getPlatformDescriptor(stored.platform)?.getConfigRejection?.(
      stored.config as PlatformAdapterConfig
    );
    if (rejection) {
      throw new Error(rejection);
    }
    await this.stopInstance(stored.id);
    const connection = storedToPlatform(stored);
    await this.startInstance(connection);
    const instance = this.instances.get(stored.id);
    if (!instance) {
      throw new Error(
        `Instance for connection ${stored.id} did not register after start`
      );
    }
    // startInstance may backfill metadata (e.g. botUsername/botUserId on first
    // start), bumping the row's updated_at. Stamp the memo key from the latest
    // persisted value, not the pre-start snapshot — otherwise the next
    // ensureConnectionRunning sees a version mismatch and needlessly tears the
    // instance down and re-hydrates (re-running setWebhook/setMyCommands).
    const afterStart = await this.connectionStore.getConnection(stored.id);
    instance.rowVersion = afterStart?.updatedAt ?? stored.updatedAt;
    if (stored.status === "error") {
      await this.writeConnectionStatus(stored, "active", undefined);
      const reread = await this.connectionStore.getConnection(stored.id);
      if (reread) instance.rowVersion = reread.updatedAt;
      logger.info({ id: stored.id }, "Recovered previously-errored connection");
    }
  }

  /**
   * Persist a status transition under the connection's own org context
   * (status writes happen on request-less paths: claim ticks, health sweep,
   * webhook hydration). No-ops when the row already holds the target state,
   * so repeated failures don't churn `updated_at` (which would invalidate
   * every replica's memo for a connection that didn't change).
   */
  private async writeConnectionStatus(
    row: Pick<
      StoredConnection,
      "id" | "organizationId" | "status" | "errorMessage"
    >,
    status: "active" | "error",
    errorMessage: string | undefined
  ): Promise<void> {
    if (
      row.status === status &&
      (row.errorMessage ?? undefined) === errorMessage
    ) {
      return;
    }
    const write = () =>
      this.connectionStore.updateConnection(row.id, { status, errorMessage });
    try {
      if (row.organizationId) {
        await orgContext.run({ organizationId: row.organizationId }, write);
      } else {
        await write();
      }
    } catch (error) {
      logger.error(
        { id: row.id, error: String(error) },
        "Failed to write connection status"
      );
    }
  }

  private isExclusiveStored(stored: StoredConnection): boolean {
    return (
      getPlatformDescriptor(stored.platform)?.requiresExclusiveStart?.(
        stored.config as PlatformAdapterConfig,
        { publicGatewayUrl: this.publicGatewayUrl }
      ) ?? false
    );
  }

  // --- Exclusive-transport claim runner ---

  /**
   * Start the per-replica claim loop for exclusive transports. Every tick
   * each replica tries to claim/renew each exclusive connection's lease in
   * `connection_claims`; the winner runs the (polling) instance, losers make
   * sure they don't. The timer is unref'd so it never holds the process
   * open.
   */
  private startExclusiveRunner(): void {
    if (this.exclusiveTimer) return;
    const timer = setInterval(() => {
      void this.exclusiveTick().catch((error) => {
        logger.warn(
          { error: String(error) },
          "Exclusive connection tick failed"
        );
      });
    }, EXCLUSIVE_TICK_MS);
    timer.unref?.();
    this.exclusiveTimer = timer;
    void this.exclusiveTick().catch((error) => {
      logger.warn(
        { error: String(error) },
        "Initial exclusive connection tick failed"
      );
    });
  }

  private async exclusiveTick(): Promise<void> {
    if (!this.connectionStore) return;
    // Single-flight: a slow hydrate must not overlap the next interval tick
    // (or an addConnection-triggered kick) and stop/start the same
    // connection concurrently.
    if (this.exclusiveTickInFlight) return;
    this.exclusiveTickInFlight = true;
    try {
      await this.exclusiveTickInner();
    } finally {
      this.exclusiveTickInFlight = false;
    }
  }

  private async exclusiveTickInner(): Promise<void> {
    const stored = await this.connectionStore.listConnections();

    const exclusiveRows = new Map<string, StoredConnection>();
    for (const s of stored) {
      if (s.status === "stopped") continue;
      if (this.isExclusiveStored(s)) exclusiveRows.set(s.id, s);
    }

    // Connections we hold that vanished or are no longer exclusive: stop the
    // local loop and free the lease row.
    for (const id of [...this.exclusiveOwned]) {
      if (!exclusiveRows.has(id)) {
        await this.stopInstance(id);
        this.exclusiveOwned.delete(id);
        this.lastExclusiveFailure.delete(id);
        await this.releaseClaim(id);
      }
    }

    for (const s of exclusiveRows.values()) {
      let owned = false;
      try {
        owned = await this.claimExclusive(s.id);
      } catch (error) {
        logger.warn(
          { id: s.id, error: String(error) },
          "Exclusive claim attempt failed"
        );
        if (this.exclusiveOwned.has(s.id)) {
          // Fail closed: we can't prove the lease is still ours (claims
          // table unreachable). If we kept polling, another replica could
          // legitimately claim after the TTL and we'd have two pollers
          // (split-brain). Stop until a renewal succeeds.
          await this.stopInstance(s.id);
          this.exclusiveOwned.delete(s.id);
        }
        continue;
      }

      if (!owned) {
        if (this.exclusiveOwned.has(s.id)) {
          // Lost the lease (e.g. our heartbeat lapsed during a long stall):
          // another replica owns it now — running here too would 409.
          await this.stopInstance(s.id);
          this.exclusiveOwned.delete(s.id);
        }
        continue;
      }

      this.exclusiveOwned.add(s.id);
      const instance = this.instances.get(s.id);
      if (instance && instance.rowVersion === s.updatedAt) continue;
      if (this.lastExclusiveFailure.get(s.id) === s.updatedAt) continue;

      try {
        await this.hydrateFromRow(s);
        this.lastExclusiveFailure.delete(s.id);
      } catch (error) {
        logger.error(
          { id: s.id, error: String(error) },
          "Failed to start exclusive connection"
        );
        await this.writeConnectionStatus(
          s,
          "error",
          `Startup failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // Remember the post-write rowVersion so we retry only when the row
        // actually changes (the status write itself bumps updated_at).
        const reread = await this.connectionStore.getConnection(s.id);
        this.lastExclusiveFailure.set(s.id, reread?.updatedAt ?? s.updatedAt);
      }
    }
  }

  /**
   * Atomically claim or renew the lease for one exclusive connection. Wins
   * when the row is ours (heartbeat renewal) or its heartbeat is older than
   * the TTL (owner died). Exactly one replica's UPSERT can satisfy the
   * conditional update per row at any moment — Postgres serializes on the
   * row, so two racing replicas resolve to one owner.
   */
  private async claimExclusive(connectionId: string): Promise<boolean> {
    const rows = await getDb()`
      INSERT INTO connection_claims (connection_id, claimed_by, heartbeat_at)
      VALUES (${connectionId}, ${this.podId}, now())
      ON CONFLICT (connection_id) DO UPDATE
        SET claimed_by = EXCLUDED.claimed_by, heartbeat_at = now()
        WHERE connection_claims.claimed_by = EXCLUDED.claimed_by
           OR connection_claims.heartbeat_at <
              now() - make_interval(secs => ${CLAIM_TTL_SECONDS})
      RETURNING connection_id
    `;
    return rows.length > 0;
  }

  private async releaseClaim(connectionId: string): Promise<void> {
    try {
      await getDb()`
        DELETE FROM connection_claims
        WHERE connection_id = ${connectionId} AND claimed_by = ${this.podId}
      `;
    } catch (error) {
      logger.warn(
        { id: connectionId, error: String(error) },
        "Failed to release exclusive claim"
      );
    }
  }

  // --- Periodic health sweep (single claimant via TaskScheduler) ---

  /**
   * Validate every non-stopped connection's config without starting it:
   * platform config rejections + secret-ref resolution. Replaces the old
   * boot-time warm-start as the thing that keeps the `status` column honest,
   * but runs on ONE replica per tick (TaskScheduler cron) instead of N pods
   * racing status writes at every deploy.
   *
   * Recovery is deliberately narrow: only rows whose error THIS sweep wrote
   * (`Health check failed: …`) are flipped back by a now-passing check.
   * Runtime startup failures (`Startup failed: …`) are cleared by the paths
   * that can actually prove a start works — request hydration and the claim
   * runner — so the sweep can't flip-flop a connection whose secrets resolve
   * but whose credentials are dead.
   */
  async sweepConnectionHealth(): Promise<{
    checked: number;
    errored: number;
    recovered: number;
  }> {
    const result = { checked: 0, errored: 0, recovered: 0 };
    if (!this.connectionStore) return result;

    const stored = await this.connectionStore.listConnections();
    for (const s of stored) {
      if (s.status === "stopped" || isAdapterlessPlatform(s.platform)) {
        continue;
      }
      result.checked += 1;

      const rejection = getPlatformDescriptor(
        s.platform
      )?.getConfigRejection?.(s.config as PlatformAdapterConfig);
      if (rejection) {
        if (s.status !== "error") {
          // Prefixed like every sweep-written error so a later sweep can
          // recover the row once the rejection no longer applies (e.g. the
          // config was edited) — recovery keys on this prefix.
          await this.writeConnectionStatus(
            s,
            "error",
            `Health check failed: ${rejection}`
          );
          result.errored += 1;
        }
        continue;
      }

      try {
        const resolve = () =>
          this.resolveConfigForRuntime(s.id, s.config as PlatformAdapterConfig);
        if (s.organizationId) {
          await orgContext.run({ organizationId: s.organizationId }, resolve);
        } else {
          await resolve();
        }
        // Recover rows whose recorded failure is exactly what this check
        // just proved healthy: sweep-written errors, and secret-resolution
        // startup failures (the #692 class: a deploy-wide env breakage marks
        // every row, the fixed deploy must un-stick them without waiting for
        // traffic). Other startup failures (dead tokens, adapter errors) are
        // NOT recovered here — only a successful real start clears those.
        const recoverable =
          s.status === "error" &&
          (s.errorMessage?.startsWith("Health check failed:") ||
            s.errorMessage?.includes("Failed to resolve secret ref"));
        if (recoverable) {
          await this.writeConnectionStatus(s, "active", undefined);
          result.recovered += 1;
        }
      } catch (error) {
        if (s.status !== "error") {
          await this.writeConnectionStatus(
            s,
            "error",
            `Health check failed: ${error instanceof Error ? error.message : String(error)}`
          );
          result.errored += 1;
        }
      }
    }
    return result;
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
      warmConnection: (connectionId: string) =>
        this.warmConnection(connectionId),
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
    conversationId: string | undefined,
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

    // History is row-backed state — no warm instance required (a cold pod
    // answering this on behalf of a connection hydrated elsewhere must see
    // the same history).
    const conversationState =
      this.getInstance(connection.id)?.conversationState ??
      new ConversationStateStore(await this.createStateAdapter());

    // Scope to the thread when the caller is inside one — otherwise a
    // threaded platform's get_channel_history would return the WHOLE channel
    // (thread B's messages bleeding into thread A). Non-threaded callers pass
    // conversationId === channelId (or undefined), collapsing to the channel.
    let entries: HistoryEntry[] = await conversationState.getEntries(
      connection.id,
      channelId,
      conversationId ?? channelId
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
    // Select from rows, not warm instances: with lazy hydration a fresh pod
    // legitimately has zero instances while active connections exist. A warm
    // instance is preferred only as a tiebreaker (it served traffic here).
    const connections = await this.listConnections({ platform: name });
    const activeConnections = connections.filter(
      (connection) => connection.status === "active"
    );
    if (activeConnections.length === 0) return null;
    if (activeConnections.length === 1) return activeConnections[0] || null;

    const teamMatch = activeConnections.find(
      (connection) => connection.metadata?.teamId === teamId
    );
    if (teamMatch) return teamMatch;

    // Prefer a connection that already has history for this channel; the
    // state store is row-backed, so no warm instance is required to ask.
    const conversationState = new ConversationStateStore(
      await this.createStateAdapter()
    );
    for (const connection of activeConnections) {
      if (
        await conversationState.hasHistoryForChannel(connection.id, channelId)
      ) {
        return connection;
      }
    }

    const warm = activeConnections.find((connection) =>
      this.has(connection.id)
    );
    return warm ?? activeConnections[0] ?? null;
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
