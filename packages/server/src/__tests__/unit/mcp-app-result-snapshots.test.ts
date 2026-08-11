import { describe, expect, it } from "bun:test";
import {
	boundedMcpAppViewState,
	displaySafeMcpAppResult,
	normalizeMcpAppToolCallId,
} from "../../mcp-app-result-snapshots";

describe("MCP App result snapshot boundaries", () => {
	it("normalizes bounded JSON-RPC tool call ids", () => {
		expect(normalizeMcpAppToolCallId(42)).toBe("42");
		expect(normalizeMcpAppToolCallId("  call-42  ")).toBe("call-42");
		expect(normalizeMcpAppToolCallId("")).toBeNull();
		expect(normalizeMcpAppToolCallId("x".repeat(513))).toBeNull();
		expect(normalizeMcpAppToolCallId(null)).toBeNull();
	});

	it("makes restored approval cards display-only without dropping safe links", () => {
		expect(
			displaySafeMcpAppResult({
				version: 1,
				actions: [
					{ id: "approve", tool: "resolve_lobu_approval" },
					{ id: "reject", tool: "resolve_lobu_approval" },
					{ id: "review", href: "https://lobu.ai/runs/42" },
				],
			}),
		).toEqual({
			version: 1,
			actions: [{ id: "review", href: "https://lobu.ai/runs/42" }],
		});
	});

	it("preserves nested action records in generic tool results", () => {
		const result = {
			return_value: {
				actions: [
					{
						tool: "resolve_lobu_approval",
						status: "historical record",
					},
					{ tool: "safe", status: "kept" },
				],
			},
		};
		expect(displaySafeMcpAppResult(result)).toEqual(result);
	});

	it("accepts only bounded primitive UI state", () => {
		expect(
			boundedMcpAppViewState({
				"table.sql.page": 2,
				"details.raw.open": true,
				label: "kept",
				nested: { secret: "drop" },
				array: [1, 2, 3],
				tooLong: "x".repeat(501),
			}),
		).toEqual({
			"table.sql.page": 2,
			"details.raw.open": true,
			label: "kept",
		});
	});
});
