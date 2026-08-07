/**
 * Creating eval runs (evals PR 2, lobu#2564).
 *
 * An eval run replays a real Behavior run's frozen dispatch payload — the same
 * window bounds, the same behavior version, the same trigger signal — so the
 * agent sees what it saw the first time. What differs is only the run type,
 * which the server turns into `executionMode = 'capture'` at session creation:
 * the replay records what the agent tried to do instead of doing it.
 *
 * `runs.approved_input` is the frozen payload and is copied VERBATIM. Do not
 * recompute the window here: a recomputed window is a different question than
 * the one the original run answered, and the comparison stops meaning
 * anything.
 *
 * PR 3's promote flow calls this too — it is the one way an eval run is minted.
 */

import { type DbClient, getDb } from "../db/client.js";
import logger from "../utils/logger.js";
import { BEHAVIOR_EVAL_RUN_TYPE, BEHAVIOR_RUN_TYPE } from "./run-types.js";

export interface CreateEvalRunResult {
	runId: number;
	sourceRunId: number;
	behaviorId: number;
	created: boolean;
}

/**
 * Clone a terminal Behavior run into a pending eval replay.
 *
 * `caseKey` scopes idempotency: re-running with the same (sourceRunId,
 * caseKey) reuses the in-flight eval rather than queueing a second one. Pass a
 * distinct key (an attempt number, a case id) to run the same source run
 * several times — which is the point, since a single trial is not a
 * measurement.
 *
 * Returns null when the source run does not exist, is not a Behavior run, or
 * carries no frozen payload to replay.
 */
export async function createEvalRun(
	params: { sourceRunId: number; caseKey: string },
	db?: DbClient,
): Promise<CreateEvalRunResult | null> {
	const sql = db ?? getDb();
	const idempotencyKey = `behavior_eval:${params.sourceRunId}:${params.caseKey}`;

	const source = (await sql`
    SELECT id, organization_id, watcher_id, approved_input
    FROM runs
    WHERE id = ${params.sourceRunId}
      AND run_type = ${BEHAVIOR_RUN_TYPE}
    LIMIT 1
  `) as unknown as Array<{
		id: number | string;
		organization_id: string | null;
		watcher_id: number | null;
		approved_input: unknown;
	}>;

	if (source.length === 0) {
		logger.warn(
			{ sourceRunId: params.sourceRunId },
			"[evals] No such Behavior run to replay",
		);
		return null;
	}
	const row = source[0];
	if (!row.organization_id || !row.watcher_id || !row.approved_input) {
		logger.warn(
			{ sourceRunId: params.sourceRunId },
			"[evals] Behavior run has no frozen dispatch payload — nothing to replay",
		);
		return null;
	}

	// Refuse a source whose clone no eval lane could ever claim. The cloud
	// dispatcher skips device-pinned and manual-open runs, and the device poll
	// lane claims `behavior` only — so such an eval sits `pending` forever, and
	// because the claim guards are same-lane it wedges every later eval of this
	// Behavior. Nothing reaps a stranded pending eval either
	// (`finalizeStalePendingWatcherRuns` is behavior-only by design: it advances
	// `next_run_at`). Failing loudly at mint beats creating undispatchable work.
	const payload = row.approved_input as Record<string, unknown>;
	const agentId =
		typeof payload.agent_id === "string" ? payload.agent_id.trim() : "";
	const devicePin =
		typeof payload.device_worker_id === "string"
			? payload.device_worker_id.trim()
			: "";
	if (devicePin || !agentId) {
		logger.warn(
			{
				sourceRunId: params.sourceRunId,
				devicePinned: Boolean(devicePin),
				hasAgent: Boolean(agentId),
			},
			"[evals] Behavior run is not server-dispatchable — its replay could never be claimed",
		);
		return null;
	}

	const inserted = (await sql`
    INSERT INTO runs (
      organization_id,
      run_type,
      watcher_id,
      approval_status,
      status,
      approved_input,
      idempotency_key,
      created_at
    ) VALUES (
      ${row.organization_id},
      ${BEHAVIOR_EVAL_RUN_TYPE},
      ${row.watcher_id},
      'auto',
      'pending',
      ${sql.json(row.approved_input as never)},
      ${idempotencyKey},
      current_timestamp
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: number | string }>;

	if (inserted.length === 0) {
		// The partial unique index on idempotency_key covers pending/claimed/
		// running only, so this means an identical replay is already in flight.
		const existing = (await sql`
      SELECT id FROM runs
      WHERE idempotency_key = ${idempotencyKey}
        AND status IN ('pending', 'claimed', 'running')
      LIMIT 1
    `) as unknown as Array<{ id: number | string }>;
		if (existing.length === 0) return null;
		return {
			runId: Number(existing[0].id),
			sourceRunId: Number(row.id),
			behaviorId: row.watcher_id,
			created: false,
		};
	}

	const runId = Number(inserted[0].id);
	logger.info(
		{
			runId,
			sourceRunId: params.sourceRunId,
			behaviorId: row.watcher_id,
			caseKey: params.caseKey,
		},
		"[evals] Queued an eval replay",
	);
	return {
		runId,
		sourceRunId: Number(row.id),
		behaviorId: row.watcher_id,
		created: true,
	};
}
