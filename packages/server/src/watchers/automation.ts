import { randomUUID } from 'node:crypto';
import { generateWorkerToken } from '@lobu/core';
import { inferWatcherGranularityFromSchedule } from '@lobu/connector-sdk';
import { intervals } from '../config/intervals';
import type { DbClient } from '../db/client';
import { getDb, pgTextArray } from '../db/client';
import { materializeDueItems } from '../scheduled/due-materializer';
import { markStaleRunsAsTimeout } from '../scheduled/stale-run-sweeper';
import { incrementCounter, setGauge } from '../gateway/metrics/prometheus';
import type { Env } from '../index';
import { isLobuGatewayRunning } from '../lobu/gateway';
import { getLobuServiceToken } from '../lobu/service-token';
import logger from '../utils/logger';
import { createWatcherRun, type WatcherRunPayload } from '../runs/queue-service';
import { ACTIVE_RUN_STATUSES, runStatusLiteral } from '../utils/run-statuses';
import { computePendingWindow } from '../utils/window-utils';
import {
  findWindowIdForRun,
  markWatcherRunCompleted,
  resolveWatcherRunsByMessageIds,
} from './run-completion';
import { nextRunAt } from '../utils/cron';
import { getErrorMessage } from "@lobu/core";

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
  /** Watcher is pinned to a user-owned device worker (e.g. Lobu Mac app). */
  device_worker_id?: string | null;
  /** Preferred local agent kind on the pinned device (e.g. 'claude-code'). */
  agent_kind?: string | null;
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

interface MaterializeDueWatcherRunsResult {
  dueWatchers: number;
  runsCreated: number;
  skipped: number;
  /** Due active watchers NOT scheduled because they have no runnable executor
   *  (no device pin AND no matching agents row). Surfaced so a misconfigured
   *  watcher whose agent was deleted is visible in the tick summary instead of
   *  silently never running. */
  unrunnable: number;
}

interface DispatchWatcherRunsResult {
  claimed: number;
  dispatched: number;
  reconciled: number;
  failed: number;
}

interface ReconcileWatcherRunsResult {
  reconciled: number;
}

interface QueueWatcherRunResult {
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

  // version_id was added when the watcher group-edit refactor introduced
  // a per-run version snapshot. Older runs (queued before the change) have
  // no version_id in approved_input — coerce to null and the agent loop
  // falls back to current_version_id, matching pre-refactor behavior.
  const rawVersionId = payload.version_id;
  const versionId =
    typeof rawVersionId === 'number' && Number.isFinite(rawVersionId)
      ? rawVersionId
      : typeof rawVersionId === 'string' && rawVersionId.trim() !== ''
        ? Number(rawVersionId)
        : null;

  const rawDeviceWorkerId = payload.device_worker_id;
  const deviceWorkerId =
    typeof rawDeviceWorkerId === 'string' && rawDeviceWorkerId.trim() !== ''
      ? rawDeviceWorkerId.trim()
      : null;
  const rawAgentKind = payload.agent_kind;
  const agentKind =
    typeof rawAgentKind === 'string' && rawAgentKind.trim() !== ''
      ? rawAgentKind.trim()
      : null;

  return {
    watcher_id: watcherId,
    agent_id: agentId,
    window_start: windowStart,
    window_end: windowEnd,
    dispatch_source: dispatchSource,
    version_id: Number.isFinite(versionId as number) ? (versionId as number) : null,
    device_worker_id: deviceWorkerId,
    agent_kind: agentKind,
  };
}

async function loadWatcherForAutomation(
  sql: DbClient,
  watcherId: number
): Promise<DueWatcherRow | null> {
  const rows = await sql<DueWatcherRow>`
    SELECT id, organization_id, agent_id, schedule, status,
           device_worker_id::text AS device_worker_id, agent_kind
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
      deviceWorkerId: watcher.device_worker_id ?? null,
      agentKind: watcher.agent_kind ?? null,
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

async function markWatcherRunFailedIdempotent(
  sql: DbClient,
  runId: number,
  message: string
): Promise<void> {
  const failedRows = await sql`
    UPDATE runs
    SET status = 'failed',
        completed_at = current_timestamp,
        error_message = ${message}
    WHERE id = ${runId}
      AND status IN ('running', 'claimed', 'pending')
    RETURNING watcher_id
  `;
  // Advance next_run_at on terminal failure too — otherwise a permanently
  // broken watcher re-materializes + re-dispatches a fresh agent run every
  // single minute forever (token/worker burn). Mirrors the feeds model: a
  // failed run still moves the schedule forward by its normal cadence.
  await advanceWatcherSchedule(sql, failedRows[0]?.watcher_id as number | undefined);
}

/**
 * Move a watcher's `next_run_at` forward by one cron tick. Reused by:
 *   - terminal-failure paths in this module (broken watcher shouldn't re-fire each minute)
 *   - manage_watchers(action="complete_window") on successful completion
 *   - the device-side `/api/workers/me/runs/:id/complete-watcher` endpoint
 *
 * Pass either the singleton `sql` client or a transaction handle from
 * `sql.begin(...)` to advance inside the caller's transaction. Schedule-less
 * watchers (manual-only) are no-ops. Read failures are logged and swallowed —
 * a missed schedule tick is preferable to failing the surrounding write.
 */
export async function advanceWatcherSchedule(
  sql: DbClient,
  watcherId: number | undefined
): Promise<void> {
  if (watcherId === undefined || watcherId === null) return;
  try {
    const rows = await sql`
      SELECT schedule, next_run_at
      FROM watchers
      WHERE id = ${watcherId}
      LIMIT 1
    `;
    const schedule = (rows[0]?.schedule as string | null) ?? null;
    if (!schedule) return;
    const currentNextRunAt = (rows[0]?.next_run_at as string | null) ?? null;
    const base = currentNextRunAt
      ? new Date(Math.max(Date.now(), new Date(currentNextRunAt).getTime()))
      : new Date();
    await sql`
      UPDATE watchers
      SET next_run_at = ${nextRunAt(schedule, base)}::timestamptz,
          updated_at = NOW()
      WHERE id = ${watcherId}
    `;
  } catch (err) {
    logger.warn(`[watchers] failed to advance next_run_at: ${err}`);
  }
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
    SELECT r.id, ww.id AS window_id
    FROM runs r
    JOIN watcher_windows ww ON ww.run_id = r.id
    WHERE r.run_type = 'watcher'
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
    ORDER BY r.created_at ASC
    LIMIT 100
  `;

  let reconciled = 0;

  for (const row of rows) {
    const runId = Number((row as { id: unknown }).id);
    const windowId = Number((row as { window_id: unknown }).window_id);

    await markWatcherRunCompleted(sql, runId, windowId);
    reconciled++;
  }

  // Find the (small) set of active watcher runs awaiting a dispatched
  // message. If there are none — the common steady state — skip the heavy
  // `chat_message` scan entirely instead of materializing every completed
  // thread-response run ever.
  const pendingDispatchRows = await sql`
    SELECT DISTINCT r.dispatched_message_id
    FROM runs r
    WHERE r.run_type = 'watcher'
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      AND r.dispatched_message_id IS NOT NULL
    LIMIT 200
  `;
  const pendingDispatchIds = pendingDispatchRows
    .map((row) => (row as { dispatched_message_id?: unknown }).dispatched_message_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (pendingDispatchIds.length === 0) {
    return { reconciled };
  }

  // Drive the containment join from the small side (the pending dispatch ids)
  // and bound the `chat_message` scan to recent completions — anything older
  // is already handled by `sweepStaleWatcherRuns`.
  const terminalRows = await sql`
    WITH response_payloads AS (
      SELECT
        CASE
          WHEN jsonb_typeof(action_input) = 'string' THEN (action_input #>> '{}')::jsonb
          ELSE action_input
        END AS payload
      FROM runs
      WHERE run_type = 'chat_message'
        AND queue_name = 'thread_response'
        AND status = 'completed'
        AND action_input IS NOT NULL
        AND completed_at > now() - interval '2 hours'
    )
    SELECT DISTINCT r.dispatched_message_id
    FROM runs r
    JOIN response_payloads rp
      ON rp.payload ? 'processedMessageIds'
     AND rp.payload->'processedMessageIds' ? r.dispatched_message_id
    WHERE r.run_type = 'watcher'
      AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
      AND r.dispatched_message_id = ANY(${pgTextArray(pendingDispatchIds)}::text[])
    ORDER BY r.dispatched_message_id ASC
    LIMIT 100
  `;

  const completedMessageIds = terminalRows
    .map((row) => (row as { dispatched_message_id?: unknown }).dispatched_message_id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (completedMessageIds.length > 0) {
    await resolveWatcherRunsByMessageIds(completedMessageIds, { ok: true }, sql);
    reconciled += completedMessageIds.length;
  }

  return { reconciled };
}

/**
 * Backstop for watcher runs that never reached terminal state.
 *
 * The primary lifecycle is driven by the durable resolution path — the API
 * response renderer calls resolveWatcherRunsByMessageIds on the terminal
 * thread_response event, on whichever replica claims it — plus startup
 * reconciliation on gateway boot. This sweeper catches stuck runs where no
 * terminal event was ever consumed (graceful shutdown mid-turn, queue message
 * silently dropped, the device executor crashing or its process being
 * abandoned, etc).
 *
 * Two reap paths, both keyed on the run's OWN liveness so they're correct
 * under N replicas (a run actively executing anywhere keeps its heartbeat
 * fresh, so no replica's sweep touches it):
 *
 *  1. Heartbeat-stale (fast, ~minutes): a run whose executor heartbeats —
 *     the device WatcherDispatcher beats every {@link WATCHER_HEARTBEAT_MS}ms
 *     during the turn — and has gone silent past the window. We require
 *     `last_heartbeat_at > claimed_at` (i.e. it beat at least once after being
 *     claimed) so this NEVER fires for a client that doesn't heartbeat: the
 *     claim sets `last_heartbeat_at == claimed_at`, so a non-heartbeating run
 *     stays equal and falls through to the coarse path. Fully backward
 *     compatible with older Mac apps.
 *  2. Coarse TTL (generous, 2h): the legacy backstop for runs that never
 *     heartbeat — measured from the claim/creation. Kept so a long but live
 *     non-heartbeating turn isn't killed prematurely.
 *
 * Both paths run through the shared `markStaleRunsAsTimeout` core
 * (scheduled/stale-run-sweeper.ts) with 'beat-after-claim' heartbeat
 * semantics; thresholds live in config/intervals.ts
 * (WATCHER_RUN_STALE_INTERVAL / WATCHER_RUN_HEARTBEAT_STALE_INTERVAL).
 */
export async function sweepStaleWatcherRuns(
  db?: DbClient
): Promise<{ timedOut: number }> {
  const sql = db ?? getDb();
  const heartbeatStaleInterval = intervals.watcherRunHeartbeatStaleInterval;
  const coarseStaleInterval = intervals.watcherRunStaleInterval;
  const timedOut = await markStaleRunsAsTimeout(sql, {
    runTypes: ['watcher'],
    heartbeatSemantics: 'beat-after-claim',
    heartbeatStaleInterval,
    coarseStaleInterval,
    heartbeatErrorMessage: `Watcher run heartbeat went silent for over ${heartbeatStaleInterval} — the executor crashed or was abandoned`,
    coarseErrorMessage: `Watcher run exceeded ${coarseStaleInterval} without reaching terminal state`,
  });
  if (timedOut > 0) {
    logger.warn({ timedOut }, '[watchers] Swept stale watcher runs');
  }
  return { timedOut };
}

/**
 * Recover scheduled watcher runs that were claimed by the dispatcher but
 * never transitioned to `running` (process crashed between claim and POST).
 * Run every watcher-automation tick — the staleness threshold means the
 * UPDATE is a no-op for rows currently being dispatched, so cross-pod
 * coordination via the runs-queue claim path is sufficient.
 *
 * Why this is narrow by design:
 * - `status='claimed'` only. `running` rows are NOT reset — in a multi-pod
 *   deployment another pod may be legitimately executing that agent turn,
 *   and we have no per-pod fencing (no worker_instance_id). Mid-turn crashes
 *   instead self-heal: sweepStaleWatcherRuns marks them `timeout` after 2h,
 *   then materializeDueWatcherRuns creates a fresh pending run on the next
 *   tick since next_run_at is still in the past.
 * - `claimed_at < now() - 5min` to avoid racing the dispatcher on a row it
 *   just claimed but hasn't yet moved to `running`.
 * - `dispatch_source='scheduled'` only. Manual triggers are not auto-retried;
 *   the caller would see the failure and decide whether to re-trigger.
 *
 * Module-private: `runWatcherAutomationTick` is the only driver. The
 * stale-claim threshold lives in config/intervals.ts
 * (WATCHER_ORPHANED_CLAIM_THRESHOLD, default 5 minutes).
 */
async function resetOrphanedWatcherRuns(
  db?: DbClient
): Promise<{ reset: number }> {
  const sql = db ?? getDb();
  const result = await sql`
    UPDATE runs
    SET status = 'pending',
        claimed_by = NULL,
        claimed_at = NULL,
        dispatched_message_id = NULL,
        error_message = NULL
    WHERE run_type = 'watcher'
      AND status = 'claimed'
      AND claimed_by = 'lobu-dispatcher'
      AND claimed_at < now() - ${intervals.watcherOrphanedClaimThreshold}::interval
      AND COALESCE(approved_input->>'dispatch_source', 'scheduled') = 'scheduled'
  `;
  const reset = Number(result.count ?? 0);
  if (reset > 0) {
    logger.info({ reset }, '[watchers] Reset orphaned watcher runs');
  }
  return { reset };
}

export async function materializeDueWatcherRuns(
  _env: Env,
  db?: DbClient
): Promise<MaterializeDueWatcherRunsResult> {
  const sql = db ?? getDb();

  let unrunnable = 0;

  const counts = await materializeDueItems<DueWatcherRow>({
    label: 'watcher-automation',
    fetchDue: async () => {
      // Only schedule watchers we can actually execute: either device-pinned (an
      // external/device worker claims it via the poll lane — no cloud agent row
      // needed) OR the assigned agent still exists in the org. A watcher whose
      // `agents` row was deleted is otherwise materialized every cron tick and fails
      // at dispatch ("Assigned agent ... does not exist"). Skipping at the source is
      // self-healing: it resumes automatically if the agent is recreated. The
      // dispatch-time `ensureWatcherAgentExists` check stays as a delete-after-select
      // backstop.
      const dueWatchers = await sql<DueWatcherRow>`
        SELECT w.id, w.organization_id, w.agent_id, w.schedule,
               w.device_worker_id::text AS device_worker_id, w.agent_kind
        FROM watchers w
        WHERE w.status = 'active'
          AND w.schedule IS NOT NULL
          AND w.next_run_at IS NOT NULL
          AND w.next_run_at <= current_timestamp
          AND (
            w.device_worker_id IS NOT NULL
            OR (
              w.agent_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM agents a
                WHERE a.id = w.agent_id
                  AND a.organization_id = w.organization_id
              )
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM runs r
            WHERE r.watcher_id = w.id
              AND r.run_type = 'watcher'
              AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
          )
        ORDER BY w.next_run_at ASC
        LIMIT 100
      `;

      // Count (cheap, tiny table) due active watchers that this tick filtered out
      // SOLELY for lacking a runnable executor — for visibility in the tick summary.
      // Mirrors the dueWatchers predicate (incl. the no-active-run clause) so a ghost
      // watcher that already has an in-flight run isn't double-counted here.
      const [unrunnableRow] = await sql<{ count: number }>`
        SELECT count(*)::int AS count
        FROM watchers w
        WHERE w.status = 'active'
          AND w.schedule IS NOT NULL
          AND w.next_run_at IS NOT NULL
          AND w.next_run_at <= current_timestamp
          AND w.device_worker_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM agents a
            WHERE a.id = w.agent_id
              AND a.organization_id = w.organization_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM runs r
            WHERE r.watcher_id = w.id
              AND r.run_type = 'watcher'
              AND r.status = ANY(${runStatusLiteral(ACTIVE_RUN_STATUSES)}::text[])
          )
      `;
      unrunnable = unrunnableRow?.count ?? 0;

      return dueWatchers;
    },
    createRun: async (watcher) => {
      const result = await enqueueWatcherRunForRecord(sql, watcher, 'scheduled');
      return result.created ? 'created' : 'skipped';
    },
    onError: async (watcher, error) => {
      logger.error(
        { error, watcherId: watcher.id },
        '[watcher-automation] Failed to materialize due watcher run'
      );
      // Don't leave next_run_at in the past — that would re-select this watcher
      // on every 60s tick. Push it forward per the watcher's cron schedule.
      await advanceWatcherSchedule(sql, watcher.id);
    },
  });

  return {
    dueWatchers: counts.due,
    runsCreated: counts.runsCreated,
    skipped: counts.skipped,
    unrunnable,
  };
}

interface WatcherAutomationTickResult {
  reset: number | null;
  reconciled: number | null;
  dueWatchers: number | null;
  runsCreated: number | null;
  skipped: number | null;
  unrunnable: number | null;
  claimed: number | null;
  dispatched: number | null;
  dispatchReconciled: number | null;
  failed: number | null;
  /** Phases that threw this tick (empty on a clean tick). */
  errors: string[];
}

/**
 * One watcher-automation tick: reset orphaned runs → reconcile in-flight →
 * materialize newly-due → dispatch pending. Each phase is isolated so a throw in
 * one cannot abort the others — the regression that wedged prod (lobu#1046) was a
 * throw in `reconcile` taking down `materialize`+`dispatch` for 12 days. Returns
 * a summary (nulls for phases that threw) plus the names of any failed phases.
 *
 * Extracted from the scheduler registration so the orchestration is unit/integration
 * testable without standing up the full TaskScheduler.
 */
export async function runWatcherAutomationTick(env: Env): Promise<WatcherAutomationTickResult> {
  const errors: string[] = [];
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(name);
      logger.error({ err, phase: name }, '[watcher-automation] phase failed');
      return null;
    }
  };

  const reset = await phase('reset', () => resetOrphanedWatcherRuns());
  const reconciliation = await phase('reconcile', () => reconcileWatcherRuns());
  const materialize = await phase('materialize', () => materializeDueWatcherRuns(env));
  const dispatch = await phase('dispatch', () => dispatchPendingWatcherRuns(env));

  // Emit health metrics. The scheduler-level success/error counter can't see
  // these because this tick swallows phase errors (returns them in `errors`),
  // so surface phase failures + materialization health explicitly for alerting.
  for (const failedPhase of errors) {
    incrementCounter('lobu_watcher_automation_phase_failures_total', { phase: failedPhase });
  }
  if (materialize?.runsCreated) {
    incrementCounter('lobu_watcher_runs_created_total', {}, materialize.runsCreated);
  }
  if (materialize) {
    setGauge('lobu_watchers_unrunnable', materialize.unrunnable);
  }

  return {
    reset: reset?.reset ?? null,
    reconciled: reconciliation?.reconciled ?? null,
    dueWatchers: materialize?.dueWatchers ?? null,
    runsCreated: materialize?.runsCreated ?? null,
    skipped: materialize?.skipped ?? null,
    unrunnable: materialize?.unrunnable ?? null,
    claimed: dispatch?.claimed ?? null,
    dispatched: dispatch?.dispatched ?? null,
    dispatchReconciled: dispatch?.reconciled ?? null,
    failed: dispatch?.failed ?? null,
    errors,
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

  // The version snapshot taken at run-creation time pins this run to a
  // specific watcher_template_versions row. Pass it to read_knowledge AND
  // complete_window so a group edit landing mid-run can't make the agent
  // extract with prompt v1 and have its output validated against schema v2.
  const versionPin = params.payload.version_id != null
    ? `, "template_version_id": ${params.payload.version_id}`
    : '';

  return [
    'Run this watcher now using the lobu-memory MCP tools.',
    '',
    `Watcher ID: ${params.watcherId}`,
    `Watcher run ID: ${params.runId}`,
    `Assigned agent ID: ${params.agentId}`,
    `Session agent ID: ${params.sessionAgentId}`,
    `Queued window start: ${params.payload.window_start}`,
    `Queued window end: ${params.payload.window_end}`,
    `Dispatch source: ${params.payload.dispatch_source}`,
    ...(params.payload.version_id != null
      ? [`Pinned template version id: ${params.payload.version_id}`]
      : []),
    '',
    'Required steps:',
    `1. Call read_knowledge with {"watcher_id": ${params.watcherId}, "since": "${readKnowledgeSince}", "until": "${readKnowledgeUntil}"${versionPin}}.`,
    '2. Analyze the returned content using prompt_rendered and extraction_schema.',
    `3. Call manage_watchers(action="complete_window") with the returned window_token, extracted_data, and "watcher_run_id": ${params.runId}${params.payload.version_id != null ? `, including "template_version_id": ${params.payload.version_id}` : ''}.`,
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
  await markWatcherRunFailedIdempotent(sql, runId, message);
}

async function claimWatcherRun(
  sql: DbClient,
  runId?: number
): Promise<ClaimedWatcherRunRow | null> {
  return sql.begin(async (tx) => {
    const specificRunClause = runId ? tx`AND r.id = ${runId}` : tx``;
    // Skip runs pinned to a device worker (#802): the user's Mac (or other
    // device) will claim these via /api/workers/poll. Without this filter the
    // server-side dispatcher races the device worker for the same row — the
    // exact failure mode that caused the watcher-run silent-success bug.
    // The pin currently lives in approved_input JSONB (issue #799 will add a
    // proper column); both shapes are guarded here so the filter survives
    // either schema.
    const claimed = await tx`
      WITH next_run AS (
        SELECT r.id
        FROM runs r
        WHERE r.run_type = 'watcher'
          AND r.status = 'pending'
          AND (
            r.approved_input->>'device_worker_id' IS NULL
            OR r.approved_input->>'device_worker_id' = ''
          )
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

const LOBU_MEMORY_MCP_ID = 'lobu-memory';
const WATCHER_REQUIRED_TOOLS = ['read_knowledge', 'manage_watchers'];

async function preflightWatcherMemoryTools(params: {
  port: string;
  organizationId: string;
  agentId: string;
  runId: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const conversationId = `${params.agentId}_watcher_${params.runId}_preflight`;
  const token = generateWorkerToken(params.agentId, conversationId, `watcher-${params.runId}`, {
    channelId: `api_watcher_${params.runId}`,
    agentId: params.agentId,
    organizationId: params.organizationId,
    platform: 'api',
    sessionKey: `watcher_${params.runId}`,
  });
  const url = `http://127.0.0.1:${params.port}/lobu/mcp/${LOBU_MEMORY_MCP_ID}/tools`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json().catch(() => null)) as
      | { tools?: Array<{ name?: unknown }>; error?: unknown }
      | null;

    if (!response.ok) {
      const detail = typeof body?.error === 'string' ? body.error : response.statusText;
      return {
        ok: false,
        error: `${LOBU_MEMORY_MCP_ID} tools preflight failed (${response.status}): ${detail}`,
      };
    }

    const toolNames = new Set(
      (body?.tools ?? [])
        .map((tool) => (typeof tool.name === 'string' ? tool.name : ''))
        .filter(Boolean)
    );
    const missing = WATCHER_REQUIRED_TOOLS.filter((name) => !toolNames.has(name));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `${LOBU_MEMORY_MCP_ID} tools preflight failed: missing ${missing.join(', ')}`,
      };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `${LOBU_MEMORY_MCP_ID} tools preflight failed: ${getErrorMessage(error)}`,
    };
  }
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

  // Already-produced window for this exact run (e.g. retry after crash).
  const existingWindowId = await findWindowIdForRun(sql, run.id);
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
  const preflight = await preflightWatcherMemoryTools({
    port,
    organizationId: run.organization_id,
    agentId: payload.agent_id,
    runId: run.id,
  });
  if (!preflight.ok) {
    await failWatcherRun(sql, run.id, preflight.error);
    return 'failed';
  }

  const baseUrl = `http://127.0.0.1:${port}/lobu/api/v1/agents`;
  const headers = {
    Authorization: `Bearer ${serviceToken}`,
    'Content-Type': 'application/json',
  };
  const messageId = randomUUID();

  try {
    const sessionResponse = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        agentId: payload.agent_id,
        userId: `watcher-${run.id}`,
        thread: `watcher-${run.id}`,
        forceNew: true,
        dryRun: false,
        intent: { kind: 'watcher_run', runId: run.id, watcherId: run.watcher_id },
      }),
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

    // Mark the run 'running' with a durable message correlation BEFORE posting,
    // so a late completion event arriving mid-POST has somewhere to land.
    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_by = ${`lobu:${payload.agent_id}`},
          dispatched_message_id = ${messageId},
          error_message = NULL
      WHERE id = ${run.id}
    `;

    const messageResponse = await fetch(messagesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messageId,
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
