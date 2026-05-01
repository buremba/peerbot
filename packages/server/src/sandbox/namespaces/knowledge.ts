/**
 * ClientSDK `knowledge` namespace.
 *
 * Wraps `search` (aka search_knowledge), `saveContent` (save_knowledge),
 * `getContent` (read_knowledge), and `deleteContent` (delete_knowledge).
 * The SDK surface mirrors the MCP tool surface for consistency.
 */

import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";

export interface KnowledgeSearchInput {
  query?: string;
  entity_type?: string;
  entity_id?: number;
  parent_id?: number;
  market?: string;
  category?: string;
  fuzzy?: boolean;
  min_similarity?: number;
  include_connections?: boolean;
  include_content?: boolean;
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
  /** Fetch a single content event by id. */
  content_id?: number;
  /** Fetch knowledge for a watcher window (prompt rendering). */
  watcher_id?: number;
  since?: string;
  until?: string;
  limit?: number;
  entity_ids?: number[];
}

export type KnowledgeDeleteInput =
  | number
  | { event_id?: number; event_ids?: number[]; reason?: string };

export interface KnowledgeNamespace {
  search(input: KnowledgeSearchInput): Promise<unknown>;
  save(input: KnowledgeSaveInput): Promise<unknown>;
  read(input: KnowledgeReadInput): Promise<unknown>;
  delete(input: KnowledgeDeleteInput): Promise<unknown>;
}

export function buildKnowledgeNamespace(
  ctx: ToolContext,
  env: Env
): KnowledgeNamespace {
  return {
    async search(input) {
      const { search } = await import("../../tools/search");
      return search(input as never, env, ctx) as Promise<unknown>;
    },
    async save(input) {
      const { saveContent } = await import("../../tools/save_content");
      return saveContent(input as never, env, ctx) as Promise<unknown>;
    },
    async read(input) {
      const { getContent } = await import("../../tools/get_content");
      return getContent(input as never, env, ctx) as Promise<unknown>;
    },
    async delete(input) {
      const { deleteContent } = await import("../../tools/delete_content");
      const args =
        typeof input === "number" ? { event_id: input } : input ?? {};
      return deleteContent(args as never, env, ctx) as Promise<unknown>;
    },
  };
}
