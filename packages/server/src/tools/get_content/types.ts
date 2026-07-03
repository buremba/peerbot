/**
 * Tool: read_knowledge — result/row type definitions and small parse helpers.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { ContentItem } from '@lobu/connector-sdk';

// ============================================
// Type Definitions
// ============================================

export type { ContentItem };

/** Classifier configuration returned for watcher mode (for worker embedding generation) */
export interface ClassifierConfig {
  slug: string;
  extraction_config: Record<string, unknown> | null;
  attribute_values: Record<
    string,
    {
      description?: string;
      examples?: string[];
      embedding?: number[] | null;
    }
  >;
}

/**
 * Result of `read_knowledge`. TypeBox-first and the SINGLE source of truth:
 * `GetContentResult` is `Static<>`-derived from this schema, which is also the
 * tool's `outputSchema`. `ContentItem` (a 90-field type in
 * `@lobu/connector-sdk`, a published package) and the watcher-mode
 * `ClassifierConfig`/`UnprocessedRange` payloads are modeled as `unknown`
 * inline — they're opaque over the wire, and mirroring them here would be a
 * brittle second source that drifts from the SDK. The envelope (content list,
 * total, pagination, watcher-mode flags) is precise.
 */
export const GetContentResultSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  total: Type.Integer(),
  page: Type.Object({
    limit: Type.Integer(),
    offset: Type.Integer(),
    has_more: Type.Boolean(),
    has_older: Type.Optional(Type.Boolean()),
    has_newer: Type.Optional(Type.Boolean()),
    next_cursor: Type.Optional(
      Type.Object({ occurred_at: Type.String(), id: Type.Integer() })
    ),
  }),
  classification_stats: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()))
  ),
  /**
   * Permalink for the entity-scoped events listing in the public web app.
   * LLM agents calling `read_knowledge` over MCP read this from the response
   * and format it into chat replies; there is no programmatic consumer in
   * this repo, but removing the field breaks that user-facing behavior.
   */
  view_url: Type.Optional(Type.String()),
  // Watcher-mode fields (only present when watcher_id is provided)
  window_token: Type.Optional(Type.String()),
  window_start: Type.Optional(Type.String()),
  window_end: Type.Optional(Type.String()),
  prompt_rendered: Type.Optional(Type.String()),
  extraction_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sources: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Unknown()))),
  classifiers: Type.Optional(Type.Array(Type.Unknown())),
  unprocessed_ranges: Type.Optional(Type.Array(Type.Unknown())),
  reactions_guidance: Type.Optional(Type.String()),
  available_operations: Type.Optional(
    Type.Array(
      Type.Object({
        connection_id: Type.Integer(),
        operation_key: Type.String(),
        name: Type.String(),
        kind: Type.Union([Type.Literal('read'), Type.Literal('write')]),
        requires_approval: Type.Boolean(),
      })
    )
  ),
  total_count: Type.Optional(Type.Integer()),
  total_count_chars: Type.Optional(Type.Integer()),
  estimated_tokens: Type.Optional(Type.Integer()),
  token_warning: Type.Optional(Type.String()),
  entity_summary: Type.Optional(
    Type.Array(
      Type.Object({
        entity_id: Type.Integer(),
        name: Type.String(),
        entity_type: Type.String(),
        result_count: Type.Integer(),
      })
    )
  ),
  hints: Type.Optional(Type.Array(Type.String())),
});
export type GetContentResult = Static<typeof GetContentResultSchema>;

// ============================================
// Database Row Types (for query result typing)
// ============================================

/** Simple row with just an id field */
export interface IdRow {
  id: number;
}

/** Row type for classification stats aggregation */
export interface ClassificationStatsRow {
  classifier_slug: string;
  value: string;
  count: string | number;
}

/** Row type for raw content query results (union of all possible sources) */
export interface ContentRow {
  id: number;
  entity_ids: number[] | string; // string from some query sources
  platform: string;
  origin_id?: string | null;
  semantic_type: string;
  origin_type?: string | null;
  payload_type?: 'text' | 'markdown' | 'json_template' | 'media' | 'empty' | null;
  payload_text?: string | null;
  payload_data?: Record<string, unknown> | null;
  payload_template?: Record<string, unknown> | null;
  attachments?: unknown[] | null;
  author_name?: string | null;
  title: string | null;
  source_url?: string | null;
  score: number;
  metadata: Record<string, unknown> | null;
  classifications: Record<string, unknown> | null;
  created_at: string;
  occurred_at?: string | null;
  similarity?: number | null;
  text_rank?: number | null;
  combined_score?: number | null;
  score_breakdown?: Record<string, unknown> | null;
  origin_parent_id?: string | null;
  root_origin_id?: string;
  depth?: number;
  interaction_type?: 'none' | 'approval' | null;
  interaction_status?: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed' | null;
  interaction_input_schema?: Record<string, unknown> | null;
  interaction_input?: Record<string, unknown> | null;
  interaction_output?: Record<string, unknown> | null;
  interaction_error?: string | null;
  supersedes_event_id?: number | null;
  parent_context?: Record<string, unknown> | null;
  root_context?: Record<string, unknown> | null;
  client_name?: string | null;
}

export function parseJson(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function toNumberOrUndefined(value: unknown): number | undefined {
  return value != null ? Number(value) : undefined;
}

export function parseRecordArray(value: unknown): Record<string, unknown>[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item)
  );
}
