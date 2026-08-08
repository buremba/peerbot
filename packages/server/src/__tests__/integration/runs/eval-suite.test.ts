/**
 * The eval loop end to end: promote → run the suite → score → read the answer.
 *
 * This is the test that says whether the feature is USEFUL, not merely correct.
 * Scoring a run produces a number; what a person actually asks is "I changed
 * this Behavior — did I break it?" So the assertions here are about the answer:
 * that N trials stay N distinct runs rather than collapsing into one, that a
 * real drop is reported as a regression, and — the one that matters most — that
 * a wobble SMALLER than the case's own observed noise is NOT.
 *
 * That last one is the whole reason trials exist. Reporting a single-run dip as
 * a regression is exactly the mistake that made a provider quota storm read as
 * a 61–78% prompt regression.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { promoteEvalCase, trialCaseKey } from "../../../runs/eval-cases";
import { scoreEvalRun } from "../../../runs/eval-scores";
import { readEvalResults, runEvalSuite } from "../../../runs/eval-suite";
import { BEHAVIOR_RUN_TYPE } from "../../../runs/run-types";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const sql = getTestDb();

let organizationId: string;
let behaviorId: number;
let sourceRunId: number;

async function insertBehaviorRun(): Promise<number> {
	const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, watcher_id, approval_status, status,
      approved_input, completed_at, created_at
    ) VALUES (
      ${organizationId}, ${BEHAVIOR_RUN_TYPE}, ${behaviorId}, 'auto', 'completed',
      ${sql.json({
				watcher_id: behaviorId,
				agent_id: "11111111-2222-3333-4444-555555555555",
				window_start: "2026-08-01T00:00:00.000Z",
				window_end: "2026-08-01T01:00:00.000Z",
				dispatch_source: "scheduled",
			} as never)},
      current_timestamp, current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	return Number(run.id);
}

/**
 * Land a scored eval run for a given trial: drive the real capture shape
 * through the real scorer, so the case window is written the way production
 * writes it rather than by hand.
 */
async function landTrial(
	caseKey: string,
	trial: number,
	opts: { good: boolean },
): Promise<number> {
	const key = `behavior_eval:${sourceRunId}:${trialCaseKey(caseKey, trial)}`;
	const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, watcher_id, approval_status, status,
      dry_run_preview, idempotency_key, completed_at, created_at
    ) VALUES (
      ${organizationId}, 'behavior_eval', ${behaviorId}, 'auto', 'completed',
      ${sql.json(
				opts.good
					? { captured: "complete_window", extracted_data: { a: 1 } }
					: { captured: "complete_window", extracted_data: {} },
			)},
      ${key}, current_timestamp, current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	const runId = Number(run.id);
	const scored = await scoreEvalRun({ runId });
	expect(scored.ok).toBe(true);
	return runId;
}

beforeAll(async () => {
	await cleanupTestDatabase();

	const org = await createTestOrganization();
	organizationId = org.id;
	const creator = await createTestUser();
	await addUserToOrganization(creator.id, organizationId, "owner");

	const [behavior] = (await sql`
    WITH next_id AS (SELECT nextval('watchers_id_seq')::integer AS id)
    INSERT INTO watchers (
      id, watcher_group_id, organization_id, created_by, name, slug, schedule, status
    )
    SELECT id, id, ${organizationId}, ${creator.id}, 'Suite Behavior', 'suite-behavior', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	behaviorId = Number(behavior.id);
	sourceRunId = await insertBehaviorRun();
});

describe("runEvalSuite", () => {
	test("N trials stay N distinct runs instead of collapsing into one", async () => {
		// createEvalRun dedups on (sourceRunId, caseKey). Without trial-scoped keys
		// a 3-trial suite would queue ONE run and report a single measurement as
		// three — variance would look like zero and every wobble like a regression.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "trials",
			expectation: "lists the duplicates",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const suite = await runEvalSuite({
			organizationId,
			behaviorId,
			caseIds: [promoted.evalCase.entityId],
			trials: 3,
		});

		expect(suite.trials).toBe(3);
		expect(suite.cases).toHaveLength(1);
		expect(suite.cases[0].runIds).toHaveLength(3);
		expect(new Set(suite.cases[0].runIds).size).toBe(3);
		expect(suite.skipped).toEqual([]);
	});

	test("every trial resolves back to its case despite the suffixed key", async () => {
		// The trial suffix rides on the case key, which is also how the scorer
		// recovers the case. If minting and parsing ever drift, scores land
		// unanchored and the suite silently reports nothing — with no error.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "anchor",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		await landTrial("anchor", 0, { good: true });
		await landTrial("anchor", 2, { good: true });

		const [entity] = (await sql`
      SELECT metadata FROM entities WHERE id = ${promoted.evalCase.entityId}
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
		const scores = entity.metadata.recent_scores as Array<{ score: number }>;
		expect(scores).toHaveLength(2);
	});
});

describe("readEvalResults", () => {
	test("reports a real drop as a regression, and names the case", async () => {
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "regressed",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		// Baseline group: two clean runs. Then the "after my edit" group: two runs
		// that complete the window but extract nothing — a real quality drop.
		await landTrial("regressed", 0, { good: true });
		await landTrial("regressed", 1, { good: true });
		await landTrial("regressed", 2, { good: false });
		await landTrial("regressed", 3, { good: false });

		const results = await readEvalResults({
			organizationId,
			behaviorId,
			trials: 2,
		});
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row).toBeDefined();
		if (!row) return;

		expect(row.latest).toBe(0.5);
		expect(row.previous).toBe(1);
		expect(row.delta).toBe(-0.5);
		expect(row.spread).toBe(0);
		expect(results.summary.regressions).toContain(promoted.evalCase.entityId);
	});

	test("does NOT call a wobble smaller than its own noise a regression", async () => {
		// The load-bearing assertion. This case is genuinely flaky: its latest
		// group contains one good and one bad run, so it SAW a 1.0 spread. A
		// -0.25 move against that spread is noise, and calling it a regression is
		// the exact error that read a provider quota storm as a prompt failure.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "flaky",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		// previous group (landed first): both clean → mean 1.0
		await landTrial("flaky", 0, { good: true });
		await landTrial("flaky", 1, { good: true });
		// latest group: one clean, one empty → mean 0.75, spread 0.5
		await landTrial("flaky", 2, { good: true });
		await landTrial("flaky", 3, { good: false });

		const results = await readEvalResults({
			organizationId,
			behaviorId,
			trials: 2,
		});
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row).toBeDefined();
		if (!row) return;

		// A genuine DOWNWARD move — so `delta < 0` alone would flag it...
		expect(row.delta).toBe(-0.25);
		// ...but the case wobbled by 0.5 within the latest group by itself, so
		// -0.25 is inside its own noise and must NOT be called a regression.
		expect(row.spread).toBe(0.5);
		expect(results.summary.regressions).not.toContain(
			promoted.evalCase.entityId,
		);
	});

	test("a changed metric set between suites is not read as a regression", async () => {
		// A quality score is a pass fraction over the verdicts that happened to
		// run. If the judge is lost between suites, the same behavior scores
		// [pass,fail,judge-pass]=0.667 then [pass,fail]=0.5 — a denominator
		// change that must NOT read as a regression.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "metadrift",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const [entity] = (await sql`
      SELECT metadata FROM entities WHERE id = ${promoted.evalCase.entityId}
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
		// Newest-first, matching production: two recent trials scored WITH the
		// judge metric, two older ones scored without it.
		await sql`
      UPDATE entities
      SET metadata = ${sql.json({
				...entity.metadata,
				recent_scores: [
					{
						run_id: 9003,
						score: 0.5,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present", "judge_rubric"],
					},
					{
						run_id: 9004,
						score: 0.5,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present", "judge_rubric"],
					},
					{
						run_id: 9001,
						score: 1,
						at: "2026-07-31T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
					{
						run_id: 9002,
						score: 1,
						at: "2026-07-31T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
				],
			} as never)}
      WHERE id = ${promoted.evalCase.entityId}
    `;

		const results = await readEvalResults({
			organizationId,
			behaviorId,
			trials: 2,
		});
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row).toBeDefined();
		if (!row) return;

		// The numbers are real: 0.5 against 1.0. But the denominators differ, so
		// this is not a signal about the Behavior.
		expect(row.latest).toBe(0.5);
		expect(row.previous).toBe(1);
		expect(row.delta).toBeNull();
		expect(results.summary.regressions).not.toContain(
			promoted.evalCase.entityId,
		);
	});

	test("groups with an unknown metric set never compare — even to each other", async () => {
		// Pre-metrics rows (written before the `metrics` field existed) carry no
		// way to know what their score was a fraction of. Two such groups must
		// NOT be compared: `null === null` would silently treat unknown as equal
		// to unknown and read a real-looking delta out of nothing.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "unknown-set",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const [entity] = (await sql`
      SELECT metadata FROM entities WHERE id = ${promoted.evalCase.entityId}
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
		await sql`
      UPDATE entities
      SET metadata = ${sql.json({
				...entity.metadata,
				recent_scores: [
					{ run_id: 9011, score: 0.5, at: "2026-08-01T00:00:00.000Z" },
					{ run_id: 9012, score: 0.5, at: "2026-08-01T00:00:00.000Z" },
					{ run_id: 9013, score: 1, at: "2026-07-31T00:00:00.000Z" },
					{ run_id: 9014, score: 1, at: "2026-07-31T00:00:00.000Z" },
				],
			} as never)}
      WHERE id = ${promoted.evalCase.entityId}
    `;

		const results = await readEvalResults({
			organizationId,
			behaviorId,
			trials: 2,
		});
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row).toBeDefined();
		if (!row) return;

		expect(row.latest).toBe(0.5);
		expect(row.previous).toBe(1);
		expect(row.delta).toBeNull();
		expect(results.summary.regressions).not.toContain(
			promoted.evalCase.entityId,
		);
	});

	test("groups by the suite's own trial count, not the reader's guess", async () => {
		// A trials=5 suite writes 5 entries to the window. Read at the default 3,
		// positional grouping would take the newest 3 as "latest" and the next 2
		// as "previous" — one batch split across BOTH groups, comparing the batch
		// to itself and reading a false regression out of it. The stamp on the
		// case tells the reader the real batch size; `previous` must then be null
		// (there is no second batch yet), not a self-comparison.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "stamped-batch",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const [entity] = (await sql`
      SELECT metadata FROM entities WHERE id = ${promoted.evalCase.entityId}
    `) as unknown as Array<{ metadata: Record<string, unknown> }>;
		await sql`
      UPDATE entities
      SET metadata = ${sql.json({
				...entity.metadata,
				suite_trials: 5,
				recent_scores: [
					{
						run_id: 9021,
						score: 0.5,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
					{
						run_id: 9022,
						score: 0.5,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
					{
						run_id: 9023,
						score: 0.5,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
					{
						run_id: 9024,
						score: 1,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
					{
						run_id: 9025,
						score: 1,
						at: "2026-08-01T00:00:00.000Z",
						metrics: ["completed_window", "output_present"],
					},
				],
			} as never)}
      WHERE id = ${promoted.evalCase.entityId}
    `;

		// Deliberately the DEFAULT trials (3), the configuration that used to
		// split the 5-batch and report a regression.
		const results = await readEvalResults({ organizationId, behaviorId });
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row).toBeDefined();
		if (!row) return;

		expect(row.latestTrials).toBe(5);
		expect(row.latest).toBe(0.7);
		expect(row.previous).toBeNull();
		expect(row.delta).toBeNull();
		expect(results.summary.regressions).not.toContain(
			promoted.evalCase.entityId,
		);
	});

	test("a never-scored case reports null rather than zero", async () => {
		// A case with no runs yet must not read as "scored 0" — that would drag
		// the Behavior's summary down for work nobody has measured.
		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "unscored",
			expectation: "x",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const results = await readEvalResults({ organizationId, behaviorId });
		const row = results.cases.find(
			(c) => c.caseId === promoted.evalCase.entityId,
		);
		expect(row?.latest).toBeNull();
		expect(row?.delta).toBeNull();
		expect(results.summary.regressions).not.toContain(
			promoted.evalCase.entityId,
		);
	});
});
