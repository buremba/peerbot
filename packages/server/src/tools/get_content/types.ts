/**
 * Tool: read_knowledge — result/row type definitions and small parse helpers.
 */

import type { ContentItem } from '@lobu/connector-sdk';
import type { UnprocessedRange } from '../../types/watchers';

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

export interface GetContentResult {
  content: ContentItem[];
  total: number;
  page: {
    limit: number;
    offset: number;
    has_more: boolean;
    has_older?: boolean;
    has_newer?: boolean;
    next_cursor?: {
      occurred_at: string;
      id: number;
    };
  };
  classification_stats?: {
    [classifierSlug: string]: {
      [value: string]: number;
    };
  };
  /**
   * Permalink for the entity-scoped events listing in the public web app.
   * LLM agents calling `read_knowledge` over MCP read this from the response
   * and format it into chat replies; there is no programmatic consumer in
   * this repo, but removing the field breaks that user-facing behavior.
   */
  view_url?: string;
  // Watcher-mode fields (only present when watcher_id is provided)
  window_token?: string;
  window_start?: string;
  window_end?: string;
  prompt_rendered?: string;
  extraction_schema?: Record<string, any>; // JSON Schema for expected LLM output
  sources?: Record<string, ContentItem[]>;
  classifiers?: ClassifierConfig[]; // Only present when watcher_id is provided
  // Unprocessed content summary (only when watcher_id provided without since/until)
  unprocessed_ranges?: UnprocessedRange[];
  // Reaction data (watcher-mode only)
  reactions_guidance?: string; // Template-defined guidance for reactions
  available_operations?: Array<{
    connection_id: number;
    operation_key: string;
    name: string;
    kind: 'read' | 'write';
    requires_approval: boolean;
  }>;
  // Total content stats for the full date range (watcher-mode only)
  // Helps agents estimate token requirements: ~4 chars per token
  total_count?: number;
  total_count_chars?: number;
  estimated_tokens?: number;
  token_warning?: string;
  // Entity summary: shows which entities results cluster around (org-wide search only)
  entity_summary?: Array<{
    entity_id: number;
    name: string;
    entity_type: string;
    result_count: number;
  }>;
  // Hints for the client
  hints?: string[];
}

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
