import { describe, expect, it } from "bun:test";
import { buildClientSDK } from "../../sandbox/client-sdk";
import type { Env } from "../../index";
import type { ToolContext } from "../../tools/registry";
import { ADMIN_TOOLS } from "../../tools/admin";
import { METHOD_METADATA } from "../../sandbox/method-metadata";
import {
	AGENT_TOOL_NAMES,
	getAllTools,
	getMcpTools,
	getTool,
	isInternalDispatchTool,
} from "../../tools/registry";

/** Agent MCP flat tools (excluding meta scripting/discovery) → SDK dotted path. */
const AGENT_FLAT_TOOL_SDK_PATH: Record<string, string> = {
	query_sql: "query",
	search_memory: "knowledge.search",
	save_memory: "knowledge.save",
};

/** Internal dispatch flat tools omitted from MCP list → SDK dotted path. */
const INTERNAL_FLAT_TOOL_SDK_PATH: Record<string, string> = {
	list_metrics: "metrics.list",
	query_metric: "metrics.query",
	metric_series: "metrics.series",
	list_organizations: "organizations.list",
};

/** Every internal admin tool must be reachable via run_sdk/query_sdk. */
const ADMIN_TOOL_SDK_NAMESPACE: Record<string, keyof ReturnType<typeof buildClientSDK>> = {
	manage_entity: "entities",
	manage_entity_schema: "entitySchema",
	manage_connections: "connections",
	manage_catalog: "catalog",
	manage_agents: "agents",
	manage_feeds: "feeds",
	manage_auth_profiles: "authProfiles",
	manage_operations: "operations",
	notify: "notifications",
	manage_schedules: "schedules",
	manage_watchers: "watchers",
	list_watchers: "watchers",
	get_watcher: "watchers",
	read_knowledge: "knowledge",
	manage_classifiers: "classifiers",
	manage_view_templates: "viewTemplates",
};

const testEnv = { ENVIRONMENT: "test" } as Env;
const testCtx: ToolContext = {
	organizationId: "test-org",
	userId: "test-user",
	memberRole: "owner",
	isAuthenticated: true,
	tokenType: "oauth",
	scopedToOrg: false,
	allowCrossOrg: true,
};

describe("tool registry split", () => {
	it("advertises the agent MCP surface via getMcpTools", () => {
		const names = getMcpTools().map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"query_sdk",
				"query_sql",
				"run_sdk",
				"save_memory",
				"search_memory",
				"search_sdk",
			].sort(),
		);
		expect(AGENT_TOOL_NAMES.size).toBe(6);
	});

	it("maps internal flat tools to ClientSDK methods for run_sdk/query_sdk parity", () => {
		const { namespaceMethods, topLevelMethods } = (() => {
			const sdk = buildClientSDK(testCtx, testEnv);
			const namespaceMethods: string[] = [];
			const topLevelMethods: string[] = [];
			for (const [name, value] of Object.entries(sdk)) {
				if (typeof value === "function") {
					topLevelMethods.push(name);
					continue;
				}
				if (!value || typeof value !== "object") continue;
				for (const method of Object.keys(value)) {
					namespaceMethods.push(`${name}.${method}`);
				}
			}
			return { namespaceMethods, topLevelMethods };
		})();
		const runtime = new Set([...namespaceMethods, ...topLevelMethods]);

		for (const [toolName, sdkPath] of Object.entries(INTERNAL_FLAT_TOOL_SDK_PATH)) {
			expect(getTool(toolName), `${toolName} must stay dispatchable`).toBeDefined();
			expect(isInternalDispatchTool(toolName), `${toolName} should be internal`).toBe(
				true,
			);
			expect(
				METHOD_METADATA[sdkPath],
				`${toolName} → ${sdkPath} missing METHOD_METADATA`,
			).toBeDefined();
			expect(runtime.has(sdkPath), `${sdkPath} not on ClientSDK`).toBe(true);
		}
	});

	it("maps agent flat tools to ClientSDK methods for run_sdk/query_sdk parity", () => {
		const { namespaceMethods, topLevelMethods } = (() => {
			const sdk = buildClientSDK(testCtx, testEnv);
			const namespaceMethods: string[] = [];
			const topLevelMethods: string[] = [];
			for (const [name, value] of Object.entries(sdk)) {
				if (typeof value === "function") {
					topLevelMethods.push(name);
					continue;
				}
				if (!value || typeof value !== "object") continue;
				for (const method of Object.keys(value)) {
					namespaceMethods.push(`${name}.${method}`);
				}
			}
			return { namespaceMethods, topLevelMethods };
		})();
		const runtime = new Set([...namespaceMethods, ...topLevelMethods]);

		for (const [toolName, sdkPath] of Object.entries(AGENT_FLAT_TOOL_SDK_PATH)) {
			expect(AGENT_TOOL_NAMES.has(toolName), `${toolName} should be an agent tool`).toBe(
				true,
			);
			expect(
				METHOD_METADATA[sdkPath],
				`${toolName} → ${sdkPath} missing METHOD_METADATA`,
			).toBeDefined();
			const [ns, method] = sdkPath.includes(".")
				? sdkPath.split(".")
				: [null, sdkPath];
			if (ns) {
				expect(namespaceMethods, `${toolName} → ${sdkPath}`).toContain(sdkPath);
			} else {
				expect(topLevelMethods, `${toolName} → ${sdkPath}`).toContain(method);
			}
			expect(runtime.has(sdkPath), `${sdkPath} not on ClientSDK`).toBe(true);
		}
	});

	it("maps every admin tool to a ClientSDK namespace for run_sdk coverage", () => {
		const sdk = buildClientSDK(testCtx, testEnv);
		for (const tool of ADMIN_TOOLS) {
			const ns = ADMIN_TOOL_SDK_NAMESPACE[tool.name];
			expect(ns, `${tool.name} missing SDK namespace mapping`).toBeDefined();
			expect(sdk[ns!], `${tool.name} → client.${String(ns)} not on ClientSDK`).toBeDefined();
		}
		expect(Object.keys(ADMIN_TOOL_SDK_NAMESPACE).sort()).toEqual(
			ADMIN_TOOLS.map((t) => t.name).sort(),
		);
	});

	it("keeps internal admin tools dispatchable and marks them internal on REST list", () => {
		expect(getTool("list_watchers")).toBeDefined();
		expect(getTool("manage_entity")).toBeDefined();
		expect(isInternalDispatchTool("list_watchers")).toBe(true);
		expect(isInternalDispatchTool("run_sdk")).toBe(false);

		const rest = getAllTools();
		expect(rest.length).toBeGreaterThan(getMcpTools().length);
		const internal = rest.filter((t) => "internal" in t && t.internal);
		expect(internal.map((t) => t.name)).toContain("manage_watchers");
		expect(internal.map((t) => t.name)).not.toContain("run_sdk");
	});
});