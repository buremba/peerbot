import { inferWatcherGranularityFromSchedule } from '@lobu/owletto-sdk';
import type { DbClient } from '../db/client';
import { getDb } from '../db/client';
import type { Env } from '../index';
import { isLobuGatewayRunning } from '../lobu/gateway';
import { getLobuServiceToken } from '../lobu/service-token';
import logger from '../utils/logger';
import { createWatcherRun, type WatcherRunPayload } from '../utils/queue-helpers';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { computePendingWindow } from '../utils/window-utils';

type WatcherRunStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

interface DueWatcherRow {
  id: number;
  organization_id: string;
  agent_id: string;
  schedule: string | null;
  status?: string;
}

interface ClaimedWatcherRunRow {
  id: number;
  organization_id: string;
  watcher_id: number;
  approved_input: unknown;
}

interface ActiveWatcherRunInfo {
  run_id: number;
  watcher_id: number;
  status: WatcherRunStatus;
  error_message: string | null;
}

export interface MaterializeDueWatcherRunsResult {
  dueWatchers: number;
  runsCreated: number;
  skipped: number;
}

export interface DispatchWatcherRunsResult {
  claimed: number;
  dispatched: number;
  reconciled: number;
  failed: number;
}

export interface ReconcileWatcherRunsResult {
  reconciled: number;
}

export interface QueueWatcherRunResult {
  runId: number;
  status: string;
  created: boolean;
}

export function buildLatestWatcherRunJoinSql(watcherAlias = 'i', runAlias = 'wr'): string {
  return `
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.error_message, r.created_at, r.completed_at
      FROM runs r
      WHERE r.watcher_id = ${watcherAlias}.id
        AND r.run_type = 'watcher'
      ORDER BY
        CASE WHEN r.status IN ('pending', 'claimed', 'running') THEN 0 ELSE 1 END,
        r.created_at DESC
      LIMIT 1
    ) ${runAlias} ON true
  `.trim();
}

export function parseWatcherRunPayload(value: unknown): WatcherRunPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const payload = value as Record<string, unknown>;
  const watcherId = Number(payload.watcher_id);
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  const windowStart = typeof payload.window_start === 'string' ? payload.window_start.trim() : '';
  const windowEnd = typeof payload.window_end === 'string' ? payload.window_end.trim() : '';
  const dispatchSource = payload.dispatch_source;

  if (
    !Number.isFinite(watcherId) ||
    !agentId ||
    !windowStart ||
    !windowEnd ||
    (dispatchSource !== 'scheduled' && dispatchSource !== 'manual')
  ) {
    return null;
  }

  return {
    watcher_id: watcherId,
    agent_id: agentId,
    window_start: windowStart,
    window_end: windowEnd,
    dispatch_source: dispatchSource,
  };
}

export async function findWatcherWindowIdForPayload(
  sql: DbClient,
  payload: WatcherRunPayload
): Promise<number | null> {
  const rows = await sql`
    SELECT id
    FROM watcher_windows
    WHERE watcher_id = ${payload.watcher_id}
      AND window_start = ${payload.window_start}::timestamptz
      AND window_end = ${payload.window_end}::timestamptz
    ORDER BY id DESC
    LIMIT 1
  `;

  return rows.length > 0 ? Number((rows[0] as { id: unknown }).id) : null;
}

async function loadWatcherForAutomation(
  sql: DbClient,
  watcherId: number
): Promise<DueWatcherRow | null> {
  const rows = await sql<DueWatcherRow>`
    SELECT id, organization_id, agent_id, schedule, status
    FROM watchers
    WHERE id = ${watcherId}
    LIMIT 1
  `;

  return rows[0] ?? null;
}

async function enqueueWatcherRunForRecord(
  sql: DbClient,
  watcher: DueWatcherRow,
  dispatchSource: WatcherRunPayload['dispatch_source']
): Promise<QueueWatcherRunResult> {
  if ((watcher.status ?? 'active') !== 'active') {
    throw new Error(`Watcher ${watcher.id} is not active.`);
  }

  if (!watcher.agent_id) {
    throw new Error(`Watcher ${watcher.id} is not assigned to a Lobu agent.`);
  }

  const granularity = inferWatcherGranularityFromSchedule(watcher.schedule);
  const { windowStart, windowEnd } = await computePendingWindow(sql, watcher.id, granularity);

  const queued = await createWatcherRun(
    {
      organizationId: watcher.organization_id,
      watcherId: watcher.id,
      agentId: watcher.agent_id,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      dispatchSource,
    },
    sql
  );

  return queued;
}

export async function enqueueWatcherRunForWatcher(
  watcherId: number,
  dispatchSource: WatcherRunPayload['dispatch_source'],
  db?: DbClient
): Promise<QueueWatcherRunResult> {
  const sql = db ?? getDb();
  const watcher = await loadWatcherForAutomation(sql, watcherId);

  if (!watcher) {
    throw new Error(`Watcher ${watcherId} not found.`);
  }

  return enqueueWatcherRunForRecord(sql, watcher, dispatchSource);
}

async function markWatcherRunCompleted(
  sql: DbClient,
  runId: number,
  windowId: number
): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'completed',
        window_id = ${windowId},
        completed_at = current_timestamp,
        error_message = NULL
    WHERE id = ${runId}
  `;
}

export async function getWatcherRunInfo(
  runId: number,
  db?: DbClient
): Promise<ActiveWatcherRunInfo | null> {
  const sql = db ?? getDb();
  const rows = await sql`
    SELECT id as run_id, watcher_id, status, error_message
    FROM runs
    WHERE id = ${runId}
      AND run_type = 'watcher'
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  return {
    run_id: Number((rows[0] as { run_id: unknown }).run_id),
    watcher_id: Number((rows[0] as { watcher_id: unknown }).watcher_id),
    status: String((rows[0] as { status: unknown }).status) as WatcherRunStatus,
    error_message:
      typeof (rows[0] as { error_message: unknown }).error_message === 'string'
        ? String((rows[0] as { error_message: unknown }).error_message)
        : null,
  };
}

export async function reconcileWatcherRuns(db?: DbClient): Promise<ReconcileWatcherRunsResult> {
  const sql = db ?? getDb();
  const rows = await sql`
    SELECT id, approved_input
    FROM runs
    WHERE run_type = 'watcher'
      AND status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      AND approved_input IS NOT NULL
    ORDER BY created_at ASC
    LIMIT 100
  `;

  let reconciled = 0;

  for (const row of rows) {
    const runId = Number((row as { id: unknown }).id);
    const payload = parseWatcherRunPayload((row as { approved_input: unknown }).approved_input);
    if (!payload) continue;

    const windowId = await findWatcherWindowIdForPayload(sql, payload);
    if (!windowId) continue;

    await markWatcherRunCompleted(sql, runId, windowId);
    reconciled++;
  }

  return { reconciled };
}

export async function materializeDueWatcherRuns(
  _env: Env,
  db?: DbClient
): Promise<MaterializeDueWatcherRunsResult> {
  const sql = db ?? getDb();

  const dueWatchers = await sql<DueWatcherRow>`
    SELECT w.id, w.organization_id, w.agent_id, w.schedule
    FROM watchers w
    WHERE w.status = 'active'
      AND w.agent_id IS NOT NULL
      AND w.schedule IS NOT NULL
      AND w.next_run_at IS NOT NULL
      AND w.next_run_at <= current_timestamp
      AND NOT EXISTS (
        SELECT 1 FROM runs r
        WHERE r.watcher_id = w.id
          AND r.run_type = 'watcher'
          AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      )
    ORDER BY w.next_run_at ASC
    LIMIT 100
  `;

  if (dueWatchers.length === 0) {
    return { dueWatchers: 0, runsCreated: 0, skipped: 0 };
  }

  let runsCreated = 0;
  let skipped = 0;

  for (const watcher of dueWatchers) {
    try {
      const result = await enqueueWatcherRunForRecord(sql, watcher, 'scheduled');

      if (result.created) runsCreated++;
      else skipped++;
    } catch (error) {
      logger.error(
        { error, watcherId: watcher.id },
        '[watcher-automation] Failed to materialize due watcher run'
      );
    }
  }

  return {
    dueWatchers: dueWatchers.length,
    runsCreated,
    skipped,
  };
}

function buildDispatchMessage(params: {
  watcherId: number;
  runId: number;
  agentId: string;
  sessionAgentId: string;
  payload: WatcherRunPayload;
}): string {
  const readKnowledgeSince = new Date(params.payload.window_start).toISOString().split('T')[0];
  const readKnowledgeUntil = new Date(new Date(params.payload.window_end).getTime() - 1)
    .toISOString()
    .split('T')[0];

  return [
    'Run this Owletto watcher now using the Owletto MCP tools.',
    '',
    `Watcher ID: ${params.watcherId}`,
    `Watcher run ID: ${params.runId}`,
    `Assigned agent ID: ${params.agentId}`,
    `Session agent ID: ${params.sessionAgentId}`,
    `Queued window start: ${params.payload.window_start}`,
    `Queued window end: ${params.payload.window_end}`,
    `Dispatch source: ${params.payload.dispatch_source}`,
    '',
    'Required steps:',
    `1. Call read_knowledge with {"watcher_id": ${params.watcherId}, "since": "${readKnowledgeSince}", "until": "${readKnowledgeUntil}"}.`,
    '2. Analyze the returned content using prompt_rendered and extraction_schema.',
    '3. Call manage_watchers(action="complete_window") with the returned window_token and your extracted_data.',
    '4. Include this run_metadata object in complete_window exactly, and add any extra provider/job fields you know:',
    JSON.stringify(
      {
        executor: 'lobu-agent',
        agent_id: params.agentId,
        watcher_run_id: params.runId,
        dispatch_source: params.payload.dispatch_source,
        session_agent_id: params.sessionAgentId,
      },
      null,
      2
    ),
    '',
    'If there is no content, do not fabricate results.',
  ].join('\n');
}

async function failWatcherRun(sql: DbClient, runId: number, message: string): Promise<void> {
  await sql`
    UPDATE runs
    SET status = 'failed',
        completed_at = current_timestamp,
        error_message = ${message}
    WHERE id = ${runId}
  `;
}

async function claimWatcherRun(
  sql: DbClient,
  runId?: number
): Promise<ClaimedWatcherRunRow | null> {
  return sql.begin(async (tx) => {
    const specificRunClause = runId ? tx`AND r.id = ${runId}` : tx``;
    const claimed = await tx`
      WITH next_run AS (
        SELECT r.id
        FROM runs r
        WHERE r.run_type = 'watcher'
          AND r.status = 'pending'
          ${specificRunClause}
        ORDER BY r.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE runs r
      SET status = 'claimed',
          claimed_at = current_timestamp,
          claimed_by = 'lobu-dispatcher'
      FROM next_run nr
      WHERE r.id = nr.id
      RETURNING r.id, r.organization_id, r.watcher_id, r.approved_input
    `;

    if (claimed.length === 0) return null;

    return {
      id: Number((claimed[0] as { id: unknown }).id),
      organization_id: String((claimed[0] as { organization_id: unknown }).organization_id),
      watcher_id: Number((claimed[0] as { watcher_id: unknown }).watcher_id),
      approved_input: (claimed[0] as { approved_input: unknown }).approved_input,
    };
  });
}

async function ensureWatcherAgentExists(
  sql: DbClient,
  organizationId: string,
  agentId: string
): Promise<boolean> {
  const rows = await sql`
    SELECT 1
    FROM agents
    WHERE id = ${agentId}
      AND organization_id = ${organizationId}
    LIMIT 1
  `;

  return rows.length > 0;
}

async function dispatchWatcherRun(
  sql: DbClient,
  run: ClaimedWatcherRunRow
): Promise<'reconciled' | 'dispatched' | 'failed'> {
  const payload = parseWatcherRunPayload(run.approved_input);
  if (!payload) {
    await failWatcherRun(sql, run.id, 'Watcher run is missing a valid dispatch payload.');
    return 'failed';
  }

  const existingWindowId = await findWatcherWindowIdForPayload(sql, payload);
  if (existingWindowId) {
    await markWatcherRunCompleted(sql, run.id, existingWindowId);
    return 'reconciled';
  }

  if (!(await ensureWatcherAgentExists(sql, run.organization_id, payload.agent_id))) {
    await failWatcherRun(
      sql,
      run.id,
      `Assigned agent "${payload.agent_id}" does not exist in this organization.`
    );
    return 'failed';
  }

  if (!isLobuGatewayRunning()) {
    await failWatcherRun(sql, run.id, 'Embedded Lobu is not available.');
    return 'failed';
  }

  const serviceToken = await getLobuServiceToken(run.organization_id);
  if (!serviceToken) {
    await failWatcherRun(sql, run.id, 'Failed to generate an embedded Lobu service token.');
    return 'failed';
  }

  const port = process.env.PORT || '8787';
  const baseUrl = `http://127.0.0.1:${port}/lobu/api/v1/agents`;
  const headers = {
    Authorization: `Bearer ${serviceToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const sessionResponse = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: payload.agent_id }),
    });

    if (!sessionResponse.ok) {
      const body = await sessionResponse.text();
      await failWatcherRun(
        sql,
        run.id,
        `Failed to create or resume Lobu agent session (${sessionResponse.status}): ${body || 'unknown error'}`
      );
      return 'failed';
    }

    const sessionBody = (await sessionResponse.json()) as {
      agentId?: string;
      messagesUrl?: string;
    };
    const sessionAgentId = sessionBody.agentId?.trim();
    const messagesUrl = sessionBody.messagesUrl?.trim();

    if (!sessionAgentId || !messagesUrl) {
      await failWatcherRun(sql, run.id, 'Embedded Lobu returned an incomplete agent session.');
      return 'failed';
    }

    const messageResponse = await fetch(messagesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: buildDispatchMessage({
          watcherId: run.watcher_id,
          runId: run.id,
          agentId: payload.agent_id,
          sessionAgentId,
          payload,
        }),
      }),
    });

    if (!messageResponse.ok) {
      const body = await messageResponse.text();
      await failWatcherRun(
        sql,
        run.id,
        `Failed to enqueue Lobu watcher message (${messageResponse.status}): ${body || 'unknown error'}`
      );
      return 'failed';
    }

    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_by = ${`lobu:${payload.agent_id}`},
          error_message = NULL
      WHERE id = ${run.id}
    `;

    return 'dispatched';
  } catch (error) {
    await failWatcherRun(
      sql,
      run.id,
      error instanceof Error ? error.message : 'Unexpected Lobu dispatch failure.'
    );
    return 'failed';
  }
}

export async function dispatchPendingWatcherRuns(
  _env: Env,
  options?: { db?: DbClient; runIds?: number[] }
): Promise<DispatchWatcherRunsResult> {
  const sql = options?.db ?? getDb();
  const requestedRunIds = options?.runIds?.filter((value) => Number.isFinite(value)) ?? [];

  let claimed = 0;
  let dispatched = 0;
  let reconciled = 0;
  let failed = 0;

  if (requestedRunIds.length > 0) {
    for (const runId of requestedRunIds) {
      const run = await claimWatcherRun(sql, runId);
      if (!run) continue;

      claimed++;
      const outcome = await dispatchWatcherRun(sql, run);
      if (outcome === 'dispatched') dispatched++;
      if (outcome === 'reconciled') reconciled++;
      if (outcome === 'failed') failed++;
    }

    return { claimed, dispatched, reconciled, failed };
  }

  while (claimed < 100) {
    const run = await claimWatcherRun(sql);
    if (!run) break;

    claimed++;
    const outcome = await dispatchWatcherRun(sql, run);
    if (outcome === 'dispatched') dispatched++;
    if (outcome === 'reconciled') reconciled++;
    if (outcome === 'failed') failed++;
  }

  return { claimed, dispatched, reconciled, failed };
}

export async function queueAndDispatchWatcherRun(
  watcherId: number,
  dispatchSource: WatcherRunPayload['dispatch_source'],
  env: Env,
  db?: DbClient
): Promise<{
  runId: number;
  status: string;
  created: boolean;
  dispatch: DispatchWatcherRunsResult;
}> {
  const sql = db ?? getDb();
  const queued = await enqueueWatcherRunForWatcher(watcherId, dispatchSource, sql);
  const dispatch = await dispatchPendingWatcherRuns(env, { db: sql, runIds: [queued.runId] });
  const runInfo = await getWatcherRunInfo(queued.runId, sql);

  return {
    runId: queued.runId,
    status: runInfo?.status ?? queued.status,
    created: queued.created,
    dispatch,
  };
}
