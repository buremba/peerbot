import { describe, expect, test } from "bun:test";
import { SdkScriptResultSchema, toMcpPublicSdkScriptResult } from "../../tools/sdk_run";
import { validateToolResult } from "../../tools/validate-args";

describe("SDK MCP public result", () => {
	test("strips internal diagnostics while preserving the requested result and dry-run proposal", () => {
		const richInternal = {
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
});
