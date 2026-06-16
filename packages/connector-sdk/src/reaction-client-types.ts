/**
 * Type declarations for watcher reaction scripts.
 *
 * Reaction scripts run inside an isolated-vm sandbox where `client` is a
 * Proxy that dispatches calls to the host. You can't import real packages
 * at runtime, but you CAN use these types for editor autocompletion.
 *
 * Usage:
 *   import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
 *
 *   export default async (ctx: ReactionContext, client: ReactionClient) => {
 *     await client.knowledge.save({ content: "...", semantic_type: "digest" });
 *   };
 */
/**
 * A rich card for chat delivery, as a plain serializable object — a `chat`
 * `CardElement` built with the card primitives (`Card`, `Section`, `Field`,
 * `Actions`, `Button`, `Select`, …). Typed loosely here so the SDK's published
 * declarations don't force consumers to install `chat`; the gateway validates
 * and renders it to each platform's native format (Block Kit / Adaptive Cards /
 * Google Chat Cards).
 */
export type CardElement = Record<string, unknown>;

// ── Knowledge ────────────────────────────────────────────────────────────────

export interface KnowledgeSearchInput {
  query?: string;
  entity_type?: string;
  entity_id?: number;
  fuzzy?: boolean;
  min_similarity?: number;
  limit?: number;
}

export interface KnowledgeSaveInput {
  entity_ids?: number[];
  content: string;
  semantic_type: string;
  metadata?: Record<string, unknown>;
  title?: string;
  slug?: string;
}

export interface KnowledgeReadInput {
  content_id?: number;
  watcher_id?: number;
  since?: string;
  until?: string;
  limit?: number;
  entity_ids?: number[];
}

// ── Entities ─────────────────────────────────────────────────────────────────

export interface EntityCreateInput {
  type: string;
  name: string;
  slug?: string;
  content?: string;
  parent_id?: number;
  metadata?: Record<string, unknown>;
}

export interface EntityUpdateInput {
  entity_id: number;
  name?: string;
  slug?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface EntityLinkInput {
  from_entity_id: number;
  to_entity_id: number;
  relationship_type_slug: string;
  metadata?: Record<string, unknown>;
}

export interface EntityListFilter {
  entity_type?: string;
  search?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

export interface NotificationsSendInput {
  /** Notification title (≤200 chars). */
  title: string;
  /** Body text (≤1000 chars). */
  body?: string;
  /**
   * Optional rich card built with the `chat` card primitives (`Card`,
   * `Section`, `Field`, `Actions`, `Button`, `Select`, …). When set,
   * bot-connection delivery posts this card — rendered to each platform's
   * native format (Slack Block Kit, Teams Adaptive Cards, Google Chat Cards) —
   * instead of the markdown body; the in-app inbox entry still uses title/body.
   */
  card?: CardElement;
  /**
   * Who to notify. `"admins"` (default): org admins/owners. `"all"`: every
   * member. Or an array of specific user IDs.
   */
  recipients?: "admins" | "all" | string[];
  /** Relative URL the notification links to (e.g. `/acme/entities`). */
  resource_url?: string;
  /** Deliver only through this specific bot connection (its id). */
  connection_id?: string;
  /** Arbitrary JSON payload appended to the body as formatted JSON. */
  data?: Record<string, unknown>;
  /** Attribution when sent from a watcher reaction. */
  watcher_source?: { watcher_id: number; window_id: number };
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * The client object available in reaction scripts.
 *
 * `client.knowledge`     — read/write/search knowledge events
 * `client.entities`      — CRUD entities and relationships
 * `client.notifications` — push a notification to the org's inbox + bot connections (Slack/Telegram)
 * `client.query`         — raw SQL (results as JSON rows)
 * `client.log`           — structured logging (appears in watcher run logs)
 */
export interface ReactionClient {
  knowledge: {
    search(input: KnowledgeSearchInput): Promise<unknown>;
    save(input: KnowledgeSaveInput): Promise<unknown>;
    read(input: KnowledgeReadInput): Promise<unknown>;
    delete(input: number | { event_id?: number; event_ids?: number[]; reason?: string }): Promise<unknown>;
  };

  entities: {
    list(filter?: EntityListFilter): Promise<unknown>;
    get(entity_id: number): Promise<unknown>;
    create(input: EntityCreateInput): Promise<{ id: number }>;
    update(input: EntityUpdateInput): Promise<unknown>;
    delete(entity_id: number, options?: { force_delete_tree?: boolean }): Promise<unknown>;
    link(input: EntityLinkInput): Promise<unknown>;
    unlink(input: {
      from_entity_id: number;
      to_entity_id: number;
      relationship_type_slug: string;
    }): Promise<unknown>;
    updateLink(input: {
      from_entity_id: number;
      to_entity_id: number;
      relationship_type_slug: string;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    listLinks(input: {
      entity_id: number;
      relationship_type_slug?: string;
      limit?: number;
      offset?: number;
    }): Promise<unknown>;
    search(query: string, options?: { limit?: number }): Promise<unknown>;
  };

  notifications: {
    /**
     * Send a notification: writes it to the org inbox and fans it out to the
     * org's active bot connections (Slack/Telegram). This is how a reaction
     * surfaces its digest to a chat channel.
     */
    send(input: NotificationsSendInput): Promise<{ notified_count: number }>;
  };

  /** Run a read-only SQL query against the org's Postgres. */
  query(sql: string): Promise<unknown[]>;

  /** Structured log — appears in the watcher run output. */
  log(message: string, data?: Record<string, unknown>): void;
}
