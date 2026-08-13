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

	test("summarizes change-capable calls a failed live run already dispatched", () => {
		// The renderer's warning depends on this crossing the boundary: the raw
		// sdk_call_trace never does, so a trace-derived warning would be invisible
		// to every MCP client.
		const result = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			error: { message: "TimeoutError: script exceeded 60000ms" },
			sdk_call_trace: [
				{ path: "entities.update", access: "write", skipped: false, args: [{ secret: "x" }] },
			],
			started_side_effects: [
				{ path: "entities.update", access: "write", count: 2 },
				{ path: "slack.postMessage", access: "external", count: 1 },
				{ path: "something.odd", access: "unknown", count: 3 },
			],
		}) as Record<string, unknown>;

		// Reads, skipped calls, and unknown-access calls are not evidence of change.
		expect(result.started_side_effects).toEqual([
			{ path: "entities.update", access: "write", count: 2 },
			{ path: "slack.postMessage", access: "external", count: 1 },
		]);
		expect(result.started_side_effects_truncated).toBeUndefined();
		// The diagnostic trace itself still never crosses, args included.
		expect(result.sdk_call_trace).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	test("still warns when trace eviction left only reads behind", () => {
		// traceBytes evicts OLDEST entries, so a long run's early writes vanish
		// from sdk_call_trace and the survivors can be entirely reads. Deriving
		// the summary from the trace would suppress the warning on exactly the
		// runs most likely to have timed out mid-write; the sandbox's dispatch
		// tally is the source of truth.
		const result = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			sdk_call_trace: [
				{ path: "entities.list", access: "read", skipped: false },
				{ path: "entities.get", access: "read", skipped: false },
			],
			sdk_call_trace_truncated: { dropped_entries: 880 },
			started_side_effects: [{ path: "entities.update", access: "write", count: 412 }],
		}) as Record<string, unknown>;

		expect(result.started_side_effects).toEqual([
			{ path: "entities.update", access: "write", count: 412 },
		]);
		expect(result.started_side_effects_truncated).toBe(true);
	});

	test("flags an undercount when the internal trace was byte-capped", () => {
		const result = toMcpPublicSdkScriptResult({
			success: false,
			skipped_calls: 0,
			side_effect_preview: [],
			dry_run: false,
			started_side_effects: [{ path: "events.create", access: "write", count: 1 }],
			sdk_call_trace_truncated: { dropped_entries: 412 },
		}) as Record<string, unknown>;

		expect(result.started_side_effects_truncated).toBe(true);
	});

	test("omits the summary for successful, dry-run, and read-only failures", () => {
		const base = {
			skipped_calls: 0,
			side_effect_preview: [],
			started_side_effects: [{ path: "entities.update", access: "write", count: 1 }],
		};
		// Succeeded: nothing to warn about.
		expect(
			(toMcpPublicSdkScriptResult({ ...base, success: true, dry_run: false }) as Record<
				string,
				unknown
			>).started_side_effects,
		).toBeUndefined();
		// Dry-run: the sandbox skipped the writes.
		expect(
			(toMcpPublicSdkScriptResult({ ...base, success: false, dry_run: true }) as Record<
				string,
				unknown
			>).started_side_effects,
		).toBeUndefined();
		// Failed, but only read.
		expect(
			(
				toMcpPublicSdkScriptResult({
					success: false,
					skipped_calls: 0,
					side_effect_preview: [],
					dry_run: false,
					started_side_effects: [],
				}) as Record<string, unknown>
			).started_side_effects,
		).toBeUndefined();
	});
});
