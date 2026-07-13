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

	it("resolves multiple dotted method names independently", async () => {
		const result = await sdkSearch(
			{ query: "entities.get entities.delete entities.link" },
			stubEnv,
			writeCtx,
		);
		const joined = result.results.join("\n");
		expect(joined).toContain("entities.get");
		expect(joined).toContain("entities.delete");
		expect(joined).toContain("entities.link");
	});

	it("explains restricted methods in a multi-method query", async () => {
		const result = await sdkSearch(
			{ query: "watchers.list agents.list" },
			stubEnv,
			writeCtx,
		);
		expect(result.results.join("\n")).toContain("watchers.list");
		expect(result.results.join("\n")).not.toContain("agents.list");
		expect(result.notes).toContain("agents.list requires workspace admin/owner");
	});

	it("explains write methods hidden from a multi-method read query", async () => {
		const result = await sdkSearch(
			{ query: "watchers.list watchers.create", mode: "read" },
			stubEnv,
			writeCtx,
		);
		expect(result.results.join("\n")).toContain("watchers.list");
		expect(result.results.join("\n")).not.toContain("watchers.create");
		expect(result.notes).toContain("watchers.create exists but requires run_sdk");
		expect(result.notes).toContain("Showing query_sdk-safe methods only");
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
});
