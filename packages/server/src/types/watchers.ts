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
  json_template?: unknown;
}

// ============================================
// Classification Timeline
// ============================================

interface ClassificationTimelinePoint {
  date: string;
  classifier_slug: string;
  classifier_name: string;
  value: string;
  count: number;
}

interface ClassificationTimelineTotals {
  date: string;
  count: number;
}

export interface ClassificationTimeline {
  granularity: string;
  range: {
    start: string;
    end: string;
  };
  totals: ClassificationTimelineTotals[];
  series: ClassificationTimelinePoint[];
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
// Entity Context
// ============================================

export interface EntityContext {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  total_content: number;
  active_connections: number;
  latest_content_date: string | null;
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
  scheduler_client_id?: string | null;
  version: number;
  sources: WatcherSource[];
  prompt?: string;
  description?: string;
  extraction_schema?: Record<string, unknown>;
  json_template?: unknown;
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
