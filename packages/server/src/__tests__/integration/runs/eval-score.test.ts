/**
 * Scoring a terminal eval replay.
 *
 * The load-bearing claims: an eval run that never called `complete_window` is
 * scored as a FAILURE rather than skipped (that protocol violation is the
 * largest real agent-error class in prod, so refusing to score it would hide
 * exactly the runs worth measuring); the quality stamp is materialized onto the
 * Automation row at write time; scoring is idempotent per (run, metric); and a
 * live `automation` run can never be scored as if it were an eval.
 *
 * The judge is deliberately untested here — it needs a live provider, and the
 * unit-level contract that matters (an unaskable judge produces NO verdict
 * rather than a zero) is asserted through the metric COUNT: an org with no
 * provider yields exactly the two code metrics.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { promoteEvalCase } from "../../../runs/eval-cases";
import { createEvalRun } from "../../../runs/eval-runs";
import {
	EVAL_SCORE_IDENTITY_NS,
	scoreEvalRun,
} from "../../../runs/eval-scores";
import {
	AUTOMATION_EVAL_RUN_TYPE,
	AUTOMATION_RUN_TYPE,
} from "../../../runs/run-types";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const sql = getTestDb();

let organizationId: string;
let automationId: number;

async function insertRun(params: {
	runType: string;
	status?: string;
	preview?: Record<string, unknown> | null;
	idempotencyKey?: string | null;
}): Promise<number> {
	const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, automation_id, approval_status, status,
      dry_run_preview, idempotency_key, completed_at, created_at
    ) VALUES (
      ${organizationId}, ${params.runType}, ${automationId}, 'auto',
      ${params.status ?? "completed"},
      ${params.preview ? sql.json(params.preview as never) : null},
      ${params.idempotencyKey ?? null},
      current_timestamp, current_timestamp
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	return Number(run.id);
}

/** The score events currently live for a run, keyed by metric. */
async function liveScores(
	runId: number,
): Promise<Record<string, { score: number; passed: boolean }>> {
	const rows = (await sql`
    SELECT identity_key, payload_data
    FROM events
    WHERE organization_id = ${organizationId}
      AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
      AND identity_key LIKE ${`${runId}:%`}
      AND superseded_by IS NULL
  `) as unknown as Array<{
		identity_key: string;
		payload_data: { metric: string; score: number; passed: boolean };
	}>;
	const out: Record<string, { score: number; passed: boolean }> = {};
	for (const row of rows) {
		out[row.payload_data.metric] = {
			score: Number(row.payload_data.score),
			passed: row.payload_data.passed,
		};
	}
	return out;
}

beforeAll(async () => {
	await cleanupTestDatabase();

	const org = await createTestOrganization();
	organizationId = org.id;
	const creator = await createTestUser();
	// events.created_by is NOT NULL and resolveEntityCreator falls back to an
	// org owner/admin — without a membership row nothing can be scored at all.
	await addUserToOrganization(creator.id, organizationId, "owner");

	const [automation] = (await sql`
    WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
    INSERT INTO automations (
      id, automation_group_id, organization_id, created_by, name, slug, schedule, status
    )
    SELECT id, id, ${organizationId}, ${creator.id}, 'Scored Automation', 'scored-automation', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	automationId = Number(automation.id);
});

describe("scoreEvalRun", () => {
	test("a completed capture passes both code metrics and stamps the Automation", async () => {
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			preview: {
				captured: "complete_window",
				extracted_data: { groups: ["a", "b"] },
				content_linked: 2,
			},
		});

		const result = await scoreEvalRun({ runId });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Exactly the two CODE metrics: no case, so no expectation, so the judge
		// is never asked — and an unasked judge contributes no verdict at all.
		expect(result.verdicts.map((v) => v.metric).sort()).toEqual([
			"completed_window",
			"output_present",
		]);
		expect(result.qualityScore).toBe(1);

		const scores = await liveScores(runId);
		expect(scores.completed_window.passed).toBe(true);
		expect(scores.output_present.passed).toBe(true);

		const [stamp] = (await sql`
      SELECT latest_eval_score, latest_eval_run_id, latest_eval_at
      FROM automations WHERE id = ${automationId}
    `) as unknown as Array<{
			latest_eval_score: string | number;
			latest_eval_run_id: number;
			latest_eval_at: Date | null;
		}>;
		// Materialized at WRITE time — the listing reads this back, it never
		// aggregates the events above.
		expect(Number(stamp.latest_eval_score)).toBe(1);
		expect(Number(stamp.latest_eval_run_id)).toBe(runId);
		expect(stamp.latest_eval_at).not.toBeNull();
	});

	test("a run that never called complete_window is SCORED as a failure, not skipped", async () => {
		// The prod-dominant defect: the agent ran, produced something, and stopped
		// without completing its window. Skipping it would erase the single
		// largest agent-error class from every quality number.
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			preview: { side_effects: [{ tool: "notify.send" }] },
		});

		const result = await scoreEvalRun({ runId });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const scores = await liveScores(runId);
		expect(scores.completed_window.passed).toBe(false);
		expect(scores.output_present.passed).toBe(false);
		expect(result.qualityScore).toBe(0);
	});

	test("completing a window with EMPTY output is a protocol pass and a quality fail", async () => {
		// The two code metrics must stay separate: collapsing them would hide the
		// agent that dutifully completes its window having extracted nothing.
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			preview: {
				captured: "complete_window",
				extracted_data: {},
				content_linked: 0,
			},
		});

		const result = await scoreEvalRun({ runId });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const scores = await liveScores(runId);
		expect(scores.completed_window.passed).toBe(true);
		expect(scores.output_present.passed).toBe(false);
		expect(result.qualityScore).toBe(0.5);
	});

	test("rescoring supersedes rather than forking — one live verdict per metric", async () => {
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			preview: { captured: "complete_window", extracted_data: { a: 1 } },
		});

		await scoreEvalRun({ runId });
		await scoreEvalRun({ runId });

		const [row] = (await sql`
      SELECT count(*)::int AS live
      FROM events
      WHERE organization_id = ${organizationId}
        AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
        AND identity_key = ${`${runId}:completed_window`}
        AND superseded_by IS NULL
    `) as unknown as Array<{ live: number }>;
		expect(row.live).toBe(1);

		// And exactly one chain ROOT — the shape the unique index guarantees.
		const [roots] = (await sql`
      SELECT count(*)::int AS n
      FROM events
      WHERE organization_id = ${organizationId}
        AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
        AND identity_key = ${`${runId}:completed_window`}
        AND supersedes_event_id IS NULL
    `) as unknown as Array<{ n: number }>;
		expect(roots.n).toBe(1);
	});

	test("refuses a live Automation run — production quality is never stamped from one", async () => {
		const runId = await insertRun({
			runType: AUTOMATION_RUN_TYPE,
			preview: { captured: "complete_window", extracted_data: { a: 1 } },
		});

		const result = await scoreEvalRun({ runId });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not_an_eval_run");
		expect(await liveScores(runId)).toEqual({});
	});

	test("refuses a run that has not gone terminal", async () => {
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			status: "running",
			preview: { captured: "complete_window" },
		});

		const result = await scoreEvalRun({ runId });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("not_terminal");
	});

	test("anchors scores to the promoted case, and asks no judge it cannot ask", async () => {
		// The case join has no column behind it: `createEvalRun` stamps
		// `idempotency_key = 'automation_eval:<sourceRunId>:<caseKey>'` and
		// `promoteEvalCase` claims `entity_identities` under
		// '<sourceRunId>:<caseKey>'. The suffix of the one IS the other. Assert it,
		// because a silent mismatch would strand every score unanchored and the
		// metrics layer would show an empty case suite with no error anywhere.
		const [sourceRun] = (await sql`
      INSERT INTO runs (
        organization_id, run_type, automation_id, approval_status, status,
        approved_input, completed_at, created_at
      ) VALUES (
        ${organizationId}, ${AUTOMATION_RUN_TYPE}, ${automationId}, 'auto', 'completed',
        ${sql.json({
					automation_id: automationId,
					agent_id: "11111111-2222-3333-4444-555555555555",
					window_start: "2026-08-01T00:00:00.000Z",
					window_end: "2026-08-01T01:00:00.000Z",
					dispatch_source: "scheduled",
				} as never)},
        current_timestamp, current_timestamp
      )
      RETURNING id
    `) as unknown as Array<{ id: number }>;
		const sourceRunId = Number(sourceRun.id);

		const promoted = await promoteEvalCase({
			sourceRunId,
			caseKey: "anchored",
			expectation: "names the duplicate groups",
		});
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;

		const minted = await createEvalRun({ sourceRunId, caseKey: "anchored" });
		expect(minted).not.toBeNull();
		if (!minted) return;

		// The eval run has to be terminal with a capture record to be scoreable.
		await sql`
      UPDATE runs
      SET status = 'completed', completed_at = current_timestamp,
          dry_run_preview = ${sql.json({
						captured: "complete_window",
						extracted_data: { groups: ["a"] },
					} as never)}
      WHERE id = ${minted.runId}
    `;

		const result = await scoreEvalRun({ runId: minted.runId });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.caseEntityId).toBe(promoted.evalCase.entityId);

		// The case HAS an expectation, so the judge was attempted — and this test
		// org has no inference provider, so it could not be asked. The contract is
		// that an unaskable judge yields NO verdict rather than a zero: a failed
		// judge must never be recorded as a failing Automation.
		expect(result.verdicts.map((v) => v.metric)).not.toContain("judge_rubric");
		expect(result.qualityScore).toBe(1);

		// Anchored to the case entity, which is what makes the declared-metrics
		// alias join resolve.
		// `array_to_string`, not the raw column: the client runs with
		// `fetch_types: false`, so a bigint[] comes back as the Postgres array
		// LITERAL ("{123}") rather than a JS array.
		const rows = (await sql`
      SELECT array_to_string(entity_ids, ',') AS ids FROM events
      WHERE organization_id = ${organizationId}
        AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
        AND identity_key = ${`${minted.runId}:completed_window`}
        AND superseded_by IS NULL
    `) as unknown as Array<{ ids: string | null }>;
		expect(rows[0].ids).toBe(String(promoted.evalCase.entityId));
	});

	test("score events are structurally excluded from embedding, search and feeds", async () => {
		// Not a style preference: NULL payload_text is what keeps these rows out
		// of embed-backfill discovery, and a NULL feed_id is what keeps them out
		// of every feed-scoped read. Breaking that rule here
		// would silently push eval bookkeeping into users' search results.
		const runId = await insertRun({
			runType: AUTOMATION_EVAL_RUN_TYPE,
			preview: { captured: "complete_window", extracted_data: { a: 1 } },
		});
		await scoreEvalRun({ runId });

		const rows = (await sql`
      SELECT payload_text, feed_id
      FROM events
      WHERE organization_id = ${organizationId}
        AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
        AND identity_key LIKE ${`${runId}:%`}
    `) as unknown as Array<{
			payload_text: string | null;
			feed_id: number | null;
		}>;

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.payload_text).toBeNull();
			expect(row.feed_id).toBeNull();
		}
	});
});
