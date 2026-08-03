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
  BehaviorTriggerSchema,
  type BehaviorTrigger,
  BehaviorSourceSchema,
  type BehaviorSource,
  BehaviorOutputsSchema,
  type BehaviorOutputs,
  type BehaviorEntityOutput,
  type BehaviorEventOutput,
} from '@lobu/core/contracts/tools/manage-behaviors';

type WatcherSource = BehaviorSource;
const WatcherSourceSchema = BehaviorSourceSchema;

export {
  BehaviorTriggerSchema,
  type BehaviorTrigger,
  BehaviorSourceSchema as WatcherSourceSchema,
  type WatcherSource,
};

// ============================================
// Watcher Version
// ============================================

// ============================================
// Watcher Window
// ============================================

/**
 * One reaction-log entry for a window (from watcher_reactions). Surfaced on
 * get_behavior windows so the UI can show what the reaction script did.
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
 * Behavior window data as returned by get_behavior
 */
export const WatcherWindowSchema = Type.Object({
  window_id: Type.Integer(),
  behavior_id: Type.String(),
  behavior_name: Type.String(),
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
// Behavior Outputs
// ============================================

export const OutputsSchema = BehaviorOutputsSchema;
export type Outputs = BehaviorOutputs;
export type EntityOutput = BehaviorEntityOutput;
export type EventOutput = BehaviorEventOutput;

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
// Behavior metadata (returned by get_behavior)
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
  behavior_id: Type.String(),
  behavior_name: Type.String(),
  slug: Type.String(),
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  triggers: Type.Optional(Type.Array(BehaviorTriggerSchema)),
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
  outputs: Type.Optional(Type.Union([OutputsSchema, Type.Null()])),
  /** Version-owned config surfaced so the edit form can round-trip them
   *  (create_version preserves prev values on omit, but prefilling avoids
   *  the empty-form-state clobber). */
  classifiers: Type.Optional(Type.Array(Type.Unknown())),
  reactions_guidance: Type.Optional(Type.String()),
  available_versions: Type.Optional(Type.Array(WatcherVersionInfoSchema)),
  reaction_script: Type.Optional(Type.String()),
  behavior_run: Type.Optional(WatcherRunSchema),
  /** Computed health (item 3, #2033): `degraded` when an active
   *  behavior's latest run failed/timed out, it missed a firing, or its latest
   *  run is stuck pending past the stale interval; else `healthy`. */
  health: Type.Optional(
    Type.Union([Type.Literal('healthy'), Type.Literal('degraded')])
  ),
  /** Reasons behind a `degraded` verdict (empty/omitted when healthy). */
  health_reasons: Type.Optional(Type.Array(Type.String())),
  /** Latest run error surfaced alongside the health verdict. */
  last_scheduling_error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
