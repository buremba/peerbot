/**
 * The eval scorer queue (evals PR 4, lobu#2564).
 *
 * An eval replay goes terminal on whichever pod happened to own its worker
 * session. Scoring it there would put the judge call on the dispatch hot path
 * and lose the verdict entirely whenever that pod dies mid-call. So scoring is
 * a queue, and the queue is Postgres: the work item is simply "a terminal
 * `behavior_eval` run with no live `eval_score` event yet".
 *
 * That predicate IS the claim. There is no in-memory sampler, no cursor, and no
 * per-pod state another replica has to read — a run leaves the queue only when
 * its score events exist, which is a committed fact every replica can see. A
 * pod that dies mid-score simply leaves the run in the queue for the next tick:
 * `scoreEvalRun` commits every verdict and the quality stamp in ONE
 * transaction, so a partial score is never visible and the probed key never
 * appears without its siblings. The per-(run, metric) unique index
 * (20260807170010) is what makes a double-claim harmless rather than a double
 * count.
 *
 * Note this is deliberately NOT `FOR UPDATE SKIP LOCKED`. That would serialize
 * two replicas against each other for the whole duration of a judge call — 30s
 * of held row lock to save a duplicate insert the unique index already rejects
 * for free. Idempotent work does not need a lock, it needs an idempotency key.
 */

import { getErrorMessage } from "@lobu/core";
import { getDb } from "../db/client";
import {
	EVAL_SCORE_IDENTITY_NS,
	scoreEvalRun,
	TERMINAL_RUN_STATUSES_PG,
} from "../runs/eval-scores";
import { BEHAVIOR_EVAL_RUN_TYPE } from "../runs/run-types";
import logger from "../utils/logger";

/**
 * Runs scored per invocation. Each carries at most one judge call, so this
 * bounds the tick's wall-clock and its spend. A backlog drains over successive
 * ticks rather than in one burst that could exhaust the org's provider quota —
 * which matters because a quota-exhausted provider returns 429s that look like
 * agent failures, so an unbounded scorer would corrupt the very numbers it
 * exists to produce.
 */
const SCORE_BATCH_SIZE = 25;

/**
 * How long after a run goes terminal before it is scoreable.
 *
 * `dry_run_preview` is MERGED by several capture sites during a turn and
 * finalize runs last, so reading it the instant the status flips can catch a
 * partially-written record and score a complete run as an incomplete one. A
 * short settle window costs a tick and removes that whole class of false
 * failure.
 */
const SCORE_SETTLE_SECONDS = 60;

export interface ScoreEvalRunsSummary {
	claimed: number;
	scored: number;
	skipped: number;
	failed: number;
}

/**
 * Score every terminal eval run that has no score yet.
 *
 * `judgeModelRef` (from config) should name a model DIFFERENT from the one
 * under eval — a model grading its own output rates it generously, which is the
 * self-preference bias the spec calls out. Left undefined, the org default is
 * used and that protection is absent; the caller owns the choice.
 */
export async function runScoreEvalRuns(opts?: {
	judgeModelRef?: string;
}): Promise<ScoreEvalRunsSummary> {
	const sql = getDb();
	const summary: ScoreEvalRunsSummary = {
		claimed: 0,
		scored: 0,
		skipped: 0,
		failed: 0,
	};

	// The anti-join IS the queue, and it probes ONE key: `<runId>:completed_window`.
	//
	// That metric is the only unconditional one — `scoreEvalRun` always produces
	// it, while `output_present` depends on the record and `judge_rubric` on a
	// case, an expectation and a reachable provider. So its chain root existing
	// is the definitive "this run has been scored" fact, and probing it is an
	// EQUALITY hit on idx_events_identity_root_eval_score
	// (organization_id, identity_key WHERE supersedes_event_id IS NULL …). A
	// prefix LIKE over the key would scan instead, and matching on
	// `superseded_by IS NULL` would miss the index predicate entirely — this
	// query has to stay bounded as eval history grows.
	const candidates = (await sql`
    SELECT r.id
    FROM runs r
    WHERE r.run_type = ${BEHAVIOR_EVAL_RUN_TYPE}
      AND r.status = ANY(${TERMINAL_RUN_STATUSES_PG}::text[])
      AND coalesce(r.completed_at, r.created_at)
            < now() - ${`${SCORE_SETTLE_SECONDS} seconds`}::interval
      AND NOT EXISTS (
        SELECT 1 FROM events e
        WHERE e.organization_id = r.organization_id
          AND e.identity_ns = ${EVAL_SCORE_IDENTITY_NS}
          AND e.identity_key = r.id || ':completed_window'
          AND e.supersedes_event_id IS NULL
      )
    ORDER BY r.id
    LIMIT ${SCORE_BATCH_SIZE}
  `) as unknown as Array<{ id: number | string }>;

	summary.claimed = candidates.length;
	if (candidates.length === 0) return summary;

	for (const candidate of candidates) {
		const runId = Number(candidate.id);
		try {
			const result = await scoreEvalRun({
				runId,
				judgeModelRef: opts?.judgeModelRef,
			});
			if (result.ok) {
				summary.scored += 1;
			} else {
				// A rejection is information, not an error: `not_terminal` means the
				// settle window raced a status change, `no_attributable_member` means
				// the org has no one to attribute to. Both are re-tried next tick, so
				// the run stays in the queue rather than being silently dropped.
				summary.skipped += 1;
				logger.info(
					{ runId, reason: result.reason },
					"[evals] Skipped scoring an eval run",
				);
			}
		} catch (error) {
			// One bad run must not abandon the rest of the batch. It stays in the
			// queue (no score event was written) and is retried next tick.
			summary.failed += 1;
			logger.error(
				{ runId, err: getErrorMessage(error) },
				"[evals] Failed to score an eval run",
			);
		}
	}

	return summary;
}
