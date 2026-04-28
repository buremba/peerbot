/**
 * Allowlist schema for query_sql validation.
 *
 * Sensitive columns (credentials, secrets, tokens, embeddings, PII) are
 * excluded. Two layers of enforcement:
 *   1. validateWithSchema() rejects SQL referencing unlisted tables/columns
 *   2. SAFE_COLUMN_DEFS is used by buildScopedQuery to emit explicit column lists
 *      in CTEs, so excluded columns are never reachable even if validation
 *      is bypassed
 */

import { validateWithSchema } from '@polyglot-sql/sdk';

export interface ColumnDef {
  name: string;
  type: string;
  /** SQL expression to use in SELECT instead of the bare column name.
   *  When set, CTE generation emits `expr as "name"` (or `alias.expr as "name"`). */
  expr?: string;
}

function cols(...names: string[]): ColumnDef[] {
  return names.map((name) => ({ name, type: 'text' }));
}

export const QUERYABLE_SCHEMA = {
  tables: [
    // entities (excludes: embedding, content_tsv, content_hash)
    // entity_type is exposed as a derived column — the CTE JOINs entity_types
    // and aliases et.slug AS entity_type, so user queries can keep referencing it.
    {
      name: 'entities',
      columns: cols(
        'id',
        'entity_type',
        'entity_type_id',
        'parent_id',
        'name',
        'slug',
        'metadata',
        'enabled_classifiers',
        'created_at',
        'updated_at',
        'organization_id',
        'created_by',
        'content',
        'deleted_at',
        'current_view_template_version_id'
      ),
    },
    // events (excludes: embedding)
    {
      name: 'events',
      columns: cols(
        'id',
        'organization_id',
        'entity_ids',
        'origin_id',
        'title',
        'payload_type',
        'payload_text',
        'payload_data',
        'payload_template',
        'attachments',
        'author_name',
        'source_url',
        'occurred_at',
        'score',
        'metadata',
        'created_at',
        'origin_parent_id',
        'origin_type',
        'connector_key',
        'connection_id',
        'feed_key',
        'feed_id',
        'run_id',
        'semantic_type',
        'content_length',
        'client_id',
        'created_by',
        'interaction_type',
        'interaction_status',
        'interaction_input_schema',
        'interaction_input',
        'interaction_output',
        'interaction_error',
        'supersedes_event_id'
      ),
    },
    // connections (excludes: credentials)
    {
      name: 'connections',
      columns: cols(
        'id',
        'organization_id',
        'connector_key',
        'display_name',
        'status',
        'account_id',
        'entity_ids',
        'config',
        'error_message',
        'created_by',
        'created_at',
        'updated_at',
        'auth_profile_id',
        'app_auth_profile_id',
        'visibility',
        'deleted_at',
        'agent_id'
      ),
    },
    // watchers
    {
      name: 'watchers',
      columns: cols(
        'id',
        'name',
        'slug',
        'description',
        'version',
        'current_version_id',
        'schedule',
        'next_run_at',
        'agent_id',
        'scheduler_client_id',
        'model_config',
        'status',
        'created_at',
        'updated_at',
        'entity_ids',
        'sources',
        'tags',
        'created_by',
        'organization_id',
        'reaction_script',
        'reaction_script_compiled',
        'connection_id',
        'source_watcher_id',
        'watcher_group_id'
      ),
    },
    // event_classifications
    {
      name: 'event_classifications',
      columns: cols(
        'id',
        'event_id',
        'classifier_version_id',
        'watcher_id',
        'window_id',
        'values',
        'confidences',
        'source',
        'is_manual',
        'reasoning',
        'met_threshold',
        'threshold',
        'best_match_attribute',
        'embedding_confidence',
        'created_at',
        'excerpts'
      ),
    },
    // watcher_versions
    {
      name: 'watcher_versions',
      columns: cols(
        'id',
        'watcher_id',
        'version',
        'name',
        'description',
        'prompt',
        'extraction_schema',
        'sources',
        'json_template',
        'keying_config',
        'classifiers',
        'condensation_prompt',
        'condensation_window_count',
        'reactions_guidance',
        'change_notes',
        'created_by',
        'created_at',
        'required_source_types',
        'recommended_source_types',
        'version_sources'
      ),
    },
    // watcher_windows
    {
      name: 'watcher_windows',
      columns: cols(
        'id',
        'watcher_id',
        'parent_window_id',
        'granularity',
        'window_start',
        'window_end',
        'content_analyzed',
        'extracted_data',
        'model_used',
        'client_id',
        'run_metadata',
        'execution_time_ms',
        'is_rollup',
        'source_window_ids',
        'created_at',
        'version_id',
        'depth',
        'run_id'
      ),
    },
    // oauth_clients (excludes: client_secret, client_secret_expires_at)
    {
      name: 'oauth_clients',
      columns: cols(
        'id',
        'client_id_issued_at',
        'redirect_uris',
        'token_endpoint_auth_method',
        'grant_types',
        'response_types',
        'client_name',
        'client_uri',
        'logo_uri',
        'scope',
        'contacts',
        'tos_uri',
        'policy_uri',
        'software_id',
        'software_version',
        'user_id',
        'organization_id',
        'metadata',
        'created_at',
        'updated_at'
      ),
    },
    // oauth_tokens (excludes: token_hash)
    {
      name: 'oauth_tokens',
      columns: cols(
        'id',
        'token_type',
        'client_id',
        'user_id',
        'organization_id',
        'scope',
        'resource',
        'parent_token_id',
        'expires_at',
        'revoked_at',
        'created_at'
      ),
    },
    // user (excludes: email, phoneNumber, phoneNumberVerified)
    {
      name: 'user',
      columns: cols('id', 'name', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'username'),
    },
    // feeds (excludes: checkpoint)
    {
      name: 'feeds',
      columns: cols(
        'id',
        'organization_id',
        'connection_id',
        'feed_key',
        'status',
        'entity_ids',
        'config',
        'schedule',
        'next_run_at',
        'last_sync_at',
        'last_sync_status',
        'last_error',
        'consecutive_failures',
        'items_collected',
        'created_at',
        'updated_at',
        'pinned_version',
        'display_name',
        'deleted_at',
        'repair_agent_id',
        'repair_thread_id',
        'repair_attempt_count',
        'last_repair_at',
        'first_failure_at',
        'last_repair_post_hash'
      ),
    },
    // connector_definitions (excludes: large *_config JSONB blobs)
    {
      name: 'connector_definitions',
      columns: cols(
        'id',
        'organization_id',
        'key',
        'name',
        'description',
        'version',
        'auth_schema',
        'feeds_schema',
        'actions_schema',
        'options_schema',
        'status',
        'created_at',
        'updated_at',
        'login_enabled',
        'api_type',
        'favicon_domain',
        'default_repair_agent_id'
      ),
    },
  ],
};

export const QUERYABLE_TABLE_NAMES = new Set(QUERYABLE_SCHEMA.tables.map((t) => t.name));

/** table name → column definitions for use in CTE SELECT.
 *  Columns with `expr` are derived from JSONB and need special handling. */
export const SAFE_COLUMN_DEFS = new Map<string, ColumnDef[]>(
  QUERYABLE_SCHEMA.tables.map((t) => [t.name, t.columns])
);

/** Build a SELECT column list from column defs, optionally prefixed with a table alias. */
export function buildColumnList(defs: ColumnDef[], alias?: string): string {
  return defs
    .map((c) => {
      if (c.expr) {
        const prefixed = alias ? c.expr.replace(/^(\w+)/, `${alias}.$1`) : c.expr;
        return `${prefixed} as "${c.name}"`;
      }
      return alias ? `${alias}."${c.name}"` : `"${c.name}"`;
    })
    .join(', ');
}

/**
 * Validate that SQL only references allowed tables and columns.
 * E200 = unknown table, E201 = unknown column.
 */
export function validateTableQuery(sql: string): { valid: boolean; errors: string[] } {
  const result = validateWithSchema(sql, QUERYABLE_SCHEMA, 'postgresql', { checkReferences: true });
  const errors = (result.errors ?? []).filter(
    (e: { code: string }) => e.code === 'E200' || e.code === 'E201'
  );
  return {
    valid: errors.length === 0,
    errors: errors.map((e: { message: string }) => e.message),
  };
}
