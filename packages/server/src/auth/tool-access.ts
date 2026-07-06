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

export type ToolAccessLevel = "read" | "write" | "admin";

const MEMBER_WRITE_ACTIONS: Record<string, Set<string> | null> = {
	save_memory: null,
	// `run_sdk` reaches admin handlers inside the script; per-call gates fire
	// on each SDK method, so the entry-point check is just write-tier.
	run_sdk: null,
	// `manage_*` per-action policy. The same tables gate every surface: direct
	// tool calls (MCP / REST proxy) via `checkToolAccess`, and the SDK namespace
	// wrappers inside `run_sdk` via `routeAction`.
	manage_entity: new Set(["create", "update", "link", "unlink", "update_link"]),
	// Members can install connections that bind to their own OAuth account
	// grant. `update` is here so members can rebind their own connection's
	// auth profile / display name / device pin; the handler enforces
	// `created_by === ctx.userId` plus the same per-field role gates as
	// create (app_auth_profile pinned-default, target-profile ownership).
	manage_connections: new Set(["create", "update", "reauthenticate"]),
	// Members create / reconnect their own oauth_account profile. The handler
	// gates `profile_kind` against role so env / oauth_app / browser_session
	// stay admin-only.
	manage_auth_profiles: new Set([
		"create_auth_profile",
		"update_auth_profile",
		"test_auth_profile",
		"get_auth_profile",
	]),
	// `complete_window` is how watcher AGENTS report results — server-side
	// agent workers and device CLI runs (the Owletto Mac dispatcher wires the
	// gateway MCP into the spawned CLI; device tokens carry mcp:write, not
	// admin). The handler still enforces org/entity write access via
	// requireWatcherAccess; watcher ADMINISTRATION (create/update/delete/…)
	// stays admin-tier below.
	manage_watchers: new Set(["complete_window"]),
};

const OWNER_ADMIN_ACTIONS: Record<string, Set<string>> = {
	manage_entity: new Set(["delete"]),
	manage_entity_schema: new Set([
		"create",
		"update",
		"delete",
		"add_rule",
		"remove_rule",
	]),
	manage_connections: new Set([
		// `create`, `update`, `reauthenticate` are in MEMBER_WRITE_ACTIONS —
		// members install / edit their own connections (handler enforces
		// created_by === ctx.userId + app_auth_profile slug override + role
		// gates).
		"delete",
		"connect",
		"test",
		"install_connector",
		"uninstall_connector",
		"toggle_connector_login",
		"update_connector_auth",
		"update_connector_default_config",
		"update_connector_default_repair_agent",
		"apply_chat_connection",
		// Channel management (folded from the retired /channels routes): mutating
		// a binding / wiring a DM is administration. list_channel_bindings is
		// read-tier (PUBLIC_READ_ACTIONS). Each handler
		// also fences on agent-in-org.
		"bind_channel",
		"unbind_channel",
		"sync_channel_bindings",
		"connect_channel_dm",
	]),
	manage_feeds: new Set([
		"create_feed",
		"update_feed",
		"delete_feed",
		"trigger_feed",
	]),
	manage_auth_profiles: new Set([
		// `create_auth_profile` and `update_auth_profile` are in
		// MEMBER_WRITE_ACTIONS — the handler enforces oauth_account-only access
		// for non-admins so members can't create org-shared credentials.
		"get_auth_profile",
		"test_auth_profile",
		"delete_auth_profile",
		"set_default_auth_profile",
	]),
	manage_operations: new Set(["execute", "approve", "reject"]),
	manage_watchers: new Set([
		// `complete_window` is in MEMBER_WRITE_ACTIONS — it's the agent result
		// path (server workers + device CLI over MCP), not administration.
		"create",
		"update",
		"create_version",
		"trigger",
		"delete",
		"set_reaction_script",
		"submit_feedback",
		"create_from_version",
	]),
	manage_agents: new Set([
		"list",
		"get",
		"create",
		"update",
		"delete",
		"set_system_agent",
	]),
	manage_classifiers: new Set([
		"create",
		"generate_embeddings",
		"delete",
		"classify",
	]),
	manage_view_templates: new Set(["set", "rollback", "remove_tab", "clear"]),
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
	manage_entity: new Set(["list", "get", "list_links"]),
	manage_entity_schema: new Set(["list", "get", "audit", "list_rules"]),
	manage_connections: new Set([
		"list",
		"list_connector_groups",
		"get",
		"list_channel_bindings",
	]),
	manage_catalog: new Set(["list_catalog", "list_installed"]),
	manage_feeds: new Set(["list_feeds", "read_feed", "read_feeds"]),
	manage_auth_profiles: new Set(["list_auth_profiles"]),
	manage_operations: new Set(["list_available", "list_runs", "get_run"]),
	manage_watchers: new Set([
		"get_versions",
		"get_version_details",
		"get_component_reference",
		"get_feedback",
	]),
	manage_classifiers: new Set(["list"]),
	manage_view_templates: new Set(["get"]),
};

function getAction(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const value = (args as { action?: unknown }).action;
	return typeof value === "string" ? value : null;
}

function actionMatches(
	policy: Record<string, Set<string> | null>,
	toolName: string,
	args: unknown,
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
	readOnlyHint: boolean,
): boolean {
	if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return false;
	return actionMatches(MEMBER_WRITE_ACTIONS, toolName, args);
}

export function requiresOwnerAdmin(
	toolName: string,
	args: unknown,
	readOnlyHint: boolean,
): boolean {
	// query_sql / metric_series are read-tier (members may query their org's
	// operational data). The auth/identity tables (oauth_tokens, oauth_clients,
	// user) stay admin-only via ADMIN_ONLY_QUERYABLE_TABLES, enforced per-query in
	// those handlers — not by gating the whole tool to admins.
	if (actionMatches(OWNER_ADMIN_ACTIONS, toolName, args)) return true;

	const hasExplicitPolicy =
		toolName in OWNER_ADMIN_ACTIONS || toolName in MEMBER_WRITE_ACTIONS;

	// For tools without explicit policy, fall back to readOnly hint.
	return !readOnlyHint && !hasExplicitPolicy;
}

export function getRequiredAccessLevel(
	toolName: string,
	args: unknown,
	readOnlyHint: boolean,
): ToolAccessLevel {
	if (toolName === "list_organizations") return "read";
	if (requiresOwnerAdmin(toolName, args, readOnlyHint)) return "admin";
	if (requiresMemberWrite(toolName, args, readOnlyHint)) return "write";
	return "read";
}

/**
 * Sentinel scope that means "MCP scope check is not applicable to this
 * caller" — used for session-cookie and anonymous auth, where authorization
 * is gated by member role and public-readability instead of token scopes
 * (those auth types never carry MCP scopes). It is NOT a scope an OAuth/PAT
 * token can ever present (`parseScopes` only emits `mcp:*`), so it cannot be
 * forged by a token-based caller.
 *
 * INVARIANT: `hasRequiredMcpScope` must FAIL CLOSED on `null`/`undefined`.
 * A missing scope set is an unauthenticated/under-specified caller, never a
 * grant of full access. Callers that legitimately have no scope dimension
 * (session/anonymous) pass this sentinel explicitly; token callers pass their
 * real scopes (or `[]` for a token minted without any, which then denies).
 */
export const SCOPE_CHECK_NOT_APPLICABLE: readonly string[] = ["*"];

export function hasRequiredMcpScope(
	requiredAccess: ToolAccessLevel,
	scopes: readonly string[] | null | undefined,
): boolean {
	// Fail closed: a null/undefined scope set means the caller presented no
	// MCP scope claim. It must NOT be treated as full access.
	if (scopes == null) return false;
	if (scopes.length === 0) return false;
	// Session/anonymous bypass sentinel: scope dimension does not apply (these
	// callers are gated by role + public-readability upstream).
	if (scopes.includes("*")) return true;
	const scopeSet = new Set(scopes);
	if (requiredAccess === "read") {
		return (
			scopeSet.has("mcp:read") ||
			scopeSet.has("mcp:write") ||
			scopeSet.has("mcp:admin")
		);
	}
	if (requiredAccess === "write") {
		return scopeSet.has("mcp:write") || scopeSet.has("mcp:admin");
	}
	return scopeSet.has("mcp:admin");
}

/**
 * Highest access tier a caller can exercise, from member role x `mcp:*`
 * scopes. `null`/sentinel scopes don't limit (session/anonymous callers are
 * gated by role + public-readability instead). Shared by MCP `tools/list` and
 * `GET /api/:orgSlug/tools` so both surfaces filter identically.
 */
export function resolveMaxAccessLevel(
	memberRole: string | null | undefined,
	scopes: readonly string[] | null | undefined,
): ToolAccessLevel {
	const roleLevel: ToolAccessLevel = !memberRole
		? "read"
		: memberRole === "owner" || memberRole === "admin"
			? "admin"
			: "write";
	const scopeLevel: ToolAccessLevel =
		scopes == null || scopes.includes("*") || scopes.includes("mcp:admin")
			? "admin"
			: scopes.includes("mcp:write")
				? "write"
				: "read";
	if (roleLevel === "read" || scopeLevel === "read") return "read";
	if (roleLevel === "write" || scopeLevel === "write") return "write";
	return "admin";
}

export function isPublicReadable(toolName: string, args: unknown): boolean {
	return actionMatches(PUBLIC_READ_ACTIONS, toolName, args);
}

export function getPublicReadableActions(
	toolName: string,
): Set<string> | null | undefined {
	return PUBLIC_READ_ACTIONS[toolName];
}
