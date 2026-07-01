/**
 * Pins the whole tool access surface in one compact fixture: for every
 * registered tool, every action's required tier (+public readability), plus
 * the `?` probe (an unknown action pins the fallback branch: tools with
 * per-action policy resolve unknown actions to read-tier before handler
 * validation rejects them; tools without fall back to the readOnly hint).
 *
 * A diff here is an access-control change — review it as one. The fixture was
 * captured before the internal-flag removal and stayed identical through it:
 * visibility changed, the access matrix did not.
 *
 * Regenerate a line by copying the test's computed output from the failure
 * diff (each line is independent).
 */

import { describe, expect, it } from "vitest";
import {
	getRequiredAccessLevel,
	isPublicReadable,
	resolveMaxAccessLevel,
} from "../../auth/tool-access";
import { getAllTools } from "../registry";

const ACCESS_SURFACE = `
search_memory: read+public ?=read+public
save_memory: write ?=write
list_organizations: read ?=read
search_sdk: read+public ?=read+public
query_sdk: read ?=read
list_metrics: read ?=read
query_metric: read ?=read
query_sql: read ?=read
metric_series: read ?=read
run_sdk: write ?=write
manage_entity: create=write update=write list=read+public get=read+public delete=admin link=write unlink=write update_link=write list_links=read+public ?=read
manage_entity_schema: list=read+public get=read+public create=admin update=admin delete=admin audit=read+public add_rule=admin remove_rule=admin list_rules=read+public ?=read
manage_connections: list_connector_groups=read+public list=read+public get=read+public create=write connect=admin update=write delete=admin reauthenticate=write test=admin install_connector=admin uninstall_connector=admin toggle_connector_login=admin update_connector_auth=admin update_connector_default_config=admin update_connector_default_repair_agent=admin set_connector_entity_link_overrides=admin list_channel_bindings=read+public bind_channel=admin unbind_channel=admin get_channel_audience=read+public connect_channel_dm=admin ?=read
manage_catalog: list_catalog=read+public list_installed=read+public ?=read
manage_agents: list=admin get=admin create=admin update=admin delete=admin set_system_agent=admin ?=read
manage_feeds: list_feeds=read+public read_feed=read+public create_feed=admin update_feed=admin delete_feed=admin trigger_feed=admin ?=read
manage_auth_profiles: list_auth_profiles=read+public get_auth_profile=admin test_auth_profile=admin create_auth_profile=write update_auth_profile=write delete_auth_profile=admin set_default_auth_profile=admin ?=read
manage_operations: list_available=read+public execute=admin list_runs=read+public get_run=read+public approve=admin reject=admin ?=read
notify: send=admin ?=admin
manage_schedules: create=admin list=admin update=admin pause=admin cancel=admin ?=admin
manage_watchers: create=admin update=admin create_version=admin complete_window=write trigger=admin delete=admin set_reaction_script=admin get_versions=read+public get_version_details=read+public get_component_reference=read+public submit_feedback=admin get_feedback=read+public list_promoted=read create_from_version=admin ?=read
list_watchers: read+public ?=read+public
get_watcher: read+public ?=read+public
read_knowledge: read+public ?=read+public
manage_classifiers: create=admin list=read+public generate_embeddings=admin delete=admin classify=admin ?=read
manage_view_templates: set=admin get=read+public rollback=admin remove_tab=admin clear=admin ?=read
resolve_path: read+public ?=read+public
`.trim();

function actionsOf(schema: any): string[] | null {
	const action = schema?.properties?.action;
	if (Array.isArray(action?.enum)) return action.enum.map(String);
	if (typeof action?.const === "string") return [action.const];
	// Flat tools (defineFlatActionTool) keep `action` as a TypeBox union of
	// literals, which serializes as anyOf-of-const inside the property.
	if (Array.isArray(action?.anyOf)) {
		const consts = action.anyOf
			.map((v: any) => v?.const)
			.filter((v: unknown): v is string => typeof v === "string");
		return consts.length > 0 ? consts : null;
	}
	return null;
}

function computeAccessSurface(): string {
	const lines: string[] = [];
	for (const tool of getAllTools({ publicOnly: false, maxAccessLevel: "admin" })) {
		const readOnly = tool.annotations?.readOnlyHint === true;
		const actions = actionsOf(tool.inputSchema) ?? ["-"];
		const parts = [...actions, "?"].map((action) => {
			const args = action === "-" ? {} : { action };
			const key = action === "-" ? "" : `${action}=`;
			const tier = getRequiredAccessLevel(tool.name, args, readOnly);
			const pub = isPublicReadable(tool.name, args) ? "+public" : "";
			return `${key}${tier}${pub}`;
		});
		lines.push(`${tool.name}: ${parts.join(" ")}`);
	}
	return lines.join("\n");
}

describe("tool surface", () => {
	it("access matrix matches the pinned fixture", () => {
		expect(computeAccessSurface()).toBe(ACCESS_SURFACE);
	});

	it("lists every registered tool uniformly at admin level (no hidden tools)", () => {
		const names = getAllTools({ publicOnly: false, maxAccessLevel: "admin" }).map(
			(t) => t.name
		);
		// Admin tools and frontend tools are on the same uniform surface.
		for (const name of ["manage_agents", "manage_watchers", "metric_series", "resolve_path"]) {
			expect(names).toContain(name);
		}
	});

	it("drops tools whose no-args tier exceeds the caller level (write)", () => {
		const write = getAllTools({ publicOnly: false, maxAccessLevel: "write" });
		const names = write.map((t) => t.name);
		// Admin-everywhere tools without per-action policy disappear below admin.
		expect(names).not.toContain("manage_schedules");
		expect(names).not.toContain("notify");
		// Flat-schema tools with per-action policy stay listed (their no-args
		// tier is read); execution of admin actions is still denied per-call by
		// checkToolAccess — listing is advisory, the execute gate is the law.
		expect(names).toContain("manage_agents");
		expect(names).toContain("manage_watchers");
	});

	it("resolveMaxAccessLevel is the min of role and scope tiers", () => {
		expect(resolveMaxAccessLevel("owner", ["mcp:admin"])).toBe("admin");
		expect(resolveMaxAccessLevel("owner", ["mcp:write"])).toBe("write");
		expect(resolveMaxAccessLevel("member", ["mcp:admin"])).toBe("write");
		expect(resolveMaxAccessLevel(null, ["mcp:admin"])).toBe("read");
		expect(resolveMaxAccessLevel("owner", ["*"])).toBe("admin");
		expect(resolveMaxAccessLevel("owner", null)).toBe("admin");
	});
});
