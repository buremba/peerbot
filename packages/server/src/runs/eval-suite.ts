/**
 * Running an Automation's eval suite and reading the answer (evals PR 4, lobu#2564).
 *
 * Scoring one replay produces a number. This module is what makes that number
 * mean something: it replays every active case of an Automation N times, and reads
 * back per-case latest-vs-previous so the question people actually have — "I
 * edited this Automation, did I break it?" — has an answer.
 *
 * **Trials are not optional decoration.** Our own research evals swung ±1 task
 * on identical 22-task batteries. A single run per case reports noise as a
 * regression, so `readEvalResults` compares the MEAN of the latest trial group
 * against the mean of the previous one and reports the spread it saw. A delta
 * smaller than the observed spread is not a signal, and the payload says so
 * rather than leaving the reader to infer it.
 *
 * **Nothing here aggregates history.** Results come from the case ENTITIES'
 * rolling `recent_scores` window (bounded at CASE_SCORE_WINDOW, written by the
 * scorer). `entities` is a config-sized table the invariants permit reading at
 * request time; `events` is not, and is never touched on this path.
 */

import { type DbClient, getDb } from "../db/client.js";
import { EVAL_CASE_ENTITY_TYPE_SLUG } from "../tools/constants.js";
import logger from "../utils/logger.js";
import { trialCaseKey } from "./eval-cases.js";
import { createEvalRun } from "./eval-runs.js";
import type { CaseScoreEntry } from "./eval-scores.js";

/**
 * Trials per case in one suite run. More is better statistics and linearly more
 * provider spend, so the default is the smallest number that can show a spread
 * at all; a caller who wants tighter bounds asks for more.
 */
const DEFAULT_TRIALS = 3;

/**
 * Ceiling per request, so one call cannot queue an unbounded replay burst.
 *
 * Bounded by `CASE_SCORE_WINDOW` (eval-scores.ts) as much as by spend: results
 * compare the latest `trials` scores against the previous `trials`, so raising
 * this past half the window would leave the baseline group unreadable.
 */
const MAX_TRIALS = 10;

interface EvalSuiteCase {
	caseId: number;
	name: string;
	caseKey: string;
	sourceRunId: number;
}

export interface RunEvalSuiteResult {
	automationId: number;
	trials: number;
	/** Runs actually queued. Fewer than cases×trials when a replay is in flight. */
	queued: number;
	cases: Array<{ caseId: number; runIds: number[] }>;
	/** Cases that could not be replayed at all, with the reason. */
	skipped: Array<{ caseId: number; reason: string }>;
}

/**
 * Load an Automation's ACTIVE eval cases.
 *
 * Retired cases are excluded here rather than at the call site: a retired case
 * is one a human decided no longer describes desired semantics, and silently
 * continuing to run it would make the suite report failures nobody wants fixed.
 */
async function listActiveCases(
	organizationId: string,
	automationId: number,
	caseIds?: number[],
	db?: DbClient,
): Promise<EvalSuiteCase[]> {
	const sql = db ?? getDb();
	const filterIds = caseIds?.filter((n) => Number.isSafeInteger(n) && n > 0);
	// Asked for a subset and named nothing usable → nothing. Falling through to
	// the unfiltered query would silently replay every case instead.
	if (caseIds?.length && !filterIds?.length) return [];
	const rows = (await sql`
    SELECT e.id, e.name, e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${organizationId}
      AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
      AND e.deleted_at IS NULL
      AND (e.metadata->>'automation_id')::bigint = ${automationId}
      AND coalesce(e.metadata->>'status', 'active') = 'active'
      ${
				// The client runs with `fetch_types: false`, so a raw JS array binds as
				// "malformed array literal". Format the `{n,n}` literal and cast it,
				// exactly like insert-event.ts does for entity_ids. It is still a bound
				// parameter rather than interpolated SQL — but it binds as TEXT, so a
				// non-integer would arrive as `NaN` and fail the cast at runtime.
				// Hence the filter above, rather than a promise about callers.
				filterIds?.length
					? sql`AND e.id = ANY(${`{${filterIds.join(",")}}`}::bigint[])`
					: sql``
			}
    ORDER BY e.id
  `) as unknown as Array<{
		id: number | string;
		name: string;
		metadata: Record<string, unknown> | null;
	}>;

	const cases: EvalSuiteCase[] = [];
	for (const row of rows) {
		const metadata = row.metadata ?? {};
		const sourceRunId = Number(metadata.source_run_id);
		if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) continue;
		cases.push({
			caseId: Number(row.id),
			name: row.name,
			caseKey:
				typeof metadata.case_key === "string" ? metadata.case_key : "default",
			sourceRunId,
		});
	}
	return cases;
}

/**
 * Replay every active case `trials` times.
 *
 * Each trial gets its own key via `trialCaseKey`, because `createEvalRun`
 * dedups on (sourceRunId, caseKey) — without distinct keys five trials would
 * collapse into one run and report a single measurement as five.
 *
 * A case whose source run is no longer replayable is SKIPPED with a reason
 * rather than failing the whole suite: one un-replayable case must not stop the
 * other twenty from being measured, and a silent omission would make the suite
 * look healthier than it is.
 */
export async function runEvalSuite(
	params: {
		organizationId: string;
		automationId: number;
		caseIds?: number[];
		trials?: number;
	},
	db?: DbClient,
): Promise<RunEvalSuiteResult> {
	const sql = db ?? getDb();
	const trials = Math.min(
		MAX_TRIALS,
		Math.max(1, Math.trunc(params.trials ?? DEFAULT_TRIALS)),
	);

	const cases = await listActiveCases(
		params.organizationId,
		params.automationId,
		params.caseIds,
		sql,
	);

	const result: RunEvalSuiteResult = {
		automationId: params.automationId,
		trials,
		queued: 0,
		cases: [],
		skipped: [],
	};

	for (const evalCase of cases) {
		const runIds: number[] = [];
		for (let trial = 0; trial < trials; trial += 1) {
			const minted = await createEvalRun(
				{
					sourceRunId: evalCase.sourceRunId,
					caseKey: trialCaseKey(evalCase.caseKey, trial),
				},
				sql,
			);
			if (!minted) {
				// createEvalRun already logged why (source gone, no frozen payload,
				// not dispatchable). Record it per case so the caller sees a partial
				// suite as partial.
				result.skipped.push({
					caseId: evalCase.caseId,
					reason: "not_replayable",
				});
				break;
			}
			runIds.push(minted.runId);
			if (minted.created) result.queued += 1;
		}
		if (runIds.length > 0) {
			result.cases.push({ caseId: evalCase.caseId, runIds });
			// Remember the batch size this suite queued, so the reader groups the
			// case's rolling window EXACTLY instead of guessing from its own
			// `trials` param. Positional grouping is only exact when the batch
			// size is known: reading a trials=5 batch with the default 3 mixes one
			// suite across both groups and reads a false regression out of it.
			await sql`
        UPDATE entities
        SET metadata = jsonb_set(
              coalesce(metadata, '{}'::jsonb),
              '{suite_trials}',
              ${sql.json(trials as never)}::jsonb
            ),
            updated_at = current_timestamp
        WHERE id = ${evalCase.caseId}
      `;
		}
	}

	logger.info(
		{
			automationId: params.automationId,
			cases: result.cases.length,
			skipped: result.skipped.length,
			trials,
			queued: result.queued,
		},
		"[evals] Queued an eval suite",
	);
	return result;
}

export interface EvalCaseResult {
	caseId: number;
	name: string;
	expectation: string | null;
	/** Mean of the most recent trial group. Null when never scored. */
	latest: number | null;
	/** Mean of the trial group before it. Null with fewer than two groups. */
	previous: number | null;
	/** latest − previous. Null when either side is missing. */
	delta: number | null;
	/** max−min within the latest group: the noise floor for this case. */
	spread: number;
	latestTrials: number;
	scores: CaseScoreEntry[];
}

export interface EvalResults {
	automationId: number;
	cases: EvalCaseResult[];
	summary: {
		cases: number;
		scored: number;
		latest: number | null;
		previous: number | null;
		delta: number | null;
		/**
		 * Cases whose drop EXCEEDS the noise they showed within the latest trial
		 * group. A drop smaller than its own spread is not reported as a
		 * regression — that conflation is what made a provider quota storm read as
		 * a 61–78% prompt regression.
		 */
		regressions: number[];
		improvements: number[];
	};
}

function mean(values: number[]): number {
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The metric set a group was scored against, canonicalized.
 *
 * A quality score is a pass fraction over the verdicts that HAPPENED to run, so
 * two scores are only comparable when their denominators match. If the judge is
 * lost between suites, a [pass,fail,judge-pass]=0.667 becomes [pass,fail]=0.5
 * and reads as a regression that never happened. Returns null when the group is
 * empty or any entry predates the `metrics` field — an unknown set never
 * compares equal to a measured one, and never to another unknown.
 */
function groupSignature(scores: CaseScoreEntry[]): string | null {
	const names = new Set<string>();
	for (const entry of scores) {
		if (!Array.isArray(entry.metrics) || entry.metrics.length === 0) {
			return null;
		}
		for (const metric of entry.metrics) names.add(metric);
	}
	return names.size > 0 ? [...names].sort().join(",") : null;
}

/**
 * Read an Automation's suite results: per case, latest vs previous, plus a summary.
 *
 * Pure entity reads — no `events`, no aggregation over run history.
 */
export async function readEvalResults(
	params: { organizationId: string; automationId: number; trials?: number },
	db?: DbClient,
): Promise<EvalResults> {
	const sql = db ?? getDb();
	const trials = Math.min(
		MAX_TRIALS,
		Math.max(1, Math.trunc(params.trials ?? DEFAULT_TRIALS)),
	);

	const rows = (await sql`
    SELECT e.id, e.name, e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${params.organizationId}
      AND et.slug = ${EVAL_CASE_ENTITY_TYPE_SLUG}
      AND e.deleted_at IS NULL
      AND (e.metadata->>'automation_id')::bigint = ${params.automationId}
      AND coalesce(e.metadata->>'status', 'active') = 'active'
    ORDER BY e.id
  `) as unknown as Array<{
		id: number | string;
		name: string;
		metadata: Record<string, unknown> | null;
	}>;

	const cases: EvalCaseResult[] = [];
	const regressions: number[] = [];
	const improvements: number[] = [];

	for (const row of rows) {
		const metadata = row.metadata ?? {};
		const scores = Array.isArray(metadata.recent_scores)
			? (metadata.recent_scores as CaseScoreEntry[])
			: [];
		// The suite that queued this case's newest batch knows its own size; the
		// reader's `trials` is only a fallback for cases never run by a suite
		// (i.e. pre-stamp rows). Grouping with a size that differs from the batch
		// would mix one suite across both groups — a false regression.
		const stampedTrials =
			typeof metadata.suite_trials === "number"
				? Math.min(MAX_TRIALS, Math.max(1, Math.trunc(metadata.suite_trials)))
				: null;
		const groupSize = stampedTrials ?? trials;
		// One usable array, and both the values and the signatures come from the
		// SAME slices — a score filtered out for being non-finite must not leave
		// the signature describing an entry the values don't count.
		const usable = scores.filter((s) => Number.isFinite(Number(s.score)));
		const latestEntries = usable.slice(0, groupSize);
		const previousEntries = usable.slice(groupSize, groupSize * 2);
		const latest =
			latestEntries.length > 0
				? mean(latestEntries.map((s) => Number(s.score)))
				: null;
		const previous =
			previousEntries.length > 0
				? mean(previousEntries.map((s) => Number(s.score)))
				: null;
		// Only like-for-like groups are compared: a changed metric set (say a lost
		// judge) makes the two denominators different, and a move between them is
		// not a signal about the Automation. An UNKNOWN set never compares equal —
		// to a measured set OR to another unknown — so both must resolve to a
		// known signature for the comparison to run at all. delta stays null
		// otherwise, which keeps the case out of regressions/improvements and the
		// summary.
		const latestSignature = groupSignature(latestEntries);
		const previousSignature = groupSignature(previousEntries);
		const comparable =
			latest != null &&
			previous != null &&
			latestSignature != null &&
			latestSignature === previousSignature;
		const delta = comparable ? latest - previous : null;
		const spread =
			latestEntries.length > 1
				? Math.max(...latestEntries.map((s) => Number(s.score))) -
					Math.min(...latestEntries.map((s) => Number(s.score)))
				: 0;

		const caseId = Number(row.id);
		// Only a move LARGER than the case's own observed noise counts.
		if (delta != null && delta < 0 && Math.abs(delta) > spread) {
			regressions.push(caseId);
		}
		if (delta != null && delta > 0 && delta > spread) {
			improvements.push(caseId);
		}

		cases.push({
			caseId,
			name: row.name,
			expectation:
				typeof metadata.expectation === "string" ? metadata.expectation : null,
			latest,
			previous,
			delta,
			spread,
			latestTrials: latestEntries.length,
			scores,
		});
	}

	// The summary aggregates only cases whose latest-vs-previous is like-for-like
	// (delta != null). A case with a single suite run so far — or one whose groups
	// disagree on metrics — is real data but no comparison, and must not be mixed
	// into a mean it would skew.
	const compared = cases.filter((c) => c.delta != null);
	const summaryLatest =
		compared.length > 0
			? mean(compared.map((c) => c.latest as number))
			: null;
	const summaryPrevious =
		compared.length > 0
			? mean(compared.map((c) => c.previous as number))
			: null;

	return {
		automationId: params.automationId,
		cases,
		summary: {
			cases: cases.length,
			scored: compared.length,
			latest: summaryLatest,
			previous: summaryPrevious,
			delta:
				summaryLatest != null && summaryPrevious != null
					? summaryLatest - summaryPrevious
					: null,
			regressions,
			improvements,
		},
	};
}
