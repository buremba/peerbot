import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';

export type WatcherTerminalResult = { ok: true } | { ok: false; error: string };

async function findWindowIdForRun(sql: DbClient, runId: number): Promise<number | null> {
  const rows = await sql`
    SELECT id
    FROM watcher_windows
    WHERE run_id = ${runId}
    ORDER BY id DESC
    LIMIT 1
  `;

  return rows.length > 0 ? Number((rows[0] as { id: unknown }).id) : null;
}

async function markWatcherRunCompleted(
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

export async function resolveWatcherRunsByMessageIds(
  messageIds: Iterable<string>,
  result: WatcherTerminalResult,
  db?: DbClient
): Promise<{ resolved: number }> {
  const ids = Array.from(new Set(Array.from(messageIds).filter(Boolean)));
  if (ids.length === 0) return { resolved: 0 };

  const sql = db ?? getDb();
  const rows = await sql`
    SELECT id
    FROM runs
    WHERE run_type = 'watcher'
      AND dispatched_message_id = ANY(${ids}::text[])
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
  `;

  let resolved = 0;
  for (const row of rows) {
    const runId = Number((row as { id: unknown }).id);
    if (!Number.isFinite(runId)) continue;

    if (!result.ok) {
      await markWatcherRunFailed(sql, runId, result.error);
      resolved++;
      continue;
    }

    const windowId = await findWindowIdForRun(sql, runId);
    if (windowId === null) {
      await markWatcherRunFailed(
        sql,
        runId,
        'Agent reply finished without calling manage_watchers(action="complete_window"). ' +
          'Check that the assigned agent has the lobu-memory MCP attached and that read_knowledge / ' +
          'manage_watchers tools are approved for it.'
      );
      resolved++;
      continue;
    }

    await markWatcherRunCompleted(sql, runId, windowId);
    resolved++;
  }

  return { resolved };
}
