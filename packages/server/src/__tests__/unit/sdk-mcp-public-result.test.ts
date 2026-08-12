import { describe, expect, test } from "bun:test";
import { SdkScriptResultSchema, toMcpPublicSdkScriptResult } from "../../tools/sdk_run";
import { validateToolResult } from "../../tools/validate-args";

describe("SDK MCP public result", () => {
	test("strips internal diagnostics while preserving the requested result and dry-run proposal", () => {
		const richInternal = {
			title: "  Company pipeline  ",
			success: false,
			return_value: { answer: 42 },
			logs: [{ level: "warn", message: "private diagnostic", ts: 123 }],
			error: {
				name: "TypeError",
				message: "boom",
				details: { request_id: "internal-123" },
				stack: "secret stack",
				line: 3,
				column: 7,
				code: "VALIDATION",
				retryable: false,
			},
			duration_ms: 42,
			sdk_calls: 3,
			skipped_calls: 1,
			sdk_call_trace: [
				{
					path: "entities.list",
					orgPath: ["private-org"],
					access: "read",
					args: [{}],
					skipped: false,
				},
			],
			side_effect_preview: [
				{
					path: "entities.create",
					orgPath: ["private-org"],
					access: "write",
					args: [{ name: "A" }],
					skipped: true,
				},
			],
			dry_run: true,
		};

		const publicResult = toMcpPublicSdkScriptResult(richInternal) as Record<string, unknown>;

		expect(validateToolResult(SdkScriptResultSchema, publicResult)).not.toBeNull();
		expect(publicResult.title).toBe("Company pipeline");
		expect(publicResult.success).toBe(false);
		expect(publicResult.dry_run).toBe(true);
		expect(publicResult.skipped_calls).toBe(1);
		expect(publicResult.return_value).toEqual({ answer: 42 });
		expect(publicResult.side_effect_preview).toEqual([
			{ path: "entities.create", access: "write", args: [{ name: "A" }] },
		]);
		expect(publicResult.error).toEqual({
			name: "TypeError",
			message: "boom",
			code: "VALIDATION",
			retryable: false,
		});

		const serialized = JSON.stringify(publicResult);
		for (const forbidden of [
			"private diagnostic",
			"internal-123",
			"secret stack",
			"private-org",
			"duration_ms",
			"sdk_call_trace",
		]) {
			expect(serialized).not.toContain(forbidden);
		}
	});

	test("does not advertise diagnostic-only fields in the public schema", () => {
		const schema = JSON.stringify(SdkScriptResultSchema);
		for (const forbidden of [
			'"logs"',
			'"ts"',
			'"stack"',
			'"details"',
			'"duration_ms"',
			'"sdk_calls"',
			'"sdk_call_trace"',
			'"orgPath"',
		]) {
			expect(schema).not.toContain(forbidden);
		}
	});

	test("normalizes the bounded dry-run preview contract", () => {
		const publicResult = toMcpPublicSdkScriptResult({
			success: true,
			skipped_calls: 3,
			side_effect_preview: [
				{ path: "entities.create", access: "mystery", args: [] },
				{ path: 42, args: [] },
			],
			return_value_preview: "head",
			return_truncated: { total_bytes: 10, kept_bytes: 4 },
			dry_run: true,
		}) as Record<string, unknown>;

		expect(validateToolResult(SdkScriptResultSchema, publicResult)).not.toBeNull();
		expect(publicResult.side_effect_preview).toEqual([
			{ path: "entities.create", access: "unknown", args: [] },
		]);
		expect(publicResult.side_effect_preview_truncated).toEqual({ dropped_entries: 2 });
		expect(publicResult.return_value_preview).toBe("head");
		expect(publicResult.return_truncated).toEqual({ total_bytes: 10, kept_bytes: 4 });
	});

	test("preserves a caller-supplied title and drops blank titles", () => {
		expect(
			(
				toMcpPublicSdkScriptResult({
					title: "Pipeline",
					success: true,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
				}) as Record<string, unknown>
			).title,
		).toBe("Pipeline");
		expect(
			(
				toMcpPublicSdkScriptResult({
					title: "   ",
					success: true,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
				}) as Record<string, unknown>
			).title,
		).toBeUndefined();
	});
});
