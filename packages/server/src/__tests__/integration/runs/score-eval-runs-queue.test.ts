/**
 * The scorer queue itself.
 *
 * The claim under test is that the anti-join predicate IS the queue: a run
 * leaves it only once its score events exist, which is a committed fact every
 * replica can see. So the properties that matter are (a) unscored terminal eval
 * runs are picked up, (b) already-scored ones are not picked up again — that is
 * what stops a second pod re-judging and re-billing the same run — and (c) a run
 * inside the settle window is left alone, because `dry_run_preview` is merged by
 * several capture sites and reading it too early scores a complete run as an
 * incomplete one.
 */

import { beforeAll, describe, expect, test } from "vitest";
import {
	BEHAVIOR_EVAL_RUN_TYPE,
	BEHAVIOR_RUN_TYPE,
} from "../../../runs/run-types";
import { runScoreEvalRuns } from "../../../scheduled/score-eval-runs";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const sql = getTestDb();

let organizationId: string;
let behaviorId: number;

/**
 * `agedSeconds` backdates `completed_at`. The settle window is 60s, so a run
 * created "now" is deliberately NOT claimable — which is what the settle test
 * asserts.
 */
async function insertRun(params: {
	runType: string;
	agedSeconds: number;
	status?: string;
}): Promise<number> {
	const [run] = (await sql`
    INSERT INTO runs (
      organization_id, run_type, watcher_id, approval_status, status,
      dry_run_preview, completed_at, created_at
    ) VALUES (
      ${organizationId}, ${params.runType}, ${behaviorId}, 'auto',
      ${params.status ?? "completed"},
      ${sql.json({ captured: "complete_window", extracted_data: { a: 1 } } as never)},
      now() - ${`${params.agedSeconds} seconds`}::interval,
      now() - ${`${params.agedSeconds} seconds`}::interval
    )
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	return Number(run.id);
}

async function scoreCount(runId: number): Promise<number> {
	const [row] = (await sql`
    SELECT count(*)::int AS n FROM events
    WHERE organization_id = ${organizationId}
      AND identity_ns = 'eval_score'
      AND identity_key LIKE ${`${runId}:%`}
      AND superseded_by IS NULL
  `) as unknown as Array<{ n: number }>;
	return row.n;
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
    SELECT id, id, ${organizationId}, ${creator.id}, 'Queue Behavior', 'queue-behavior', '0 * * * *', 'active'
    FROM next_id
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	behaviorId = Number(behavior.id);
});

describe("runScoreEvalRuns", () => {
	test("scores a settled eval run, then never claims it again", async () => {
		const runId = await insertRun({
			runType: BEHAVIOR_EVAL_RUN_TYPE,
			agedSeconds: 600,
		});

		const first = await runScoreEvalRuns();
		expect(first.claimed).toBe(1);
		expect(first.scored).toBe(1);
		expect(await scoreCount(runId)).toBe(2);

		// The second tick is the multi-replica case in miniature: the run is out
		// of the queue because its score events exist, not because this process
		// remembers scoring it. A claim here would mean a second pod re-judges
		// and re-bills every run on every tick.
		const second = await runScoreEvalRuns();
		expect(second.claimed).toBe(0);
		expect(await scoreCount(runId)).toBe(2);
	});

	test("leaves a run inside the settle window alone", async () => {
		const runId = await insertRun({
			runType: BEHAVIOR_EVAL_RUN_TYPE,
			agedSeconds: 0,
		});

		const summary = await runScoreEvalRuns();
		expect(summary.claimed).toBe(0);
		expect(await scoreCount(runId)).toBe(0);
	});

	test("never claims a live Behavior run or a non-terminal one", async () => {
		const liveRunId = await insertRun({
			runType: BEHAVIOR_RUN_TYPE,
			agedSeconds: 600,
		});
		const runningRunId = await insertRun({
			runType: BEHAVIOR_EVAL_RUN_TYPE,
			agedSeconds: 600,
			status: "running",
		});

		const summary = await runScoreEvalRuns();
		expect(summary.claimed).toBe(0);
		expect(await scoreCount(liveRunId)).toBe(0);
		expect(await scoreCount(runningRunId)).toBe(0);
	});
});
