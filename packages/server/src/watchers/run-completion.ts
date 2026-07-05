import type { DbClient } from '../db/client';
import { getDb, pgTextArray } from '../db/client';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import logger from '../utils/logger';

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
 * resolveFinalizeNudgeBudget). A declarative defineWatcher surface for it is
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
 */
function resolveFinalizeNudgeBudget(
  executionConfig: Record<string, unknown> | null | undefined
): number {
  const override = executionConfig?.finalize_nudges;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.min(5, Math.max(0, Math.floor(override)));
  }
  return MAX_FINALIZE_NUDGES;
}

export async function findWindowIdForRun(sql: DbClient, runId: number): Promise<number | null> {
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

export async function markWatcherRunCompleted(
  sql: DbClient,
  runId: number,
  windowId: number | null
): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'completed',
        window_id = ${windowId},
        completed_at = current_timestamp,
        error_message = NULL
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
}

async function markWatcherRunFailed(
  sql: DbClient,
  runId: number,
  message: string
): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'failed',
        completed_at = current_timestamp,
        error_message = ${message}
    WHERE id = ${runId}
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;
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
    WHERE r.run_type = 'watcher'
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
      await markWatcherRunFailed(sql, runId, result.error);
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
      const nudgeCount = Number(typedRow.approved_input?.finalize_nudge_count ?? 0);
      if (Number.isFinite(nudgeCount) && nudgeCount < budget) {
        await requeueWatcherRunForFinalizeNudge(sql, runId, nudgeCount + 1);
        logger.info(
          { run_id: runId, attempt: nudgeCount + 1, max: budget },
          '[watchers] Agent finished without complete_window — re-dispatching for finalize nudge'
        );
        resolved++;
        continue;
      }

      await markWatcherRunFailed(
        sql,
        runId,
        'Agent reply finished without calling manage_watchers(action="complete_window")' +
          (budget > 0 ? ` after ${budget + 1} attempt(s)` : '') +
          '. Check that the assigned agent has the lobu-memory MCP attached and that query_sdk / ' +
          'run_sdk tools are approved for it.'
      );
      resolved++;
      continue;
    }

    await markWatcherRunCompleted(sql, runId, windowId);
    resolved++;
  }

  return { resolved };
}
