/**
 * Scoring an eval replay (evals PR 4, lobu#2564).
 *
 * A `automation_eval` run executes under capture mode: it does the same reads and
 * the same reasoning a live run does, but every write is recorded onto
 * `runs.dry_run_preview` instead of committed. That preview is therefore the
 * complete, honest record of what the Automation produced — and it is what this
 * module scores.
 *
 * Two kinds of metric, kept deliberately separate:
 *
 *   - CODE metrics are pure functions of the captured record. They cost
 *     nothing, never flake, and run on every scored eval. `completed_window` is
 *     the one that earns its keep on day one: "finished without calling
 *     complete_window" is the largest single `agent_error` class
 *     (`runs/run-outcome.ts`) in the prod sample measured in lobu#2564.
 *   - The JUDGE metric asks a model whether the captured output actually
 *     satisfies the case's expectation. It needs a provider, a case, and an
 *     expectation, so it is frequently absent — and its absence must read as
 *     "not measured", never as a failing grade. See `scoreEvalRun`.
 *
 * Scores are `semantic_type='eval_score'` events with NULL payload_text and
 * NULL feed_id — the structural exclusion from embedding, search and feed reads
 * that run results established. Identity is
 * `{ ns: 'eval_score', key: '<runId>:<metric>' }`, backed by a partial unique
 * index over chain roots (20260807170010), so a second replica scoring the same
 * run cannot double-write. Rescoring supersedes the head rather than editing it.
 *
 * The request-path rule holds: nothing reads these events to answer "how good is
 * this Automation". The pass fraction is stamped onto the `automations` row here, at
 * write time, so the surface that eventually renders it reads a column rather
 * than aggregating history.
 */

import { validateEntityRowPatch } from "../authz/entity-row-validation";
import { getErrorMessage } from "@lobu/core";
import { type DbClient, getDb, pgTextArray } from "../db/client.js";
import {
	gatewayCompletion,
	resolveCompletionTarget,
} from "../gateway/inference/gateway-completion.js";
import { patchEntityRows } from "../utils/entity-management.js";
import { insertEvent } from "../utils/insert-event.js";
import logger from "../utils/logger.js";
import { resolveEntityCreator } from "../utils/resolve-entity-creator.js";
import {
	EVAL_CASE_NAMESPACE,
	evalCaseIdentifierFromRunKey,
} from "./eval-cases.js";
import { AUTOMATION_EVAL_RUN_TYPE } from "./run-types.js";

/** `semantic_type` of a score event. */
const EVAL_SCORE_SEMANTIC_TYPE = "eval_score";

/** Identity namespace backing the per-(run, metric) unique index. */
export const EVAL_SCORE_IDENTITY_NS = "eval_score";

/**
 * Metrics this module can produce. Stable strings — each is the `metric` field
 * on every score event it writes AND half of that event's identity key
 * (`<runId>:<metric>`), so renaming one orphans its whole history: the old
 * chains keep the old key and nothing supersedes them again.
 */
export type EvalMetric =
	/** Did the agent terminate through `complete_window` rather than just stopping? */
	| "completed_window"
	/** Did it produce non-empty extracted output? */
	| "output_present"
	/** Does the output satisfy the case's expectation, per a judge model? */
	| "judge_rubric";

export interface EvalMetricVerdict {
	metric: EvalMetric;
	/** 0.0–1.0. Code metrics are binary (0 or 1); the judge may be graded. */
	score: number;
	passed: boolean;
	reasoning: string;
	/** Set only on judge metrics — which model returned the verdict. */
	judgeModel?: string;
}

export type ScoreEvalRunResult =
	| {
			ok: true;
			runId: number;
			automationId: number;
			verdicts: EvalMetricVerdict[];
			/** Pass fraction across the verdicts actually produced. */
			qualityScore: number;
			caseEntityId: number | null;
	  }
	| {
			ok: false;
			// No "empty capture record" rejection on purpose: an eval run that
			// captured nothing is not unscoreable, it is a `completed_window`
			// FAILURE — which is the single most common real defect. Refusing to
			// score it would hide exactly the runs worth measuring.
			reason:
				| "not_found"
				| "not_an_eval_run"
				| "not_terminal"
				| "no_attributable_member";
	  };

/**
 * Terminal statuses a run must reach before it means anything to score.
 *
 * The full terminal set `runs_status_check` allows, matching
 * `check-stalled-executions.ts`. `timeout` in particular is NOT optional:
 * `markStaleRunsAsTimeout` runs over `AUTOMATION_RUN_TYPES`, so a crashed or
 * abandoned eval reaches `timeout` and never any other terminal status.
 * Omitting it would silently drop exactly the runs worth measuring — an eval
 * that hung is a `completed_window` FAILURE, not an unscoreable run.
 */
const TERMINAL_RUN_STATUSES = ["completed", "failed", "timeout", "cancelled"];

/**
 * The same list as a Postgres `text[]` literal, for the scorer queue's `= ANY`.
 *
 * The queue MUST select on this exact list. If the two drifted apart it would
 * keep claiming runs `scoreEvalRun` then rejects as `not_terminal` — and since a
 * rejected run writes no score events, such a run never leaves the queue and
 * burns a batch slot on every tick, forever.
 *
 * Bind THIS, never the array itself: the pool runs with `fetch_types: false`, so
 * a raw JS array is sent as the bare string `completed,failed,cancelled` and
 * Postgres rejects it at runtime with `malformed array literal`.
 */
export const TERMINAL_RUN_STATUSES_PG = pgTextArray(TERMINAL_RUN_STATUSES);

/** The judge gets a bounded slice of the output — a rubric verdict is not a diff. */
const JUDGE_OUTPUT_CHAR_CAP = 8_000;

/** A judge call must not hold a scorer batch open. */
const JUDGE_TIMEOUT_MS = 30_000;

interface EvalRunRow {
	id: number;
	organization_id: string;
	automation_id: number;
	status: string;
	dry_run_preview: Record<string, unknown> | null;
	idempotency_key: string | null;
}

/**
 * The fields of the captured record this module scores, in the shape
 * `complete-window.ts` writes them. The preview carries more (`side_effects`,
 * window bounds, content ids); nothing here reads them, so nothing here
 * declares them.
 *
 * Every field is optional on purpose: the preview is a MERGE target that
 * several capture sites append to during a turn, so a run that died early has a
 * partial one. Treating a missing field as "the agent didn't do that" is the
 * correct reading and is exactly what `completed_window` measures.
 */
interface CaptureRecord {
	captured?: string;
	extracted_data?: unknown;
	content_linked?: number;
}

/**
 * Did the run terminate through the Automation protocol?
 *
 * `captured: 'complete_window'` is written by the ONE capture branch in
 * `complete-window.ts`, so its presence is proof the agent called the tool.
 * Absence is the prod-dominant failure: the agent ran, produced text, and
 * stopped without ever completing its window.
 */
function scoreCompletedWindow(record: CaptureRecord): EvalMetricVerdict {
	const passed = record.captured === "complete_window";
	return {
		metric: "completed_window",
		score: passed ? 1 : 0,
		passed,
		reasoning: passed
			? "The run terminated through complete_window."
			: "The run never called complete_window — it stopped without completing its window.",
	};
}

/**
 * Did the run actually produce output?
 *
 * Deliberately separate from `completed_window`: an agent can complete its
 * window with an empty extraction, which is a protocol success and a quality
 * failure. Collapsing them would hide exactly that case.
 */
function scoreOutputPresent(record: CaptureRecord): EvalMetricVerdict {
	const data = record.extracted_data;
	const nonEmpty =
		data != null &&
		(Array.isArray(data)
			? data.length > 0
			: typeof data === "object"
				? Object.keys(data as Record<string, unknown>).length > 0
				: String(data).trim().length > 0);
	return {
		metric: "output_present",
		score: nonEmpty ? 1 : 0,
		passed: nonEmpty,
		reasoning: nonEmpty
			? `Extracted output is present (${record.content_linked ?? 0} content item(s) linked).`
			: "The run produced no extracted output.",
	};
}

const JUDGE_SYSTEM_PROMPT = [
	"You grade whether an automation's output satisfies a stated expectation.",
	"You are given the expectation and the output the automation actually produced.",
	'Reply with ONLY a JSON object: {"score": <0.0-1.0>, "passed": <true|false>, "reasoning": "<one or two sentences>"}.',
	"Grade the output against the expectation only. Do not reward verbosity, and do not penalise formatting differences that leave the substance intact.",
].join("\n");

/** Parse the judge's reply. Returns null on anything that is not a usable verdict. */
export function parseJudgeVerdict(
	raw: string,
): { score: number; passed: boolean; reasoning: string } | null {
	// Models fence JSON often enough that stripping the fence is worth one line;
	// anything past that is the model failing the contract, and we skip the
	// metric rather than inventing a grade for it.
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return null;
	}
	if (parsed == null || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const score = typeof obj.score === "number" ? obj.score : Number.NaN;
	if (!Number.isFinite(score) || score < 0 || score > 1) return null;
	return {
		score,
		// Trust an explicit boolean; otherwise derive from the score rather than
		// defaulting to pass — an unstated verdict is not a passing one.
		passed: typeof obj.passed === "boolean" ? obj.passed : score >= 0.5,
		reasoning:
			typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 2_000) : "",
	};
}

/**
 * Ask a judge model whether the captured output meets the case's expectation.
 *
 * Returns null — no verdict, no event — whenever the judge cannot be asked
 * honestly: no expectation, no resolvable provider, a transport failure, or a
 * reply that is not a verdict. That is the whole point of returning null rather
 * than a 0: an unasked question must never be recorded as a failed one, because
 * the pass fraction would then punish an Automation for the platform's outage.
 *
 * `judgeModelRef` should name a model DIFFERENT from the one under eval
 * (self-preference bias); the caller owns that choice.
 */
async function judgeAgainstExpectation(params: {
	organizationId: string;
	expectation: string;
	output: unknown;
	judgeModelRef?: string;
}): Promise<EvalMetricVerdict | null> {
	const expectation = params.expectation.trim();
	if (!expectation) return null;

	const target = await resolveCompletionTarget(
		params.organizationId,
		params.judgeModelRef,
	);
	if (!target) {
		logger.warn(
			{ organizationId: params.organizationId },
			"[evals] No judge provider resolved — skipping the judge metric rather than scoring it 0",
		);
		return null;
	}

	const rendered =
		typeof params.output === "string"
			? params.output
			: JSON.stringify(params.output ?? null, null, 2);

	let raw: string;
	try {
		raw = await gatewayCompletion({
			target,
			systemPrompt: JUDGE_SYSTEM_PROMPT,
			userPrompt: [
				"EXPECTATION:",
				expectation,
				"",
				"OUTPUT THE AUTOMATION PRODUCED:",
				rendered.slice(0, JUDGE_OUTPUT_CHAR_CAP),
			].join("\n"),
			timeoutMs: JUDGE_TIMEOUT_MS,
		});
	} catch (error) {
		logger.warn(
			{
				organizationId: params.organizationId,
				model: target.model,
				err: getErrorMessage(error),
			},
			"[evals] Judge call failed — skipping the judge metric",
		);
		return null;
	}

	const verdict = parseJudgeVerdict(raw);
	if (!verdict) {
		logger.warn(
			{ organizationId: params.organizationId, model: target.model },
			"[evals] Judge reply was not a usable verdict — skipping the judge metric",
		);
		return null;
	}

	return {
		metric: "judge_rubric",
		score: verdict.score,
		passed: verdict.passed,
		reasoning: verdict.reasoning,
		judgeModel: target.model,
	};
}

/**
 * Recover the eval case behind a run, if it has one.
 *
 * The identifier comes from `evalCaseIdentifierFromRunKey` — the one place that
 * knows how a run key maps back to a case, trial suffix included. A run minted
 * by a bare replay with no promoted case resolves to null and is scored on its
 * code metrics alone.
 *
 * `judge_model` is read here for the same reason a guardrail entry carries
 * `model`: the platform already lets a feature name its own model as a
 * `<slug>/<model>` ref resolved through `resolveCompletionTarget`, and an eval
 * case is the right owner for that choice — it is the thing that knows what
 * "good" means. No new config surface, no env var.
 */
async function findCaseForRun(
	sql: DbClient,
	organizationId: string,
	idempotencyKey: string | null,
): Promise<{
	entityId: number;
	expectation: string | null;
	judgeModel: string | null;
} | null> {
	const identifier = evalCaseIdentifierFromRunKey(idempotencyKey);
	if (!identifier) return null;

	const rows = (await sql`
    SELECT e.id,
           e.metadata->>'expectation' AS expectation,
           e.metadata->>'judge_model' AS judge_model
    FROM entity_identities ei
    JOIN entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = ${organizationId}
      AND ei.namespace = ${EVAL_CASE_NAMESPACE}
      AND ei.identifier = ${identifier}
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
		id: number | string;
		expectation: string | null;
		judge_model: string | null;
	}>;

	if (rows.length === 0) return null;
	return {
		entityId: Number(rows[0].id),
		expectation: rows[0].expectation,
		judgeModel: rows[0].judge_model,
	};
}

/**
 * Score one terminal eval run: write its metric events and stamp the Automation.
 *
 * Idempotent. Re-scoring the same run supersedes each metric's chain head
 * rather than appending a second live row, so the metrics layer always sees
 * exactly one current verdict per (run, metric).
 */
export async function scoreEvalRun(
	params: { runId: number; judgeModelRef?: string },
	db?: DbClient,
): Promise<ScoreEvalRunResult> {
	const sql = db ?? getDb();

	const rows = (await sql`
    SELECT id, organization_id, automation_id AS automation_id, status, run_type,
           dry_run_preview, idempotency_key
    FROM runs
    WHERE id = ${params.runId}
    LIMIT 1
  `) as unknown as Array<{
		id: number | string;
		organization_id: string | null;
		automation_id: number | null;
		status: string;
		run_type: string;
		dry_run_preview: unknown;
		idempotency_key: string | null;
	}>;
	if (rows.length === 0) return { ok: false, reason: "not_found" };

	// Read the discriminator off the row rather than trusting the caller:
	// scoring a live Automation run would stamp production quality from a run
	// nobody ever evaluated.
	if (rows[0].run_type !== AUTOMATION_EVAL_RUN_TYPE) {
		return { ok: false, reason: "not_an_eval_run" };
	}

	const row = rows[0] as unknown as EvalRunRow;
	if (!row.organization_id || row.automation_id == null) {
		return { ok: false, reason: "not_found" };
	}
	if (!TERMINAL_RUN_STATUSES.includes(row.status)) {
		return { ok: false, reason: "not_terminal" };
	}

	const record: CaptureRecord =
		row.dry_run_preview && typeof row.dry_run_preview === "object"
			? (row.dry_run_preview as CaptureRecord)
			: {};

	const organizationId = row.organization_id;
	const automationId = Number(row.automation_id);

	const evalCase = await findCaseForRun(
		sql,
		organizationId,
		row.idempotency_key,
	);

	// Resolved BEFORE the judge: events.created_by is NOT NULL behind ON DELETE
	// RESTRICT, so an org with no live member cannot receive score events at all.
	// Discovering that after a paid 30s judge call would bill the org for a
	// verdict we then throw away.
	const createdBy = await resolveEntityCreator(sql, organizationId, null);
	if (!createdBy) {
		logger.warn(
			{ runId: params.runId, organizationId },
			"[evals] no live member to attribute eval scores to — not scoring",
		);
		return { ok: false, reason: "no_attributable_member" };
	}

	const verdicts: EvalMetricVerdict[] = [
		scoreCompletedWindow(record),
		scoreOutputPresent(record),
	];

	// Outside the transaction below on purpose: a judge call takes up to 30s and
	// must never hold an open transaction on the hot events table.
	if (evalCase?.expectation) {
		const judged = await judgeAgainstExpectation({
			organizationId,
			expectation: evalCase.expectation,
			output: record.extracted_data,
			// The case's own `judge_model` wins — it is the thing that knows what
			// "good" means here, and naming a model DIFFERENT from the one under
			// eval is how a caller avoids self-preference bias. Falls through to
			// the caller's default, then to the org default.
			judgeModelRef: evalCase.judgeModel || params.judgeModelRef,
		});
		if (judged) verdicts.push(judged);
	}

	const qualityScore =
		verdicts.reduce((sum, v) => sum + (v.passed ? 1 : 0), 0) / verdicts.length;

	// One transaction for every verdict AND the stamp. The scorer queue treats
	// "the `completed_window` chain root exists" as proof the run is fully
	// scored, so that root must not become visible before its siblings: a crash
	// between two non-transactional inserts would drop the run out of the queue
	// permanently, with its remaining metrics and its quality stamp missing and
	// nothing left to retry them.
	await sql.begin(async (tx) => {
		for (const verdict of verdicts) {
			await writeScoreEvent({
				sql: tx,
				organizationId,
				runId: Number(row.id),
				automationId,
				caseEntityId: evalCase?.entityId ?? null,
				createdBy,
				verdict,
			});
		}

		// Materialize at WRITE time so a reader gets it from the `automations` row it
		// already selects and never aggregates the events above. The guard keeps an
		// OLD run scored late (another replica, a later queue tick) from overwriting
		// a newer run's stamp: the queue only orders within a batch, so nothing else
		// stops out-of-order scoring from regressing the Automation's latest picture.
		await tx`
      UPDATE automations
      SET latest_eval_score = ${qualityScore},
          latest_eval_at = current_timestamp,
          latest_eval_run_id = ${Number(row.id)}
      WHERE id = ${automationId}
        AND organization_id = ${organizationId}
        AND (latest_eval_run_id IS NULL OR latest_eval_run_id <= ${Number(row.id)})
    `;

		if (evalCase) {
			await pushCaseScore(tx, evalCase.entityId, {
				run_id: Number(row.id),
				score: qualityScore,
				at: new Date().toISOString(),
				metrics: verdicts.map((v) => v.metric),
			});
		}
	});

	logger.info(
		{
			runId: Number(row.id),
			automationId,
			caseEntityId: evalCase?.entityId ?? null,
			metrics: verdicts.map((v) => `${v.metric}=${v.passed ? "pass" : "fail"}`),
			qualityScore,
		},
		"[evals] Scored an eval replay",
	);

	return {
		ok: true,
		runId: Number(row.id),
		automationId,
		verdicts,
		qualityScore,
		caseEntityId: evalCase?.entityId ?? null,
	};
}

/**
 * How many run scores a case remembers. The window is what makes "did my edit
 * break this?" answerable without touching `events`.
 *
 * Bounded on purpose. `entities` is a config-sized table the invariants
 * explicitly allow reading at request time — but only while a row stays a row.
 * An unbounded array would turn every case into growing history and reintroduce
 * exactly the read-time cost the rule exists to prevent.
 *
 * Must stay at least 2 × `MAX_TRIALS` (eval-suite.ts): `readEvalResults` reads
 * the latest `trials` entries as the current group and the next `trials` as the
 * baseline, so a window shorter than both groups makes `previous` — and
 * therefore every regression verdict — permanently null at the top of the
 * allowed trial range.
 */
const CASE_SCORE_WINDOW = 20;

export interface CaseScoreEntry {
	run_id: number;
	score: number;
	at: string;
	/**
	 * Metrics that made up `score`. `readEvalResults` compares only entries whose
	 * groups carry the SAME metric set — losing the judge (provider outage)
	 * changes the denominator, and a [pass,fail,judge-pass]=0.667 dropping to
	 * [pass,fail]=0.5 must not read as a regression. Absent on pre-metrics rows;
	 * an unknown set never compares equal to a measured one.
	 */
	metrics?: string[];
}

/**
 * Push a run's score onto its case's rolling window, newest first.
 *
 * Read-modify-write inside the scorer's transaction. `entities` has no
 * jsonb-array-append primitive that preserves order and cap, and the row is
 * locked by the enclosing transaction, so two replicas scoring two runs of the
 * same case serialize rather than losing one another's entry.
 *
 * De-duplicates on `run_id` so a RESCORE replaces its own entry instead of
 * appending a second one — otherwise scoring a run twice would look like two
 * trials and quietly halve the apparent variance.
 */
async function pushCaseScore(
	tx: DbClient,
	caseEntityId: number,
	entry: CaseScoreEntry,
): Promise<void> {
	// Live-only, matching `patchEntityRows`: a deleted case would otherwise be
	// read, merged and then silently not written by the kernel's own filter.
	const rows = (await tx`
    SELECT metadata
    FROM entities
    WHERE id = ${caseEntityId} AND deleted_at IS NULL
    FOR UPDATE
  `) as unknown as Array<{ metadata: Record<string, unknown> | null }>;
	if (rows.length === 0) return;

	const metadata = rows[0].metadata ?? {};
	const existing = Array.isArray(metadata.recent_scores)
		? (metadata.recent_scores as CaseScoreEntry[])
		: [];
	// Newest run first, always: `readEvalResults` groups positionally, so a run
	// scored late (a retry after newer runs) must not land at position 0 and
	// corrupt the latest-vs-previous split. Same out-of-order hazard the
	// automations stamp guards, deduplicated here against the window cap.
	const next = [
		entry,
		...existing.filter((e) => Number(e?.run_id) !== entry.run_id),
	]
		.sort((a, b) => Number(b.run_id) - Number(a.run_id))
		.slice(0, CASE_SCORE_WINDOW);

	await patchEntityRows({
		tx,
		ids: [caseEntityId],
		patch: await validateEntityRowPatch({
			tx,
			ids: [caseEntityId],
			patch: { metadata: { ...metadata, recent_scores: next } },
		}),
	});
}

/**
 * Write (or supersede) one metric's score event.
 *
 * NULL `content` and no `feedId`: that is the structural exclusion from
 * embedding, search and feed reads. `payloadData` carries the verdict so the
 * metrics compiler and entity views can read it without a payload_text.
 */
async function writeScoreEvent(params: {
	sql: DbClient;
	organizationId: string;
	runId: number;
	automationId: number;
	caseEntityId: number | null;
	createdBy: string;
	verdict: EvalMetricVerdict;
}): Promise<void> {
	const { sql, verdict } = params;
	const identityKey = `${params.runId}:${verdict.metric}`;

	// Supersede our own head so a rescore versions rather than forks. The unique
	// index is over chain ROOTS, so the successor (non-NULL supersedes_event_id)
	// is outside it and this is the only way a second verdict can land.
	const head = (await sql`
    SELECT id FROM events
    WHERE organization_id = ${params.organizationId}
      AND identity_ns = ${EVAL_SCORE_IDENTITY_NS}
      AND identity_key = ${identityKey}
      AND superseded_by IS NULL
    LIMIT 1
  `) as unknown as Array<{ id: number | string }>;

	await insertEvent(
		{
			entityIds: params.caseEntityId != null ? [params.caseEntityId] : [],
			organizationId: params.organizationId,
			originId: `eval_score:${identityKey}`,
			semanticType: EVAL_SCORE_SEMANTIC_TYPE,
			title: `Eval score · run ${params.runId} · ${verdict.metric}`,
			payloadType: "empty",
			content: null,
			payloadData: {
				run_id: params.runId,
				automation_id: params.automationId,
				metric: verdict.metric,
				score: verdict.score,
				passed: verdict.passed,
				reasoning: verdict.reasoning,
				...(verdict.judgeModel ? { judge_model: verdict.judgeModel } : {}),
			},
			// The link to the eval case is `entity_ids`, set above — not a metadata
			// alias. (The metrics compiler's `by: "alias"` resolver joins
			// `entities.metadata->'aliases'`, which `$eval_case` does not carry.)
			metadata: {
				run_id: params.runId,
				automation_id: params.automationId,
				metric: verdict.metric,
			},
			runId: params.runId,
			identity: { ns: EVAL_SCORE_IDENTITY_NS, key: identityKey },
			supersedesEventId: head.length > 0 ? Number(head[0].id) : null,
			createdBy: params.createdBy,
		},
		{ sql },
	);
}
