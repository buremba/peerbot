/**
 * The run-key ↔ case-identifier round trip.
 *
 * This pair is the ONLY join between a scored eval run and the case it
 * measures — there is no column behind it. `createEvalRun` stamps
 * `idempotency_key = 'automation_eval:<sourceRunId>:<caseKey>'`, `promoteEvalCase`
 * claims `entity_identities` under '<sourceRunId>:<caseKey>', and the scorer
 * recovers one from the other. When they drift nothing throws: scores land
 * unanchored, the suite reports an empty case, and no error appears anywhere.
 *
 * Pure string functions, so no Postgres.
 */

import { describe, expect, test } from "bun:test";
import {
	evalCaseIdentifierFromRunKey,
	trialCaseKey,
} from "../../runs/eval-cases";

const key = (sourceRunId: number, caseKey: string) =>
	`automation_eval:${sourceRunId}:${caseKey}`;

describe("trialCaseKey", () => {
	test("trial 0 keeps the bare key", () => {
		// So a plain replay and trial 0 of a suite are the same work item, and
		// every case promoted before trials existed keeps resolving.
		expect(trialCaseKey("weekly", 0)).toBe("weekly");
	});

	test("later trials are distinct, or N trials collapse into one run", () => {
		const keys = [0, 1, 2].map((t) => trialCaseKey("weekly", t));
		expect(new Set(keys).size).toBe(3);
	});
});

describe("evalCaseIdentifierFromRunKey", () => {
	test("every trial of a case resolves to the same identifier", () => {
		const identifiers = [0, 1, 2].map((t) =>
			evalCaseIdentifierFromRunKey(key(41, trialCaseKey("weekly", t))),
		);
		expect(identifiers).toEqual(["41:weekly", "41:weekly", "41:weekly"]);
	});

	test("a case key containing '#' is NOT truncated", () => {
		// `caseKey` is caller-supplied free text. Stripping at the last '#' rather
		// than at the minted `#t<n>` suffix would rewrite this case's own key to
		// '41:weekly', which matches no promoted case — so every score for it
		// would silently land unanchored.
		expect(evalCaseIdentifierFromRunKey(key(41, "weekly#draft"))).toBe(
			"41:weekly#draft",
		);
		expect(
			evalCaseIdentifierFromRunKey(key(41, trialCaseKey("weekly#draft", 2))),
		).toBe("41:weekly#draft");
	});

	test("a '#t' that is not a trial suffix survives", () => {
		expect(evalCaseIdentifierFromRunKey(key(41, "weekly#tuesday"))).toBe(
			"41:weekly#tuesday",
		);
	});

	test("rejects a key that is not an eval run's", () => {
		// Guards against scoring anchoring itself to a live Automation run's key.
		expect(evalCaseIdentifierFromRunKey("automation:41:weekly")).toBeNull();
		expect(evalCaseIdentifierFromRunKey("automation_eval:")).toBeNull();
		expect(evalCaseIdentifierFromRunKey(null)).toBeNull();
	});
});
