/**
 * The judge-reply parser — the only metric path with no coverage until this
 * file existed.
 *
 * The judge's reply is the one place a model's output turns into a number that
 * can move an Automation's regression verdict. The parser is deliberately strict:
 * an unusable reply returns null (the metric is SKIPPED, never scored 0), so a
 * misbehaving judge must not punish the Automation. These tests pin that
 * contract — fence stripping, range checks, the derive-from-score default, and
 * the hard null on anything not a verdict.
 *
 * Pure function, so no Postgres.
 */

import { describe, expect, test } from "bun:test";
import { parseJudgeVerdict } from "../../runs/eval-scores";

describe("parseJudgeVerdict", () => {
	test("parses a bare JSON verdict", () => {
		const v = parseJudgeVerdict(
			'{"score": 0.8, "passed": true, "reasoning": "met the expectation"}',
		);
		expect(v).toEqual({
			score: 0.8,
			passed: true,
			reasoning: "met the expectation",
		});
	});

	test("strips a ```json fence — models fence often enough to be worth one line", () => {
		const v = parseJudgeVerdict(
			'```json\n{"score": 0.5, "passed": false, "reasoning": "close but missed"}\n```',
		);
		expect(v).toEqual({
			score: 0.5,
			passed: false,
			reasoning: "close but missed",
		});
	});

	test("derives `passed` from score >= 0.5 when it is unstated", () => {
		// An unstated verdict is not a passing one by default — but a low score
		// with no explicit boolean must not flip into a pass either.
		expect(parseJudgeVerdict('{"score": 0.6, "reasoning": "ok"}')?.passed).toBe(
			true,
		);
		expect(parseJudgeVerdict('{"score": 0.5, "reasoning": "borderline"}')?.passed).toBe(
			true,
		);
		expect(parseJudgeVerdict('{"score": 0.49, "reasoning": "no"}')?.passed).toBe(
			false,
		);
	});

	test("trusts an explicit boolean over the score", () => {
		expect(
			parseJudgeVerdict(
				'{"score": 0.9, "passed": false, "reasoning": "confident but wrong"}',
			)?.passed,
		).toBe(false);
	});

	test("rejects a score outside 0.0–1.0", () => {
		expect(parseJudgeVerdict('{"score": 1.5, "passed": true}')).toBeNull();
		expect(parseJudgeVerdict('{"score": -0.1, "passed": true}')).toBeNull();
	});

	test("rejects a non-numeric score", () => {
		expect(parseJudgeVerdict('{"score": "0.8", "passed": true}')).toBeNull();
		expect(parseJudgeVerdict('{"score": null, "passed": true}')).toBeNull();
		expect(parseJudgeVerdict('{"passed": true}')).toBeNull();
	});

	test("returns null on a non-JSON reply", () => {
		expect(parseJudgeVerdict("the output meets the expectation")).toBeNull();
		expect(parseJudgeVerdict("")).toBeNull();
	});

	test("returns null when braces never close", () => {
		expect(parseJudgeVerdict('{"score": 0.8')).toBeNull();
	});

	test("caps reasoning length", () => {
		const long = "x".repeat(5_000);
		const v = parseJudgeVerdict(`{"score": 1, "passed": true, "reasoning": "${long}"}`);
		expect(v?.reasoning.length).toBe(2_000);
	});
});
