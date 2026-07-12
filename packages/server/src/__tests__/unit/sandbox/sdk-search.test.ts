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
			{ query: "watchers.list" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("watchers.list");
		expect(result.results[0]).toContain("access:");
	});

	it("returns independent drill-downs for whitespace-separated method paths", async () => {
		const result = await sdkSearch(
			{ query: "entities.get entities.delete entities.link" },
			stubEnv,
			writeCtx,
		);

		expect(result.match_count).toBe(3);
		expect(result.results).toHaveLength(3);
		for (const path of ["entities.get", "entities.delete", "entities.link"]) {
			const rendered = result.results.find((entry) => entry.startsWith(path));
			expect(rendered).toContain("access:");
			expect(rendered).toContain("example:");
		}
	});

	it("keeps exact and partial terms independent in one query", async () => {
		const result = await sdkSearch(
			{ query: "entities.get operations.execu" },
			stubEnv,
			writeCtx,
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
		["entitySchema.listRules", "client.entitySchema.listRules('employment')"],
		["entitySchema.deleteType", "client.entitySchema.deleteType('widget')"],
		[
			"entitySchema.deleteRelType",
			"client.entitySchema.deleteRelType('employment')",
		],
		["feeds.trigger", "client.feeds.trigger(42)"],
		["feeds.delete", "client.feeds.delete(42)"],
		["classifiers.delete", "client.classifiers.delete(42)"],
		["schedules.cancel", "client.schedules.cancel('"],
		["watchers.get", "client.watchers.get(42)"],
		["watchers.trigger", "client.watchers.trigger(42)"],
		["watchers.delete", "client.watchers.delete([42, 43])"],
	])("renders the current %s signature in exact drill-down", async (path, snippet) => {
		const result = await sdkSearch({ query: path }, stubEnv, adminCtx);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("example:");
		expect(result.results[0]).toContain(snippet);
	});

	it("returns namespace listing for a top-level namespace at write tier", async () => {
		const result = await sdkSearch({ query: "watchers" }, stubEnv, writeCtx);
		expect(result.match_count).toBeGreaterThan(2);
		const joined = result.results.join("\n");
		expect(joined).toContain("watchers.list");
		expect(joined).toContain("watchers.create");
	});

	it("read mode hides write methods from namespace listing", async () => {
		const result = await sdkSearch(
			{ query: "watchers", mode: "read" },
			stubEnv,
			writeCtx,
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("watchers.list");
		expect(joined).not.toContain("watchers.create");
		expect(result.notes).toContain("query_sdk-safe");
	});

	it("hides admin methods from write-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, writeCtx);
		expect(result.match_count).toBe(0);
		expect(result.notes).toContain("mcp:admin");
	});

	it("shows admin methods to admin-tier callers", async () => {
		const result = await sdkSearch({ query: "agents.list" }, stubEnv, adminCtx);
		expect(result.match_count).toBe(1);
		expect(result.results[0]).toContain("agents.list");
	});

	it("substring-matches across paths and summaries", async () => {
		const result = await sdkSearch({ query: "extraction" }, stubEnv, writeCtx);
		// "extraction" appears in watchers.create's summary (entity-type derive).
		expect(result.match_count).toBeGreaterThan(0);
	});

	it("preserves phrase matching for free-text queries", async () => {
		const result = await sdkSearch(
			{ query: "connector action" },
			stubEnv,
			writeCtx,
		);

		expect(result.match_count).toBe(1);
		expect(result.results[0]).toStartWith("operations.execute —");
	});

	it("returns empty + helpful note for unknown queries", async () => {
		const result = await sdkSearch(
			{ query: "definitelyNotAMethod" },
			stubEnv,
			readCtx,
		);
		expect(result.match_count).toBe(0);
		expect(result.notes).toBeDefined();
	});

	it("respects the limit parameter", async () => {
		const result = await sdkSearch(
			{ query: "watchers", limit: 2 },
			stubEnv,
			writeCtx,
		);
		expect(result.results.length).toBeLessThanOrEqual(2);
		expect(result.notes).toContain("more matches");
	});

	it("shows exact list signatures instead of implying uniform pagination", async () => {
		const paginated = await sdkSearch(
			{ query: "entities.list" },
			stubEnv,
			readCtx,
		);
		expect(paginated.results[0]).toContain("limit?: number");

		const unpaginated = await sdkSearch(
			{ query: "metrics.list" },
			stubEnv,
			readCtx,
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
			"watchers.get",
			"watchers.trigger",
		]) {
			const result = await sdkSearch({ query: path }, stubEnv, adminCtx);
			expect(result.match_count, path).toBe(1);
			expect(result.results[0], path).toContain("client.");
			expect(result.results[0], path).toMatch(/\(\{/);
		}
	});
});
