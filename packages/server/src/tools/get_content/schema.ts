/**
 * Tool: read_knowledge — Typebox schema and argument validation.
 */

import { type Static, Type } from '@sinclair/typebox';

// ============================================
// Typebox Schema
// ============================================

export const GetContentSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        'Search query text (min 3 characters). If provided, performs semantic/full-text search. If omitted, lists content ordered by date.',
      minLength: 3,
    })
  ),
  entity_id: Type.Optional(
    Type.Number({
      description: 'Entity ID to filter by. Required unless watcher_id is provided.',
    })
  ),
  watcher_id: Type.Optional(
    Type.Number({
      description:
        "Watcher ID to fetch content for. When provided, uses watcher's sources and computes pending window. Returns window_token for complete_window action.",
    })
  ),
  template_version_id: Type.Optional(
    Type.Number({
      description:
        "Pin to a specific watcher_versions.id when reading the prompt/schema. Workers receive this from runs.approved_input.version_id and pass it back so a group edit landing mid-run can't make extraction use a different schema. When omitted, defaults to the watcher's current_version_id.",
    })
  ),
  connection_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Connection IDs to filter by',
    })
  ),
  feed_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Feed IDs to filter by (events.feed_id)',
    })
  ),
  run_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description: 'Run IDs to filter by (events.run_id — the run that produced the event)',
    })
  ),
  platforms: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Platform types to filter by (reddit, trustpilot, etc.)',
    })
  ),
  window_id: Type.Optional(
    Type.Number({
      description: 'Watcher window ID to filter by (shows only content analyzed in this window)',
    })
  ),
  since: Type.Optional(
    Type.String({
      description:
        'Filter events published since this date. Supports: ISO 8601 ("2025-01-01"), named aliases ("yesterday", "last_week"), or relative ("7d", "30d", "1m", "1y"). When used with watcher_id, also sets window_start in the generated token.',
    })
  ),
  until: Type.Optional(
    Type.String({
      description:
        'Filter events published until this date. Supports: ISO 8601 ("2025-01-31"), named aliases ("today", "yesterday"), or relative ("7d", "30d", "1m", "1y"). When used with watcher_id, also sets window_end in the generated token.',
    })
  ),
  min_similarity: Type.Optional(
    Type.Number({
      description:
        'Minimum vector similarity threshold for semantic search (0.0-1.0, default: 0.6). Only used when query is provided.',
      minimum: 0.0,
      maximum: 1.0,
      default: 0.6,
    })
  ),
  vector_weight: Type.Optional(
    Type.Number({
      description:
        'Weight of vector similarity vs text rank in combined_score (0.0-1.0, default: 0.6). Higher values favor semantic match over keyword overlap. Only applies when a query and embeddings are both present.',
      minimum: 0.0,
      maximum: 1.0,
    })
  ),
  classification_filters: Type.Optional(
    Type.Record(Type.String(), Type.Array(Type.String()), {
      description:
        'Filter by classification values, e.g. {"sentiment": ["positive", "neutral"], "bug-severity": ["critical"]}',
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Number of results to return (default: 50, max: 2000)',
      default: 50,
    })
  ),
  offset: Type.Optional(
    Type.Number({
      description: 'Number of results to skip for pagination (default: 0)',
      default: 0,
    })
  ),
  before_occurred_at: Type.Optional(
    Type.String({
      description:
        'Chronological cursor anchor for older results. Pair with before_id. Only used when sort_by=date and sort_order=desc.',
    })
  ),
  before_id: Type.Optional(
    Type.Number({
      description:
        'Stable tie-breaker for before_occurred_at. Only used when sort_by=date and sort_order=desc.',
      minimum: 1,
    })
  ),
  after_occurred_at: Type.Optional(
    Type.String({
      description:
        'Chronological cursor anchor for newer results. Pair with after_id. Only used when sort_by=date and sort_order=desc.',
    })
  ),
  after_id: Type.Optional(
    Type.Number({
      description:
        'Stable tie-breaker for after_occurred_at. Only used when sort_by=date and sort_order=desc.',
      minimum: 1,
    })
  ),
  include_classification: Type.Optional(
    Type.String({
      description:
        'Include classification data. Use "summary" to include aggregated classification stats for filter UI.',
    })
  ),
  engagement_min: Type.Optional(
    Type.Number({
      description: 'Minimum engagement score (0-100)',
      minimum: 0,
      maximum: 100,
    })
  ),
  engagement_max: Type.Optional(
    Type.Number({
      description: 'Maximum engagement score (0-100)',
      minimum: 0,
      maximum: 100,
    })
  ),
  sort_by: Type.Optional(
    Type.Union([Type.Literal('date'), Type.Literal('score')], {
      description:
        'Sort content by: date (newest first) or score (cross-platform smart ranking). Search queries respect date sorting for chronological feed browsing; score sorting remains relevance-weighted. Default: score',
      default: 'score',
    })
  ),
  sort_order: Type.Optional(
    Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
      description: 'Sort order: asc (ascending) or desc (descending). Default: desc',
      default: 'desc',
    })
  ),
  include_superseded: Type.Optional(
    Type.Boolean({
      description:
        'When true and listing entity content without a query, include superseded historical events in addition to current records. Useful for explicit historical lookups such as original or previous values.',
      default: false,
    })
  ),
  classification_source: Type.Optional(
    Type.Union([Type.Literal('user'), Type.Literal('embedding'), Type.Literal('llm')], {
      description:
        'Filter content by classification source: user (manual), embedding (system), or llm (AI-generated)',
    })
  ),
  content_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        'Filter to specific content IDs. Useful for showing content linked to watcher analysis.',
    })
  ),
  exclude_watcher_id: Type.Optional(
    Type.Number({
      description:
        'Exclude content already analyzed in any window for this watcher. Returns only unprocessed content for client-driven watcher generation.',
    })
  ),
  semantic_type: Type.Optional(
    Type.Union(
      [
        Type.String(),
        Type.Array(Type.String(), { minItems: 1 }),
      ],
      {
        description:
          'Filter by semantic type. Pass a single value (e.g. "note") or an array (e.g. ["note","summary"]) to match any. Matches the semantic_type set via save_memory.',
      }
    )
  ),
  entity_types: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Org-wide filter: limit to events linked to entities whose type slug is in this list. Ignored when entity_id is set.',
    })
  ),
  interaction_status: Type.Optional(
    Type.Union(
      [
        Type.Literal('pending'),
        Type.Literal('approved'),
        Type.Literal('rejected'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ],
      {
        description: 'Filter by interaction status (e.g. "pending" for pending approvals)',
      }
    )
  ),
});

export type GetContentArgs = Static<typeof GetContentSchema>;

export function getIncludeSupersededValidationErrors(args: Partial<GetContentArgs>): string[] {
  const errors: string[] = [];

  if (!args.entity_id) {
    errors.push('entity_id is required');
  }
  if (args.query) {
    errors.push('query is not supported');
  }
  if (args.content_ids && args.content_ids.length > 0) {
    errors.push('content_ids is not supported');
  }
  if (args.sort_by === 'score') {
    errors.push('sort_by=score is not supported');
  }
  if (args.classification_source) {
    errors.push('classification_source is not supported');
  }
  if (args.classification_filters && Object.keys(args.classification_filters).length > 0) {
    errors.push('classification_filters is not supported');
  }
  if (args.before_occurred_at || args.before_id || args.after_occurred_at || args.after_id) {
    errors.push('cursor pagination is not supported');
  }

  return errors;
}
