/**
 * Access-model cross-check (DB-free drift guard).
 *
 * The access tier of an action is declared in three independently-maintained
 * places with no compiler link between them:
 *   1. `tool-access.ts`     — the runtime tier map (`MEMBER_WRITE_ACTIONS` /
 *      `OWNER_ADMIN_ACTIONS` / `PUBLIC_READ_ACTIONS`), keyed by `manage_*` tool
 *      + action string. This is what `getRequiredAccessLevel` enforces on every
 *      direct tool call and SDK namespace method.
 *   2. `method-metadata.ts` — `METHOD_METADATA[<dotted path>].access`, the tier
 *      `search_sdk` / `sdkMethodVisible` use to decide what a caller may see and
 *      invoke through the SDK.
 *   3. `sdk_search.ts`      — `AGENTS_SDK_ACTION`, the `agents.*` → agent_config
 *      write-verb map that gates agent-principal visibility of the agents
 *      namespace.
 *
 * These must agree. A change to one that isn't mirrored in the others is a
 * silent authorization drift: a member could gain a write action the SDK still
 * advertises as read, or an SDK method could vanish from discovery while the
 * direct tool still accepts it. This test fails on that drift, mirroring the
 * existing `method-metadata.test.ts` guard.
 */

import { describe, expect, it } from "vitest";
import {
	MEMBER_WRITE_ACTIONS,
	OWNER_ADMIN_ACTIONS,
	PUBLIC_READ_ACTIONS,
	type ToolAccessLevel,
} from "../tool-access";
import { METHOD_METADATA } from "../../sandbox/method-metadata";
import { AGENTS_SDK_ACTION } from "../../tools/sdk_search";

/**
 * The `manage_*` tool the SDK namespace delegates to, per namespace prefix.
 * Only namespaces whose methods route through a single `manage_*` action tool
 * (so their METHOD_METADATA tier is enforceable via getRequiredAccessLevel) are
 * listed; discovery-only / bespoke namespaces (organizations, knowledge,
 * metrics, ctx, notifications) are intentionally omitted.
 */
const NAMESPACE_TOOL: Record<string, string> = {
	entities: "manage_entity",
	entitySchema: "manage_entity_schema",
	connections: "manage_connections",
	authProfiles: "manage_auth_profiles",
	feeds: "manage_feeds",
	operations: "manage_operations",
	watchers: "manage_watchers",
	classifiers: "manage_classifiers",
	viewTemplates: "manage_view_templates",
	catalog: "manage_catalog",
	agents: "manage_agents",
};

/**
 * The runtime tier the tool-access maps assign to a (tool, action), by their
 * enforcement precedence: owner-admin → member-write → public-read. Returns
 * null when the action isn't declared in any map (its tier then falls back to
 * a handler readOnly hint this static test can't reproduce).
 */
function declaredRuntimeTier(
	tool: string,
	action: string,
): ToolAccessLevel | null {
	if (OWNER_ADMIN_ACTIONS[tool]?.has(action)) return "admin";
	if (MEMBER_WRITE_ACTIONS[tool]?.has(action)) return "write";
	if (PUBLIC_READ_ACTIONS[tool]?.has(action)) return "read";
	return null;
}

describe("access-model cross-check", () => {
	it("no manage_* action is declared in conflicting tiers", () => {
		// The three tier maps partition actions: an action that is both
		// member-write and owner-admin (or public-read) is a contradiction —
		// getRequiredAccessLevel resolves it by precedence, but the duplicate is
		// almost always a copy-paste left behind when an action moved tiers.
		const seen = new Map<string, string>();
		const record = (tier: string, map: Record<string, Set<string> | null>) => {
			const conflicts: string[] = [];
			for (const [tool, actions] of Object.entries(map)) {
				if (actions === null) continue;
				for (const action of actions) {
					const key = `${tool}.${action}`;
					const prior = seen.get(key);
					if (prior) conflicts.push(`${key}: ${prior} + ${tier}`);
					else seen.set(key, tier);
				}
			}
			return conflicts;
		};
		const conflicts = [
			...record("member-write", MEMBER_WRITE_ACTIONS),
			...record("owner-admin", OWNER_ADMIN_ACTIONS),
			...record("public-read", PUBLIC_READ_ACTIONS),
		];
		expect(conflicts).toEqual([]);
	});

	it("no named SDK method is advertised to a lower tier than the tool enforces", () => {
		// For each METHOD_METADATA entry whose namespace routes to a manage_*
		// tool, the discovery tier `sdkMethodVisible` uses must not be MORE
		// permissive than the tier the tool-access maps enforce for that
		// (tool, action). A member who sees a method in search_sdk, calls it, and
		// hits an admin-only error is the drift this guards.
		//
		// `external` is exempt from the exact-match requirement: it is a
		// side-effect marker (this method calls out to an external system), not a
		// pure tier. `sdkMethodVisible` treats it as write-visible, and the
		// project deliberately keeps external methods write-visible even when the
		// underlying tool action is admin-enforced (see method-metadata.test.ts:
		// operations.execute / feeds.trigger / connections.test stay "external"
		// while their trigger_feed / execute / test actions are owner-admin). So
		// `external` only asserts "not read-tier" — never that it equals admin.
		const RANK: Record<string, number> = { read: 0, write: 1, admin: 2 };
		const mismatches: string[] = [];
		for (const [path, meta] of Object.entries(METHOD_METADATA)) {
			const [namespace, method] = path.split(".");
			const tool = NAMESPACE_TOOL[namespace];
			if (!tool || !method) continue;
			// `.manage` is the raw action-passthrough wrapper — it carries the
			// namespace's most-privileged tier, not a single action, so it has no
			// single tool-action to compare against.
			if (method === "manage") continue;
			// SDK method names are camelCase; tool action strings are snake_case.
			const action = method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
			const runtimeTier = declaredRuntimeTier(tool, action);
			// Only assert when the action is actually declared in a tier map;
			// unlisted actions fall back to a handler readOnly hint this static
			// test can't reproduce.
			if (runtimeTier === null) continue;
			if (meta.access === "external") {
				// External is write-visible; it must at least be enforced at
				// write-or-admin (never a read action masquerading as external).
				if (runtimeTier === "read") {
					mismatches.push(
						`${path}: SDK=external but runtime(${tool}.${action})=read`,
					);
				}
				continue;
			}
			// read / write / admin must match the enforced tier exactly.
			if (RANK[meta.access] !== RANK[runtimeTier]) {
				mismatches.push(
					`${path}: SDK=${meta.access} runtime(${tool}.${action})=${runtimeTier}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("the agents.* triple agrees (AGENTS_SDK_ACTION ↔ METHOD_METADATA ↔ manage_agents)", () => {
		// AGENTS_SDK_ACTION enumerates the agents.* SDK paths gated by
		// agent_config policy. Every such path must also have METHOD_METADATA,
		// and (excluding the raw `.manage` passthrough) map to a manage_agents
		// action declared owner-admin — agents administration is admin-tier.
		const managedAgentActions = OWNER_ADMIN_ACTIONS.manage_agents;
		expect(managedAgentActions).toBeDefined();

		for (const path of Object.keys(AGENTS_SDK_ACTION)) {
			expect(METHOD_METADATA, `${path} missing METHOD_METADATA`).toHaveProperty(
				path,
			);
			// Every agents.* SDK method is admin-tier in metadata.
			expect(
				METHOD_METADATA[path]?.access,
				`${path} should be admin in METHOD_METADATA`,
			).toBe("admin");

			const method = path.split(".")[1];
			if (method === "manage") continue;
			const action = method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
			expect(
				managedAgentActions?.has(action),
				`agents.${method} → manage_agents.${action} must be owner-admin`,
			).toBe(true);
		}
	});
});
