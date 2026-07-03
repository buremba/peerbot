/**
 * Per-platform capability descriptors for Chat SDK connections.
 *
 * Each chat platform contributes one `ChatPlatformDescriptor` to the registry
 * in `./index.ts` (keyed by platform name, merged with the adapter factory
 * that used to live in `ADAPTER_FACTORIES`). `ChatInstanceManager` stays
 * platform-agnostic: it looks up the descriptor for a connection's platform
 * and calls the optional capability hooks, falling back gracefully when a
 * hook is absent. Adding a platform means adding one module under
 * `./platforms/` and registering it in `./index.ts` — no manager edits.
 */

import type { InstructionProvider, StoredConnection } from "@lobu/core";
import type { IFileHandler } from "../../platform/file-handler.js";
import type { WritableSecretStore } from "../../secrets/index.js";
import type { ChatInstanceManager } from "../chat-instance-manager.js";
import type { PlatformAdapterConfig, PlatformConnection } from "../types.js";

/** Routing info parsed from a platform-specific request body. */
export interface PlatformRoutingInfo {
  channelId: string;
  conversationId?: string;
  teamId?: string;
}

/**
 * The slice of a managed Chat instance that capability hooks may touch —
 * structurally compatible with `ChatInstanceManager`'s internal
 * `ManagedInstance` without exposing its lifecycle fields.
 */
export interface ChatPlatformInstance {
  connection: PlatformConnection;
  chat: any;
}

/** A slash command surfaced to a platform's native command menu. */
export interface PlatformCommand {
  command: string;
  description: string;
}

/**
 * Manager-owned persistence callbacks handed to `ensureWebhookSecret` so the
 * descriptor never needs the manager itself (or its private stores).
 */
export interface WebhookSecretDeps {
  secretStore: WritableSecretStore;
  persistConnection(connection: PlatformConnection): Promise<void>;
  getStoredConnection(id: string): Promise<StoredConnection | null>;
}

/**
 * Capability descriptor for one chat platform. `createAdapter` is required
 * (it's the old `ADAPTER_FACTORIES` entry); everything else is optional and
 * the manager treats an absent hook as "platform doesn't support this".
 */
export interface ChatPlatformDescriptor {
  /** Lazily construct the `@chat-adapter/*` adapter for a resolved config. */
  createAdapter(config: any): Promise<any>;

  /**
   * Parse platform-specific routing fields out of a messaging-API request
   * body (e.g. `body.slack.channel`). Return null when the fields are
   * missing/invalid so the caller falls back to its defaults.
   */
  extractRoutingInfo?(
    body: Record<string, unknown>
  ): PlatformRoutingInfo | null;

  /**
   * Build an outbound file handler bound to a running instance. Return
   * undefined when the connection lacks what the platform needs (e.g. no
   * bot token).
   */
  createFileHandler?(instance: ChatPlatformInstance): IFileHandler | undefined;

  /** Per-agent instruction provider (e.g. the Slack identity block). */
  getInstructionProvider?(manager: ChatInstanceManager): InstructionProvider;

  /**
   * Return a human-readable reason when this config must be refused (both at
   * create time, where the manager throws it, and at boot, where the manager
   * marks the row errored with it). Undefined means the config is acceptable.
   */
  getConfigRejection?(config: PlatformAdapterConfig): string | undefined;

  /**
   * Mutate a brand-new connection's config before it is persisted (e.g.
   * auto-generate a webhook secret the platform requires for verification).
   */
  prepareNewConnectionConfig?(config: PlatformAdapterConfig): void;

  /**
   * Config keys the server stamps onto the stored config (e.g. an
   * auto-generated webhook secret). The declarative no-op check ignores them
   * when the incoming declaration doesn't set them — otherwise every apply
   * of an unchanged declaration would look like a credential change.
   */
  serverStampedConfigKeys?: readonly string[];

  /**
   * Backfill/converge a webhook verification secret for an existing
   * connection at start time. Runs after the config is resolved to plaintext.
   */
  ensureWebhookSecret?(
    connection: PlatformConnection,
    deps: WebhookSecretDeps
  ): Promise<void>;

  /**
   * How the connection's config wants inbound delivery resolved. The manager
   * treats anything other than an explicit `"webhook"` / `"polling"` as
   * `"auto"` (webhook when a public gateway URL exists).
   */
  resolveWebhookMode?(config: PlatformAdapterConfig): string;

  /**
   * True when this config makes the connection an *exclusive* transport: a
   * persistent outbound loop (e.g. Telegram long-polling) where two replicas
   * running it concurrently is incorrect, not just wasteful. Exclusive
   * connections are started only by the lease-holding replica
   * (`connection_claims`), never by request-path hydration. Absent hook /
   * false = stateless webhook transport, hydratable on any replica.
   */
  requiresExclusiveStart?(
    config: PlatformAdapterConfig,
    ctx: { publicGatewayUrl: string }
  ): boolean;

  /** Register the public per-connection webhook URL with the platform. */
  configureWebhook?(
    connection: PlatformConnection,
    webhookUrl: string
  ): Promise<void>;

  /** Register slash commands with the platform's native command menu. */
  registerCommands?(
    connection: PlatformConnection,
    commands: PlatformCommand[]
  ): Promise<void>;
}
