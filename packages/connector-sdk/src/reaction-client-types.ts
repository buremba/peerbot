/**
 * Type declarations for Automation reaction scripts.
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
  author?: string;
  payload_type?: "text" | "markdown" | "json_template" | "media" | "empty";
  source_url?: string;
  /** Event this content answers; stored as a durable thread edge. */
  parent_event_id?: number;
  /** Stable producer key used to collapse reaction retries. */
  idempotency_key?: string;
  occurred_at?: string;
  automation_source?: { automation_id: number; run_id: number };
}

export interface KnowledgeReadInput {
  /** Fetch specific content events by id (read_knowledge takes an array). */
  content_ids?: number[];
  automation_id?: number;
  since?: string;
  until?: string;
  limit?: number;
  entity_ids?: number[];
}

export interface KnowledgeSaveResult {
  id: number;
  created: boolean;
  metadata: Record<string, unknown>;
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
  /** HTTP(S) page a browser-side notification action should open in the current user tab. */
  browser_url?: string;
  /** Stable producer key used to collapse retried sends. */
  idempotency_key?: string;
  /** Deliver only through this specific bot connection (its id). */
  connection_id?: string;
  /**
   * Structured payload. With `semantic_type`, this becomes the event's render
   * data (bound to the kind's `jsonTemplate` in the Memory view) instead of
   * being appended to the body. Without `semantic_type`, it is stored in the
   * notification body as formatted JSON (legacy).
   */
  data?: Record<string, unknown>;
  /**
   * Event semantic type (kind) for the notification's content, validated
   * against the org's `$member.event_kinds`. When set, the notification
   * renders through the event-kind pipeline: `data` feeds the kind's
   * `jsonTemplate` in the Memory/Events view, and the inbox keeps the
   * markdown `body`. Mutually exclusive with `input_schema`.
   */
  semantic_type?: string;
  /** Attribution when sent from an automation reaction. */
  automation_source?: { automation_id: number; run_id: number };
  /**
   * Turn the notification into a human question on the existing approval rail.
   * `{}` is a binary Approve/Reject decision; a field-shaped schema renders a
   * form. Rejection can carry a reason through the standard reject action.
   */
  input_schema?: Record<string, unknown>;
}

export interface NotificationsSendResult {
  notified_count: number;
  /** Durable notification event, including on an idempotent replay. */
  event_id: number | null;
  /** Server-produced notification permalink. */
  url: string | null;
  /** Present for input_schema asks; poll/read this run for the answer. */
  run_id?: number;
}

export interface OperationsListRunsInput {
  connection_id?: number;
  connection_ids?: number[];
  feed_ids?: number[];
  device_worker_id?: string;
  connector_key?: string;
  operation_key?: string;
  status?: string;
  approval_status?: string;
  run_types?: string[];
  created_after?: string;
  created_before?: string;
  automation_ids?: number[];
  limit?: number;
  offset?: number;
  before_id?: number;
  before_created_at?: string;
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * The client object available in reaction scripts.
 *
 * `client.knowledge`     — read/write/search knowledge events
 * `client.entities`      — CRUD entities and relationships
 * `client.connections`   — list/get configured connections (server-computed device liveness)
 * `client.notifications` — push a notification to the org's inbox + bot connections (Slack/Telegram)
 * `client.query`         — raw SQL (results as JSON rows)
 * `client.log`           — structured logging (appears in Automation run logs)
 */
export interface ReactionClient {
  knowledge: {
    search(input: KnowledgeSearchInput): Promise<unknown>;
    save(input: KnowledgeSaveInput): Promise<KnowledgeSaveResult>;
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

  connections: {
    /** List configured connections; `device_online` is computed server-side. */
    list(input?: {
      connector_key?: string;
      status?: string;
      entity_id?: number;
      created_by?: string;
      connection_ids?: number[];
      setup_attempt_id?: string;
      limit?: number;
      offset?: number;
    }): Promise<unknown>;
    get(connection_id: number): Promise<unknown>;
  };

  notifications: {
    /**
     * Send a notification: writes it to the org inbox and fans it out to the
     * org's active bot connections (Slack/Telegram). This is how a reaction
     * surfaces its digest to a chat channel.
     */
    send(input: NotificationsSendInput): Promise<NotificationsSendResult>;
  };

  /**
   * Run a connection's operations (connector actions / MCP tools) on demand.
   * Reactions run in the Automation's system context, so they may execute
   * operations the agent itself can't call in-turn — e.g. driving the paired
   * Owletto Chrome extension via a connector action. Pass `automation_source` for
   * run attribution back to the firing window.
   */
  operations: {
    /** List the operations available on a connection (or the whole org). */
    listAvailable(input?: {
      connection_id?: number;
      entity_id?: number;
    }): Promise<unknown>;
    /** Read operational runs, including questions and staged connector actions. */
    listRuns(input?: OperationsListRunsInput): Promise<{
      runs: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      has_more: boolean;
    }>;
    /** Read one durable run and its completed answer/rejection state. */
    getRun(run_id: number): Promise<{ run: Record<string, unknown> }>;
    /** Execute one operation and wait for its result. */
    execute(input: {
      connection_id: number;
      operation_key: string;
      input?: Record<string, unknown>;
      /** Durable key for at-most-once execution across reaction retries. */
      idempotency_key?: string;
      activation?: {
        kind: "page_visit";
        urls: string[];
        expires_in_seconds?: number;
      };
      automation_source?: { automation_id: number; run_id: number };
    }): Promise<{
      status?:
        | "completed"
        | "failed"
        | "timeout"
        | "pending_approval"
        | "in_progress";
      output?: Record<string, unknown>;
      error_message?: string;
      run_id?: number;
    }>;
  };

  /** Run a read-only SQL query against the org's Postgres. */
  query(sql: string): Promise<unknown[]>;

  /** Structured log — appears in the Automation run output. */
  log(message: string, data?: Record<string, unknown>): void;
}
