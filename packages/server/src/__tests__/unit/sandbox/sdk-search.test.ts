import { describe, expect, it } from "bun:test";
import type { ToolContext } from "../../../tools/registry";
import { sdkSearch } from "../../../tools/sdk_search";

const stubEnv = {} as never;

const readCtx: ToolContext = {
	organizationId: "org",
	userId: "user",
	memberRole: "member",
	isAuthenticated: true,
	tokenType: "oauth",
	scopes: ["mcp:read"],
	scopedToOrg: true,
	allowCrossOrg: false,
};

const writeCtx: ToolContext = {
	...readCtx,
	scopes: ["mcp:read", "mcp:write"],
};

const adminCtx: ToolContext = {
	...readCtx,
	memberRole: "owner",
	scopes: ["mcp:read", "mcp:write", "mcp:admin"],
};

describe("sdkSearch", () => {
	it("returns drill-down for an exact path", async () => {
		const result = await sdkSearch(
			{ query: "behaviors.list" },
			stubEnv,
			readCtx
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("behaviors.list");
		expect(result.results[0]).toContain("access:");
	});

	it("returns independent drill-downs for whitespace-separated method paths", async () => {
		const result = await sdkSearch(
			{ query: "entities.get entities.create entities.link" },
			stubEnv,
			writeCtx
		);

		expect(result.match_count).toBe(3);
		expect(result.results).toHaveLength(3);
		for (const path of ["entities.get", "entities.create", "entities.link"]) {
			const rendered = result.results.find((entry) => entry.startsWith(path));
			expect(rendered).toContain("access:");
			expect(rendered).toContain("example:");
		}
	});

	it("keeps exact and partial terms independent in one query", async () => {
		const result = await sdkSearch(
			{ query: "entities.get operations.execu" },
			stubEnv,
			writeCtx
		);

		expect(result.match_count).toBe(2);
		expect(result.results[0]).toContain("entities.get\n");
		expect(result.results[0]).toContain("access:");
		expect(result.results[1]).toStartWith("operations.execute —");
	});

	it("discovers top-level methods with the client prefix callers use", async () => {
		const result = await sdkSearch({ query: "client.org" }, stubEnv, readCtx);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("org");
		expect(result.results[0]).toContain("client.org('acme')");
	});

	it.each([
		[
			"operations.execute",
			"client.operations.execute({ connection_id: 42, operation_key: 'create_issue'",
		],
		[
			"entitySchema.listRules",
			"client.entitySchema.listRules({ slug: 'works-at' })",
		],
		[
			"entitySchema.deleteType",
			"client.entitySchema.deleteType({ slug: 'widget' })",
		],
		[
			"entitySchema.deleteRelType",
			"client.entitySchema.deleteRelType({ slug: 'works-at' })",
		],
		["feeds.trigger", "client.feeds.trigger({ feed_id: 42 })"],
		["feeds.delete", "client.feeds.delete({ feed_id: 42 })"],
		["classifiers.delete", "client.classifiers.delete({ classifier_id: 42 })"],
		["schedules.cancel", "client.schedules.cancel({ id: 'schedule-id' })"],
		["behaviors.get", "client.behaviors.get({ watcher_id: '42' })"],
		["behaviors.trigger", "client.behaviors.trigger({ watcher_id: '42' })"],
		["behaviors.delete", "client.behaviors.delete({ watcher_ids: ['42'] })"],
	])("renders the current %s signature in exact drill-down", async (path, snippet) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("example:");
		expect(result.results[0]).toContain(snippet);
	});

	it("documents the bounded ctx.sleep polling helper", async () => {
		const result = await sdkSearch(
			{ query: "ctx.sleep", mode: "read" },
			stubEnv,
			readCtx
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("ctx.sleep");
		expect(result.results[0]).toContain("30000");
		expect(result.results[0]).toContain("await ctx.sleep");
	});

	it("returns namespace listing for a top-level namespace at write tier", async () => {
		const result = await sdkSearch({ query: "behaviors" }, stubEnv, writeCtx);
		expect(result.match_count).toBeGreaterThan(2);
		const joined = result.results.join("\n");
		expect(joined).toContain("behaviors.list");
		expect(joined).toContain("behaviors.create");
	});

	it("read mode hides write methods from namespace listing", async () => {
		const result = await sdkSearch(
			{ query: "behaviors", mode: "read" },
			stubEnv,
			writeCtx
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("behaviors.list");
		expect(joined).not.toContain("behaviors.create");
		expect(result.notes).toContain("query_sdk-safe");
	});

	it("hides admin methods from write-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, writeCtx);
		expect(result.match_count).toBe(0);
		expect(result.notes).toContain("mcp:admin");
	});

	it("lists a camelCase namespace from a lowercased query without a false hidden note", async () => {
		// The hidden-namespace hint must never fire when the namespace's methods
		// ARE visible — 'entityschema' matches entitySchema.* case-insensitively.
		const result = await sdkSearch(
			{ query: "entityschema" },
			stubEnv,
			writeCtx
		);
		expect(result.match_count).toBeGreaterThan(0);
		const joined = result.results.join("\n");
		expect(joined).toContain("entitySchema.listTypes");
		expect(result.notes ?? "").not.toContain("none are visible");
	});

	it("names an admin-only namespace in read mode instead of a silent dead end", async () => {
		// Live failure: search_sdk query='agents' mode='read' returned unrelated
		// matches with no hint that agents.* exists behind run_sdk — the client
		// concluded the namespace does not exist.
		const result = await sdkSearch(
			{ query: "agents", mode: "read" },
			stubEnv,
			readCtx
		);
		expect(result.notes ?? "").toContain("agents.*");
		expect(result.notes ?? "").toContain("run_sdk");
	});

	it("shows admin methods to admin-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("agents.list");
	});

	it("substring-matches across paths and summaries", async () => {
		// "derive" appears in behaviors.create's summary (entity-type contract).
		// behaviors.create is admin-tier (matches manage_behaviors.create being
		// owner-admin), so only an admin-tier caller discovers it.
		const result = await sdkSearch({ query: "derive" }, stubEnv, adminCtx);
		expect(result.match_count).toBeGreaterThan(0);
	});

	it("preserves phrase matching for free-text queries", async () => {
		const result = await sdkSearch(
			{ query: "connector action" },
			stubEnv,
			writeCtx
		);

		// Phrase match on the method summary must still surface operations.execute.
		// When DATABASE_URL is available, live-connector hits may also match the
		// free-text query and prepend — so don't require match_count === 1.
		const methodHit = result.results.find((line) =>
			line.startsWith("operations.execute —")
		);
		expect(methodHit).toBeDefined();
		expect(methodHit).toContain("Execute a connector action");
	});

	it("recovers useful methods from natural multi-word queries", async () => {
		const result = await sdkSearch(
			{ query: "connections sync run", mode: "read" },
			stubEnv,
			readCtx
		);

		expect(result.match_count).toBeGreaterThan(0);
		expect(
			result.results.some((line) => line.startsWith("operations.listRuns —"))
		).toBe(true);
	});

	it("returns empty + helpful note for unknown queries", async () => {
		const result = await sdkSearch(
			{ query: "definitelyNotAMethod" },
			stubEnv,
			readCtx
		);
		expect(result.match_count).toBe(0);
		expect(result.notes).toBeDefined();
	});

	it("respects the limit parameter", async () => {
		const result = await sdkSearch(
			{ query: "behaviors", limit: 2 },
			stubEnv,
			writeCtx
		);
		expect(result.results.length).toBeLessThanOrEqual(2);
		expect(result.notes).toContain("more matches");
	});

	it("shows exact list signatures instead of implying uniform pagination", async () => {
		const paginated = await sdkSearch(
			{ query: "entities.list" },
			stubEnv,
			readCtx
		);
		expect(paginated.results[0]).toContain("limit?: number");

		const unpaginated = await sdkSearch(
			{ query: "metrics.list" },
			stubEnv,
			readCtx
		);
		expect(unpaginated.results[0]).toContain("not paginated");
	});

	it("shows object signatures for id-targeted methods", async () => {
		for (const path of [
			"entities.get",
			"feeds.get",
			"feeds.trigger",
			"classifiers.delete",
			"schedules.cancel",
			"behaviors.get",
			"behaviors.trigger",
		]) {
			const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
			expect(result.match_count, path).toBe(1);
			expect(result.results[0], path).toContain("client.");
			expect(result.results[0], path).toMatch(/\(\{/);
		}
	});

	it.each([
		[
			"operations.getRun",
			"operations.getRun(run_id: number)",
			"client.operations.getRun(123)",
		],
		[
			"connections.reauthenticate",
			"connections.reauthenticate(connection_id: number)",
			"client.connections.reauthenticate(42)",
		],
		[
			"authProfiles.get",
			"authProfiles.get(auth_profile_slug: string)",
			"client.authProfiles.get('google-calendar-account')",
		],
		["authProfiles.update", "reconnect?: boolean", "reconnect: true"],
	])("documents the exact %s call shape", async (path, signature, example) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain(signature);
		expect(result.results[0]).toContain(example);
	});
});
