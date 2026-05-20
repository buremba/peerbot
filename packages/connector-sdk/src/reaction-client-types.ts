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
import type { ReactionContext } from "./reaction-sdk.js";

export type { ReactionContext };

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

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * The client object available in reaction scripts.
 *
 * `client.knowledge`  — read/write/search knowledge events
 * `client.entities`   — CRUD entities and relationships
 * `client.query`      — raw SQL (results as JSON rows)
 * `client.log`        — structured logging (appears in watcher run logs)
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

  /** Run a read-only SQL query against the org's Postgres. */
  query(sql: string): Promise<unknown[]>;

  /** Structured log — appears in the watcher run output. */
  log(message: string, data?: Record<string, unknown>): void;
}
