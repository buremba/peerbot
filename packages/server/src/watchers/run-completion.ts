import type { DbClient } from "../db/client";
import { getDb, pgTextArray } from "../db/client";
import { listPendingToolsForRun } from "../gateway/auth/mcp/pending-tool-store";
import logger from "../utils/logger";
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from "../utils/run-statuses";
import { advanceScheduleAfterTerminalFailure } from "./schedule-cursor";

type WatcherTerminalResult = { ok: true } | { ok: false; error: string };

/**
 * How many times a watcher run that finished its agent turn WITHOUT calling
 * `complete_window` is re-dispatched before being marked failed. The agent
 * read its inputs and replied but skipped the finalize tool call — a soft,
 * usually-non-deterministic miss (the model "forgot" the closing step). A
 * bounded re-dispatch gives it a fresh turn to finalize. Default 1 (one extra
 * attempt); 0 disables. Each re-dispatch is a full agent turn, so keep it low.
 *
 * NOTE: this is a re-dispatch (a fresh session via the existing dispatch loop),
 * not a warm in-session nudge — the agent-worker is platform-agnostic and has
 * no notion of watchers/complete_window, so a worker-side self-nudge would
 * break that isolation. This constant is the GLOBAL default; a watcher can
 * override it via execution_config.finalize_nudges (see
 * resolveFinalizeNudgeBudget). A declarative defineBehavior surface for it is
 * the remaining follow-up (the CLI doesn't expose execution_config yet).
 */
const MAX_FINALIZE_NUDGES: number = (() => {
	const raw = process.env.LOBU_WATCHER_FINALIZE_NUDGES;
	if (raw === undefined) return 1;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
})();

/**
 * Finalize-nudge budget for a run: the watcher's per-watcher override
 * (execution_config.finalize_nudges, 0-5) when set, else the global default.
 * Clamped defensively in case a raw DB value sits outside the schema's range.
 *
 * Shared by the cloud dispatch path and the device `complete-behavior` exit
 * report so both honor the same per-Behavior / global budget.
 */
export function resolveFinalizeNudgeBudget(
	executionConfig: Record<string, unknown> | null | undefined
): number {
	const override = executionConfig?.finalize_nudges;
	if (typeof override === "number" && Number.isFinite(override)) {
		return Math.min(5, Math.max(0, Math.floor(override)));
	}
	return MAX_FINALIZE_NUDGES;
}

/**
 * Device-held finalize retry: keep the run `running` under the same claim and
 * bump `approved_input.finalize_nudge_count` so the Mac app can re-spawn the
 * local CLI with a nudge. Unlike {@link requeueWatcherRunForFinalizeNudge}
 * (cloud: release claim → pending), this does not clear `claimed_by`.
 *
 * Returns false when the row is no longer `running` (another path won).
 */
export async function bumpDeviceFinalizeNudge(
	sql: DbClient,
	runId: number,
	nextNudgeCount: number,
	outputTail: string | null
): Promise<boolean> {
	const rows = (await sql`
    UPDATE runs
    SET approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        ),
        output_tail = ${outputTail},
        error_message = ${`Device CLI attempt ${nextNudgeCount}: completeWindow not called — resume allowed`}
    WHERE id = ${runId}
      AND status = 'running'
    RETURNING id
  `) as unknown as Array<{ id: number }>;
	return rows.length > 0;
}

export async function findWindowIdForRun(
	sql: DbClient,
	runId: number
): Promise<number | null> {
	// Canvas-on-events: a run produced a window iff a canvas chain member carries
	// this run_id (stamped atomically inside complete_window's tx). A fresh
	// completion stamps the ROOT; a replace_existing completion stamps the
	// superseding HEAD — so match ANY member and resolve the window identity via
	// metadata.root_event_id (a root omits it → its own id). Scoped to
	// canvas_state so it never matches tab_event/tab_snapshot BROWSER rows that
	// also carry run_id.
	const rows = await sql`
    SELECT COALESCE((metadata->>'root_event_id')::bigint, id) AS id
    FROM events
    WHERE run_id = ${runId}
      AND semantic_type = 'canvas_state'
    ORDER BY id DESC
    LIMIT 1
  `;

	return rows.length > 0 ? Number((rows[0] as { id: unknown }).id) : null;
}

/**
 * Mark a Behavior run completed, recording who executed it when the caller
 * knows.
 *
 * `complete_window` used to default `runs.model_used` to the literal
 * 'external-client' whenever its caller omitted `model`, and the platform's own
 * Lobu agent omits it — so server-dispatched runs were labelled as though an
 * outside MCP client had executed them. That label reads as an observation and
 * is not one: triaging the July 2026 Behavior collapse from this column
 * produced exactly that wrong conclusion.
 *
 * `fallbackModel` is the caller's assertion about the executor and is applied
 * ONLY over the placeholder or a NULL — a model the agent genuinely reported
 * always wins. Callers that cannot prove who executed the run must omit it
 * rather than guess: `reconcileWatcherRuns` sweeps active runs without
 * filtering on `dispatched_message_id`, so it can reach runs an external client
 * created, and stamping those would invert the very bug this fixes.
 *
 * (SQL comments are kept out of the template literal: a backtick inside one
 * terminates the string and fails the esbuild transform, not just at runtime.)
 */
export async function markWatcherRunCompleted(
	sql: DbClient,
	runId: number,
	windowId: number | null,
	fallbackModel?: string
): Promise<void> {
	await sql`
    UPDATE runs
    SET status = 'completed',
        window_id = ${windowId},
        completed_at = current_timestamp,
        error_message = NULL,
        model_used = COALESCE(
          NULLIF(model_used, 'external-client'),
          ${fallbackModel ?? null},
          model_used
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

async function markWatcherRunFailed(
	sql: DbClient,
	runId: number,
	message: string
): Promise<boolean> {
	return sql.begin(async (tx) => {
		const [failed] = await tx<{
			watcher_id: string | number | null;
			dispatch_source: string | null;
		}>`
      UPDATE runs
      SET status = 'failed',
          completed_at = current_timestamp,
          error_message = ${message}
      WHERE id = ${runId}
        AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      RETURNING watcher_id, approved_input->>'dispatch_source' AS dispatch_source
    `;
		if (!failed) return false;
		await advanceScheduleAfterTerminalFailure(
			tx,
			failed.watcher_id == null ? null : Number(failed.watcher_id),
			failed.dispatch_source
		);
		return true;
	});
}

/**
 * Reset a watcher run that missed `complete_window` back to `pending` so the
 * automation dispatch loop (`dispatchPendingWatcherRuns` → `claimWatcherRun`)
 * re-dispatches it for one more agent turn. Mirrors `resetOrphanedWatcherRuns`
 * (the proven re-dispatch shape) and records the attempt in
 * `approved_input.finalize_nudge_count` so it is strictly bounded. Status-
 * guarded so it can't resurrect an already-terminal run (replica-safe).
 */
async function requeueWatcherRunForFinalizeNudge(
	sql: DbClient,
	runId: number,
	nextNudgeCount: number
): Promise<void> {
	await sql`
    UPDATE runs
    SET status = 'pending',
        claimed_by = NULL,
        claimed_at = NULL,
        dispatched_message_id = NULL,
        error_message = NULL,
        approved_input = jsonb_set(
          COALESCE(approved_input, '{}'::jsonb),
          '{finalize_nudge_count}',
          to_jsonb(${nextNudgeCount}::int)
        )
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

export async function resolveWatcherRunsByMessageIds(
	messageIds: Iterable<string>,
	result: WatcherTerminalResult,
	db?: DbClient
): Promise<{ resolved: number }> {
	const ids = Array.from(new Set(Array.from(messageIds).filter(Boolean)));
	if (ids.length === 0) return { resolved: 0 };

	const sql = db ?? getDb();
	const rows = await sql`
    SELECT r.id, r.approved_input, w.execution_config
    FROM runs r
    LEFT JOIN watchers w ON w.id = r.watcher_id
    WHERE r.run_type = 'behavior'
      AND r.dispatched_message_id = ANY(${pgTextArray(ids)}::text[])
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

	let resolved = 0;
	for (const row of rows) {
		const typedRow = row as {
			id: unknown;
			approved_input: Record<string, unknown> | null;
			execution_config: Record<string, unknown> | null;
		};
		const runId = Number(typedRow.id);
		if (!Number.isFinite(runId)) continue;

		if (!result.ok) {
			if (await markWatcherRunFailed(sql, runId, result.error)) resolved++;
			continue;
		}

		if (typedRow.approved_input?.trigger_execution === "turn") {
			await markWatcherRunCompleted(sql, runId, null, "lobu-agent");
			resolved++;
			continue;
		}

		const windowId = await findWindowIdForRun(sql, runId);
		if (windowId === null) {
			// The agent replied but never called complete_window — a soft, usually
			// non-deterministic miss. Re-dispatch for one more turn (bounded by
			// finalize_nudge_count) before giving up. The budget is per-watcher
			// (execution_config.finalize_nudges) with a global fallback.
			const budget = resolveFinalizeNudgeBudget(typedRow.execution_config);
			const nudgeCount = Number(
				typedRow.approved_input?.finalize_nudge_count ?? 0
			);
			if (Number.isFinite(nudgeCount) && nudgeCount < budget) {
				await requeueWatcherRunForFinalizeNudge(sql, runId, nudgeCount + 1);
				logger.info(
					{ run_id: runId, attempt: nudgeCount + 1, max: budget },
					"[watchers] Agent finished without complete_window — re-dispatching for finalize nudge"
				);
				resolved++;
				continue;
			}

			if (
				await markWatcherRunFailed(
					sql,
					runId,
					await describeFinalizeMiss(sql, runId, budget)
				)
			) {
				resolved++;
			}
			continue;
		}

		await markWatcherRunCompleted(sql, runId, windowId, "lobu-agent");
		resolved++;
	}

	return { resolved };
}

async function describeFinalizeMiss(
	sql: DbClient,
	runId: number,
	budget: number
): Promise<string> {
	const attempts = budget > 0 ? ` after ${budget + 1} attempt(s)` : "";
	const agentMiss =
		"Agent reply finished without calling run_sdk (client.behaviors.completeWindow)" +
		attempts;
	let pending: Array<{ mcpId: string; toolName: string }>;
	try {
		pending = await listPendingToolsForRun(runId, sql);
	} catch (error) {
		logger.warn(
			{ error, run_id: runId },
			"[watchers] Could not check pending tool approvals for a finalize miss"
		);
		return (
			agentMiss +
			". Tool approval status could not be checked; inspect the warning log " +
			"before attributing the miss to the agent."
		);
	}

	if (pending.length > 0) {
		const tools = pending.map((p) => `${p.mcpId}/${p.toolName}`).join(", ");
		const grants = pending
			.map((p) => `/mcp/${p.mcpId}/tools/${p.toolName}`)
			.join(", ");
		return (
			`Behavior run blocked on tool approval${attempts}: ${tools} queued for ` +
			"human approval, so complete_window never ran. Headless Behavior runs " +
			`cannot answer approval cards; grant standing access (${grants}) and ` +
			"retry the Behavior."
		);
	}

	return (
		agentMiss +
		". No active tool approval was found, so check that the assigned agent has the " +
		"lobu-memory MCP attached and that query_sdk / run_sdk are available to it."
	);
}
