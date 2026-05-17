/**
 * Tool access policy helpers.
 *
 * Centralizes role/scoped MCP access checks and what anonymous/public
 * callers are allowed to read.
 *
 * Note on `run_sdk`: the MCP entry point requires write-tier access, and
 * admin-only SDK methods still re-check role + MCP scope at the delegated
 * handler boundary before any mutation runs. `query_sdk` runs over the read-only
 * SDK so it falls through to the default read-tier check.
 */

export type ToolAccessLevel = 'read' | 'write' | 'admin';

const MEMBER_WRITE_ACTIONS: Record<string, Set<string> | null> = {
  save_memory: null,
  // `run_sdk` reaches admin handlers inside the script; per-call gates fire
  // on each SDK method, so the entry-point check is just write-tier.
  run_sdk: null,
  // Legacy `manage_*` policy entries — the tools themselves are no longer
  // exposed on the external MCP surface, but the handlers are still reached
  // via SDK namespace wrappers from inside `run_sdk`, and `routeAction` consults
  // these tables to fire the same per-action access decisions.
  manage_entity: new Set(['create', 'update', 'link', 'unlink', 'update_link']),
  // Members can install connections that bind to their own OAuth account
  // grant. `update` is here so members can rebind their own connection's
  // auth profile / display name / device pin; the handler enforces
  // `created_by === ctx.userId` plus the same per-field role gates as
  // create (app_auth_profile pinned-default, target-profile ownership).
  manage_connections: new Set(['create', 'update', 'reauthenticate']),
  // Members create / reconnect their own oauth_account profile. The handler
  // gates `profile_kind` against role so env / oauth_app / browser_session
  // stay admin-only.
  manage_auth_profiles: new Set([
    'create_auth_profile',
    'update_auth_profile',
    'test_auth_profile',
    'get_auth_profile',
  ]),
};

const OWNER_ADMIN_ACTIONS: Record<string, Set<string>> = {
  manage_entity: new Set(['delete']),
  manage_entity_schema: new Set(['create', 'update', 'delete', 'add_rule', 'remove_rule']),
  manage_connections: new Set([
    // `create`, `update`, `reauthenticate` are in MEMBER_WRITE_ACTIONS —
    // members install / edit their own connections (handler enforces
    // created_by === ctx.userId + app_auth_profile slug override + role
    // gates).
    'delete',
    'connect',
    'test',
    'install_connector',
    'uninstall_connector',
    'toggle_connector_login',
    'update_connector_auth',
    'update_connector_default_config',
    'update_connector_default_repair_agent',
    'set_connector_entity_link_overrides',
  ]),
  manage_feeds: new Set(['create_feed', 'update_feed', 'delete_feed', 'trigger_feed']),
  manage_auth_profiles: new Set([
    // `create_auth_profile` and `update_auth_profile` are in
    // MEMBER_WRITE_ACTIONS — the handler enforces oauth_account-only access
    // for non-admins so members can't create org-shared credentials.
    'get_auth_profile',
    'test_auth_profile',
    'delete_auth_profile',
    'set_default_auth_profile',
  ]),
  manage_operations: new Set(['execute', 'approve', 'reject']),
  manage_watchers: new Set([
    'create',
    'update',
    'create_version',
    'upgrade',
    'complete_window',
    'trigger',
    'delete',
    'set_reaction_script',
    'submit_feedback',
    'create_from_version',
  ]),
  manage_classifiers: new Set([
    'create',
    'create_version',
    'set_current_version',
    'generate_embeddings',
    'delete',
    'classify',
  ]),
  manage_view_templates: new Set(['set', 'rollback', 'remove_tab']),
};

const PUBLIC_READ_ACTIONS: Record<string, Set<string> | null> = {
  resolve_path: null,
  search_memory: null,
  // SDK method discovery — safe to expose; surfaces no data.
  search_sdk: null,
  // Internal read-paths — kept for tests that exercise public-readability
  // semantics; legitimate external access is via `query_sdk` / `run_sdk`.
  read_knowledge: null,
  get_watcher: null,
  list_watchers: null,
  manage_entity: new Set(['list', 'get', 'list_links']),
  manage_entity_schema: new Set(['list', 'get', 'audit', 'list_rules']),
  manage_connections: new Set(['list', 'get', 'list_connector_definitions']),
  manage_feeds: new Set(['list_feeds', 'get_feed']),
  manage_auth_profiles: new Set(['list_auth_profiles']),
  manage_operations: new Set(['list_available', 'list_runs', 'get_run']),
  manage_watchers: new Set([
    'get_versions',
    'get_version_details',
    'get_component_reference',
    'get_feedback',
  ]),
  manage_classifiers: new Set(['list', 'get_versions']),
  manage_view_templates: new Set(['get']),
};

function getAction(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const value = (args as { action?: unknown }).action;
  return typeof value === 'string' ? value : null;
}

function actionMatches(
  policy: Record<string, Set<string> | null>,
  toolName: string,
  args: unknown
): boolean {
  if (!(toolName in policy)) return false;
  const allowedActions = policy[toolName];
  if (allowedActions === null) return true;
  const action = getAction(args);
  return !!action && allowedActions.has(action);
}

export function requiresMemberWrite(
  toolName: string,
  args: unknown,
  readOnlyHint: boolean
): boolean {
  if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return false;
  return actionMatches(MEMBER_WRITE_ACTIONS, toolName, args);
}

export function requiresOwnerAdmin(
  toolName: string,
  args: unknown,
  readOnlyHint: boolean
): boolean {
  // query_sql is intentionally owner/admin only despite being read-only —
  // it can read across the whole org's data, including audit/event tables.
  if (toolName === 'query_sql') return true;

  if (actionMatches(OWNER_ADMIN_ACTIONS, toolName, args)) return true;

  const hasExplicitPolicy = toolName in OWNER_ADMIN_ACTIONS || toolName in MEMBER_WRITE_ACTIONS;

  // For tools without explicit policy, fall back to readOnly hint.
  return !readOnlyHint && !hasExplicitPolicy;
}

export function getRequiredAccessLevel(
  toolName: string,
  args: unknown,
  readOnlyHint: boolean
): ToolAccessLevel {
  if (toolName === 'list_organizations') return 'read';
  if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return 'admin';
  if (requiresMemberWrite(toolName, args, readOnlyHint)) return 'write';
  return 'read';
}

export function hasRequiredMcpScope(
  requiredAccess: ToolAccessLevel,
  scopes: string[] | null | undefined
): boolean {
  if (scopes == null) return true;
  if (scopes.length === 0) return false;
  const scopeSet = new Set(scopes);
  if (requiredAccess === 'read') {
    return scopeSet.has('mcp:read') || scopeSet.has('mcp:write') || scopeSet.has('mcp:admin');
  }
  if (requiredAccess === 'write') {
    return scopeSet.has('mcp:write') || scopeSet.has('mcp:admin');
  }
  return scopeSet.has('mcp:admin');
}

export function isPublicReadable(toolName: string, args: unknown): boolean {
  return actionMatches(PUBLIC_READ_ACTIONS, toolName, args);
}

export function getPublicReadableActions(toolName: string): Set<string> | null | undefined {
  return PUBLIC_READ_ACTIONS[toolName];
}
