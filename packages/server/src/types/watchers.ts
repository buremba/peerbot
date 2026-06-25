/**
 * Shared Watcher Types
 *
 * Single source of truth for watcher-related types used across
 * backend tools, utils, and frontend components.
 */

// ============================================
// Watcher Sources
// ============================================

/**
 * Watcher source — a named SQL query that feeds data into the prompt.
 * If the query references the `events` table, time window bounds are
 * automatically applied (incremental mode).
 */
export interface WatcherSource {
  name: string;
  query: string;
}

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
export interface WatcherWindowReaction {
  id: number;
  reaction_type: string;
  tool_name: string;
  tool_args?: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
  created_at: string;
}

/**
 * Watcher window data as returned by get_watcher
 */
export interface WatcherWindow {
  window_id: number;
  watcher_id: string;
  watcher_name: string;
  granularity: string;
  window_start: string;
  window_end: string;
  is_rollup: boolean;
  content_analyzed: number;
  extracted_data: Record<string, unknown>;
  previous_extracted_data?: Record<string, unknown>;
  classification_stats?: Record<string, Record<string, number>>;
  model_used: string;
  client_id?: string;
  run_metadata?: Record<string, unknown>;
  execution_time_ms: number;
  created_at: string;
  version_id?: number;
  /** Reaction-script execution log for this window (newest first). */
  reactions?: WatcherWindowReaction[];
}

// ============================================
// Keying Config
// ============================================

/**
 * Configuration for computing stable entity keys.
 * Used to generate deterministic keys for merging entities across windows.
 */
export interface KeyingConfig {
  entity_path: string;
  key_fields: string[];
  key_output_field: string;
  /**
   * Entity-type slug the keyed rows are promoted into (P2 phase 1). When
   * omitted, promotion derives a slug from the last segment of `entity_path`
   * (e.g. `analysis.results.problems` → `problem`). The type must already
   * exist in the watcher's org (or the public catalog); if it can't be
   * resolved, promotion is skipped for this window rather than failing the
   * completion.
   */
  entity_type?: string;
}

// ============================================
// Version Info (for listing available versions)
// ============================================

export interface WatcherVersionInfo {
  version: number;
  name: string;
  created_at: string;
  is_current: boolean;
}

// ============================================
// Watcher Metadata (returned by get_watcher)
// ============================================

export interface WatcherMetadata {
  watcher_id: string;
  watcher_name: string;
  slug: string;
  status: 'active' | 'archived';
  schedule?: string | null;
  next_run_at?: string | null;
  agent_id?: string | null;
  /**
   * Optional FK into `device_workers.id` pinning this watcher (and its run)
   * to a specific device worker. NULL/undefined means any worker can claim.
   */
  device_worker_id?: string | null;
  scheduler_client_id?: string | null;
  version: number;
  sources: WatcherSource[];
  prompt?: string;
  description?: string;
  keying_config?: KeyingConfig | null;
  rendered_prompt?: string;
  available_versions?: WatcherVersionInfo[];
  reaction_script?: string;
  watcher_run?: {
    run_id: number;
    status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
    error_message?: string | null;
    created_at?: string | null;
    completed_at?: string | null;
  };
}

// ============================================
// Pending Analysis
// ============================================

interface NextAction {
  tool: string;
  params: Record<string, unknown>;
  description: string;
}

export interface UnprocessedRange {
  month: string;
  window_start: string;
  window_end: string;
  total_content: number;
  processed_content: number;
  unprocessed_content: number;
  status: 'unprocessed' | 'partial' | 'complete';
}

export interface PendingAnalysis {
  unprocessed_count: number;
  next_window: {
    start: string;
    end: string;
    granularity: string;
  } | null;
  next_action: NextAction | null;
  unprocessed_ranges?: UnprocessedRange[];
}
