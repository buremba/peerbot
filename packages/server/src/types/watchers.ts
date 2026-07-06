/**
 * Shared Watcher Types
 *
 * Single source of truth for watcher-related types used across
 * backend tools, utils, and frontend components. TypeBox-first: each type is
 * derived from its schema via `Static<>`, so the runtime JSON Schema (surfaced
 * as MCP tool `outputSchema`) and the TS type cannot drift.
 */

import { type Static, Type } from '@sinclair/typebox';
import {
  WatcherSourceSchema,
  type WatcherSource,
} from '@lobu/core/contracts/tools/manage-watchers';

export { WatcherSourceSchema, type WatcherSource };

// ============================================
// Watcher Version
// ============================================

// ============================================
// Watcher Window
// ============================================

/**
 * One reaction-log entry for a window (from watcher_reactions). Surfaced on
 * get_watcher windows so the UI can show what the reaction script did.
 */
export const WatcherWindowReactionSchema = Type.Object({
  id: Type.Integer(),
  reaction_type: Type.String(),
  tool_name: Type.String(),
  tool_args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  tool_result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  created_at: Type.String(),
});
export type WatcherWindowReaction = Static<typeof WatcherWindowReactionSchema>;

/**
 * Watcher window data as returned by get_watcher
 */
export const WatcherWindowSchema = Type.Object({
  window_id: Type.Integer(),
  watcher_id: Type.String(),
  watcher_name: Type.String(),
  granularity: Type.String(),
  window_start: Type.String(),
  window_end: Type.String(),
  content_analyzed: Type.Integer(),
  extracted_data: Type.Record(Type.String(), Type.Unknown()),
  previous_extracted_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  classification_stats: Type.Optional(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()))
  ),
  model_used: Type.String(),
  client_id: Type.Optional(Type.String()),
  run_metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  execution_time_ms: Type.Integer(),
  created_at: Type.String(),
  version_id: Type.Optional(Type.Integer()),
  /** Reaction-script execution log for this window (newest first). */
  reactions: Type.Optional(Type.Array(WatcherWindowReactionSchema)),
});
export type WatcherWindow = Static<typeof WatcherWindowSchema>;

// ============================================
// Keying Config
// ============================================

/**
 * Configuration for computing stable entity keys.
 * Used to generate deterministic keys for merging entities across windows.
 */
export const KeyingConfigSchema = Type.Object({
  entity_path: Type.String(),
  key_fields: Type.Array(Type.String()),
  key_output_field: Type.String(),
  /**
   * Entity-type slug the keyed rows are promoted into (P2 phase 1). When
   * omitted, promotion derives a slug from the last segment of `entity_path`
   * (e.g. `analysis.results.problems` → `problem`). The type must already
   * exist in the watcher's org (or the public catalog); if it can't be
   * resolved, promotion is skipped for this window rather than failing the
   * completion.
   */
  entity_type: Type.Optional(Type.String()),
});
export type KeyingConfig = Static<typeof KeyingConfigSchema>;

// ============================================
// Version Info (for listing available versions)
// ============================================

export const WatcherVersionInfoSchema = Type.Object({
  version: Type.Integer(),
  name: Type.String(),
  created_at: Type.String(),
  is_current: Type.Boolean(),
});
export type WatcherVersionInfo = Static<typeof WatcherVersionInfoSchema>;

// ============================================
// Watcher Metadata (returned by get_watcher)
// ============================================

const WatcherRunSchema = Type.Object({
  run_id: Type.Integer(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('claimed'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
    Type.Literal('timeout'),
  ]),
  error_message: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  created_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  completed_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const WatcherMetadataSchema = Type.Object({
  watcher_id: Type.String(),
  watcher_name: Type.String(),
  slug: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  schedule: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  next_run_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  agent_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * Optional FK into `device_workers.id` pinning this watcher (and its run)
   * to a specific device worker. NULL/undefined means any worker can claim.
   */
  device_worker_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scheduler_client_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  version: Type.Integer(),
  sources: Type.Array(WatcherSourceSchema),
  prompt: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  keying_config: Type.Optional(Type.Union([KeyingConfigSchema, Type.Null()])),
  /** Version-owned config surfaced so the edit form can round-trip them
   *  (create_version preserves prev values on omit, but prefilling avoids
   *  the empty-form-state clobber). */
  classifiers: Type.Optional(Type.Array(Type.Unknown())),
  reactions_guidance: Type.Optional(Type.String()),
  rendered_prompt: Type.Optional(Type.String()),
  available_versions: Type.Optional(Type.Array(WatcherVersionInfoSchema)),
  reaction_script: Type.Optional(Type.String()),
  watcher_run: Type.Optional(WatcherRunSchema),
});
export type WatcherMetadata = Static<typeof WatcherMetadataSchema>;

// ============================================
// Pending Analysis
// ============================================

const NextActionSchema = Type.Object({
  tool: Type.String(),
  params: Type.Record(Type.String(), Type.Unknown()),
  description: Type.String(),
});

export const UnprocessedRangeSchema = Type.Object({
  month: Type.String(),
  window_start: Type.String(),
  window_end: Type.String(),
  total_content: Type.Integer(),
  processed_content: Type.Integer(),
  unprocessed_content: Type.Integer(),
  status: Type.Union([
    Type.Literal('unprocessed'),
    Type.Literal('partial'),
    Type.Literal('complete'),
  ]),
});
export type UnprocessedRange = Static<typeof UnprocessedRangeSchema>;

export const PendingAnalysisSchema = Type.Object({
  unprocessed_count: Type.Integer(),
  next_window: Type.Union([
    Type.Object({
      start: Type.String(),
      end: Type.String(),
      granularity: Type.String(),
    }),
    Type.Null(),
  ]),
  next_action: Type.Union([NextActionSchema, Type.Null()]),
  unprocessed_ranges: Type.Optional(Type.Array(UnprocessedRangeSchema)),
});
export type PendingAnalysis = Static<typeof PendingAnalysisSchema>;
