import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fixedActionArgs } from "../../../http/rest-tool-action";

describe("fixed-action REST arg composition", () => {
	it("does not let a caller param replace the route's action", () => {
		const args = fixedActionArgs("list", {
			action: "delete",
			connection_id: "5",
		});

		expect(args.action).toBe("list");
		expect(args.connection_id).toBe("5");
	});

	it("still forwards the caller's other params untouched", () => {
		const args = fixedActionArgs("list_available", {
			connector_key: "slack",
			limit: "10",
		});

		expect(args).toEqual({
			connector_key: "slack",
			limit: "10",
			action: "list_available",
		});
	});

	it("works with no caller params", () => {
		expect(fixedActionArgs("get")).toEqual({ action: "get" });
	});
});

/** Guard route registrations against bypassing the tested composition. */
describe("fixed-action REST route registrations", () => {
	const indexSrc = readFileSync(join(__dirname, "../../../index.ts"), "utf8");

	it("has no restToolProxy call that spreads caller params after an action", () => {
		const trailingSpread =
			/restToolProxy\([^)]*\{\s*action:\s*["'][a-z_]+["']\s*,\s*\.\.\./gs;
		const offenders = indexSrc.match(trailingSpread) ?? [];

		expect(offenders).toEqual([]);
	});

	it("routes every fixed-action REST wrapper through restToolAction", () => {
		// The generic passthrough POST is the one caller-selected tool/action route.
		const bareProxyCalls = indexSrc.match(/restToolProxy\(/g) ?? [];
		expect(bareProxyCalls).toHaveLength(1);

		expect(indexSrc.match(/restToolAction\(/g)).toHaveLength(4);
	});

	it("registers read-only proxy GETs from the declaration table", () => {
		expect(indexSrc).toContain("for (const route of REST_TOOL_GET_ROUTES)");
	});

	it("declares no GET proxy inline, so the public-read check cannot drift", () => {
		// A GET registered with a literal tool name is invisible to
		// `canAccessPublicOrgRestRoute`, which resolves routes through
		// `REST_TOOL_GET_ROUTES`. Such a route would silently keep the old
		// "200 via the tool door, 401 via REST" split.
		const inlineGetProxies = indexSrc
			.split(/\bapp\.get\(/)
			.slice(1)
			.map((chunk) => chunk.split(/\bapp\.(get|post|put|patch|delete|route)\(/)[0])
			.filter((chunk) => /restToolAction\(\s*c,\s*["']/.test(chunk));

		expect(inlineGetProxies).toEqual([]);
	});
});
