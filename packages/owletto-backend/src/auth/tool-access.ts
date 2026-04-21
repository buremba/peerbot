/**
 * Tool access policy helpers.
 *
 * Centralizes role/scoped MCP access checks and what anonymous/public
 * callers are allowed to read.
 */

export type ToolAccessLevel = 'read' | 'write' | 'admin';

const MEMBER_WRITE_ACTIONS: Record<string, Set<string> | null> = {
  save_knowledge: null,
  manage_entity: new Set(['create', 'update', 'link', 'unlink', 'update_link']),
};

const OWNER_ADMIN_ACTIONS: Record<string, Set<string>> = {
  manage_entity: new Set(['delete']),
  manage_entity_schema: new Set(['create', 'update', 'delete', 'add_rule', 'remove_rule']),
  manage_connections: new Set([
    'create',
    'update',
    'delete',
    'connect',
    'test',
    'install_connector',
    'uninstall_connector',
    'toggle_connector_login',
    'update_connector_auth',
    'set_connector_entity_link_overrides',
  ]),
  manage_feeds: new Set(['create_feed', 'update_feed', 'delete_feed', 'trigger_feed']),
  manage_auth_profiles: new Set([
    'create_auth_profile',
    'update_auth_profile',
    'delete_auth_profile',
  ]),
  manage_operations: new Set(['execute', 'approve', 'reject']),
  manage_watchers: new Set([
    'create',
    'update',
    'create_version',
    'upgrade',
    'complete_window',
    'delete',
    'set_reaction_script',
    'submit_feedback',
  ]),
  manage_classifiers: new Set([
    'create',
    'create_version',
    'set_current_version',
    'generate_embeddings',
    'delete',
    'classify',
  ]),
};

const PUBLIC_READ_ACTIONS: Record<string, Set<string> | null> = {
  resolve_path: null,
  search_knowledge: null,
  read_knowledge: null,
  get_watcher: null,
  list_watchers: null,
  // Visible to anonymous/non-member sessions so the LLM can discover the
  // self-serve join path on a public workspace. The tool itself enforces
  // authentication and public-org policy at call time.
  join_organization: null,
  manage_entity: new Set(['list', 'get', 'list_links']),
  manage_entity_schema: new Set(['list', 'get', 'audit', 'list_rules']),
  manage_connections: new Set(['list', 'get', 'list_connector_definitions']),
  manage_feeds: new Set(['list_feeds', 'get_feed']),
  manage_auth_profiles: new Set(['list_auth_profiles']),
  manage_operations: new Set(['list_available', 'list_runs', 'get_run']),
  manage_watchers: new Set(['get_versions', 'get_version_details', 'get_component_reference']),
  manage_classifiers: new Set(['list', 'get_versions']),
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
  // query_sql is intentionally owner/admin only despite being read-only.
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
  if (toolName === 'switch_organization') return 'read';
  if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return 'admin';
  if (requiresMemberWrite(toolName, args, readOnlyHint)) return 'write';
  return 'read';
}

export function isPublicReadable(toolName: string, args: unknown): boolean {
  return actionMatches(PUBLIC_READ_ACTIONS, toolName, args);
}

export function getPublicReadableActions(toolName: string): Set<string> | null | undefined {
  return PUBLIC_READ_ACTIONS[toolName];
}
