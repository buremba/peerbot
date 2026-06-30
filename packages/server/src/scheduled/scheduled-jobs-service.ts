/**
 * scheduled_jobs CRUD + ticker.
 *
 * Model: a `scheduled_jobs` row is the *definition* of a recurring (or
 * one-shot) job. The ticker — registered as a TaskScheduler cron at
 * `* * * * *` — scans due rows and `scheduler.spawn`s a task per firing.
 * The actual handler execution rides on the existing runs-queue, with
 * claim/retry/idempotency/observability inherited.
 *
 * Firing flow:
 *   1. Tick claims rows WHERE next_run_at <= now AND NOT paused.
 *   2. For each row, spawn(action_type, action_args, { idempotencyKey, runAt: now }).
 *   3. Advance last_fired_at + next_run_at (or pause if one-shot completed).
 * If the tick crashes between step 2 and 3, the next tick re-reads the
 * same row (next_run_at not advanced) and re-spawns — idempotency dedup
 * stops duplicates. Self-healing.
 */

import { getDb } from '../db/client';
import { runtimeConnectionIdToSlug } from '../lobu/stores/connections-projection';
import { nextRunAt as nextCronTickAt } from '../utils/cron';
import logger from '../utils/logger';
import type { TaskScheduler } from './task-scheduler';
import { errorMessage } from '../utils/errors';

export interface ScheduledDeliveryContext {
  platform: string;
  conversationId: string;
  channelId: string;
  teamId?: string | null;
  connectionId: string;
  userId?: string | null;
}

/**
 * Chat platforms a scheduled wake can post its reply back into. Single source
 * of truth shared by the create-time gate (`manage_schedules`) and the
 * fire-time dispatch (`scheduled/jobs.ts`) so the two can never drift — a
 * platform accepted at creation but unhandled at execution would store a dead
 * `delivery_context` and silently fall back to the api path.
 */
export const DELIVERABLE_CHAT_PLATFORMS = ['slack', 'telegram'] as const;

export function isDeliverableChatPlatform(platform: string): boolean {
  return (DELIVERABLE_CHAT_PLATFORMS as readonly string[]).includes(platform);
}

export type DeliveryAuthzDenyReason =
  | 'connection-missing'
  | 'platform-changed'
  | 'connection-inactive'
  | 'agent-mismatch'
  | 'channel-unbound';

export type DeliveryAuthzResult =
  | { authorized: true }
  | { authorized: false; reason: DeliveryAuthzDenyReason };

/**
 * Is `agentId` authorized to deliver into the connection/channel named by a
 * delivery context? Single source of truth shared by the create-time gate
 * (`manage_schedules`, which maps the deny reason to a user-facing error) and
 * the fire-time re-check (`scheduled/jobs.ts`, which only needs the boolean).
 * Both must agree, and a cron can fire long after creation, so the same
 * validation runs at both points against the live connection + binding rows.
 */
export async function validateDeliveryAuthorization(params: {
  organizationId: string;
  agentId: string;
  delivery: ScheduledDeliveryContext;
}): Promise<DeliveryAuthzResult> {
  const sql = getDb();
  const { organizationId, agentId, delivery } = params;
  const connectionRows = (await sql`
    SELECT connector_key, agent_id, status
    FROM connections
    WHERE organization_id = ${organizationId}
      AND slug = ${runtimeConnectionIdToSlug(delivery.connectionId)}
      AND credential_mode IS NOT NULL
      AND deleted_at IS NULL
    LIMIT 1
  `) as unknown as Array<{
    connector_key: string;
    agent_id: string | null;
    status: string;
  }>;
  const connection = connectionRows[0];
  if (!connection) return { authorized: false, reason: 'connection-missing' };
  if (connection.connector_key !== delivery.platform) {
    return { authorized: false, reason: 'platform-changed' };
  }
  if (connection.status !== 'active') {
    return { authorized: false, reason: 'connection-inactive' };
  }
  if (connection.agent_id) {
    return connection.agent_id === agentId
      ? { authorized: true }
      : { authorized: false, reason: 'agent-mismatch' };
  }

  const bindingRows = delivery.teamId
    ? await sql`
        SELECT agent_id
        FROM agent_channel_bindings
        WHERE organization_id = ${organizationId}
          AND platform = ${delivery.platform}
          AND channel_id = ${delivery.channelId}
          AND team_id = ${delivery.teamId}
        LIMIT 1
      `
    : await sql`
        SELECT agent_id
        FROM agent_channel_bindings
        WHERE organization_id = ${organizationId}
          AND platform = ${delivery.platform}
          AND channel_id = ${delivery.channelId}
          AND team_id IS NULL
        LIMIT 1
      `;
  const binding = (bindingRows as unknown as Array<{ agent_id: string }>)[0];
  return binding?.agent_id === agentId
    ? { authorized: true }
    : { authorized: false, reason: 'channel-unbound' };
}

export interface ScheduledJobRow {
  id: string;
  organization_id: string;
  action_type: string;
  action_args: Record<string, unknown>;
  delivery_context: ScheduledDeliveryContext | null;
  cron: string | null;
  next_run_at: string;
  last_fired_at: string | null;
  last_fired_run_id: number | null;
  paused: boolean;
  description: string;
  created_by_user: string | null;
  created_by_agent: string | null;
  source_run_id: number | null;
  source_event_id: number | null;
  source_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateScheduledJobParams {
  organizationId: string;
  actionType: string;
  actionArgs: Record<string, unknown>;
  deliveryContext?: ScheduledDeliveryContext | null;
  description: string;
  cron?: string | null;
  runAt: Date;
  createdByUser?: string | null;
  createdByAgent?: string | null;
  sourceRunId?: number | null;
  sourceEventId?: number | null;
  sourceThreadId?: string | null;
}

export async function createScheduledJob(
  params: CreateScheduledJobParams
): Promise<ScheduledJobRow> {
  if (!params.createdByUser && !params.createdByAgent) {
    throw new Error('scheduled_jobs requires created_by_user or created_by_agent');
  }
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO scheduled_jobs (
      organization_id, action_type, action_args, delivery_context, cron, next_run_at,
      description,
      created_by_user, created_by_agent,
      source_run_id, source_event_id, source_thread_id
    ) VALUES (
      ${params.organizationId}, ${params.actionType},
      ${sql.json(params.actionArgs)}, ${params.deliveryContext ? sql.json(params.deliveryContext) : null}, ${params.cron ?? null}, ${params.runAt},
      ${params.description},
      ${params.createdByUser ?? null}, ${params.createdByAgent ?? null},
      ${params.sourceRunId ?? null}, ${params.sourceEventId ?? null},
      ${params.sourceThreadId ?? null}
    )
    RETURNING *
  `) as unknown as ScheduledJobRow[];
  return rows[0];
}

export async function listScheduledJobs(opts: {
  organizationId: string;
  createdByAgent?: string | null;
  createdByUser?: string | null;
  actionType?: string | null;
  includePaused?: boolean;
}): Promise<ScheduledJobRow[]> {
  const sql = getDb();
  const includePaused = opts.includePaused ?? true;
  return (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${opts.organizationId}
      AND (${opts.createdByAgent ?? null}::text IS NULL OR created_by_agent = ${opts.createdByAgent ?? null})
      AND (${opts.createdByUser ?? null}::text IS NULL OR created_by_user = ${opts.createdByUser ?? null})
      AND (${opts.actionType ?? null}::text IS NULL OR action_type = ${opts.actionType ?? null})
      AND (${includePaused} OR NOT paused)
    ORDER BY next_run_at ASC
  `) as unknown as ScheduledJobRow[];
}

export async function getScheduledJob(
  organizationId: string,
  id: string
): Promise<ScheduledJobRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    LIMIT 1
  `) as unknown as ScheduledJobRow[];
  return rows[0] ?? null;
}

export async function pauseScheduledJob(
  organizationId: string,
  id: string,
  paused: boolean
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    UPDATE scheduled_jobs
    SET paused = ${paused}, updated_at = now()
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function deleteScheduledJob(
  organizationId: string,
  id: string
): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM scheduled_jobs
    WHERE organization_id = ${organizationId} AND id = ${id}
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Register the per-minute tick. Call once during bootTaskScheduler.
 *
 * The handler claims due rows transactionally (FOR UPDATE SKIP LOCKED so
 * concurrent pods coordinate without an advisory lock), spawns one task
 * per row, and advances next_run_at. A handler crash leaves rows un-
 * advanced — next minute's tick retries them. Per-row idempotency key
 * `scheduled_job:<id>:<tick-iso>` deduplicates if the same row is read
 * twice across pods.
 */
export function registerScheduledJobsTicker(scheduler: TaskScheduler): void {
  scheduler.register(
    'scheduled-jobs-tick',
    async () => {
      const sql = getDb();
      const claimed = await sql.begin(async (tx) => {
        return (await tx`
          SELECT *
          FROM scheduled_jobs
          WHERE next_run_at <= now() AND NOT paused
          ORDER BY next_run_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 200
        `) as unknown as ScheduledJobRow[];
      });
      if (claimed.length === 0) return;

      for (const row of claimed) {
        const tickIso = row.next_run_at;
        const idempotencyKey = `scheduled_job:${row.id}:${tickIso}`;
        try {
          await scheduler.spawn(row.action_type, {
            ...row.action_args,
            __scheduled_job_id: row.id,
            __delivery_context: row.delivery_context,
            __scheduled_job_tick: tickIso,
            __organization_id: row.organization_id,
            __created_by_user: row.created_by_user,
            __created_by_agent: row.created_by_agent,
          }, { idempotencyKey });
        } catch (err) {
          logger.warn(
            { scheduled_job_id: row.id, err: errorMessage(err) },
            '[scheduled-jobs-tick] spawn failed; leaving next_run_at unchanged for retry'
          );
          continue;
        }
        // Advance OR pause-when-done depending on whether this is recurring.
        //
        // The claim transaction (FOR UPDATE SKIP LOCKED) commits when the
        // closure above returns, releasing the row locks BEFORE this advance
        // runs — so SKIP LOCKED gives no cross-pod exclusion during the
        // spawn+advance window. The spawn idempotency key collapses duplicate
        // tasks, but the advance itself must be conditional or two pods reading
        // the same pre-advance `next_run_at` can both write (and clobber a
        // concurrent pause/delete/re-schedule).
        //
        // Guard on `next_run_at <= now()` (same predicate as the claim SELECT),
        // NOT equality against the value we read: postgres.js parses
        // timestamptz to a millisecond-precision JS Date while the column
        // stores microseconds, so an equality round-trip silently never
        // matches for µs-precision rows — leaving them eternally due and
        // re-claimed every tick. `<= now()` is a no-op once any pod has
        // advanced the row (next_run_at is then in the future) and never
        // clobbers an operator re-schedule to a future time.
        const nextAt = row.cron ? nextCronTickAt(row.cron) : null;
        if (nextAt) {
          await sql`
            UPDATE scheduled_jobs
            SET last_fired_at = now(), next_run_at = ${nextAt}, updated_at = now()
            WHERE id = ${row.id} AND next_run_at <= now()
          `;
        } else {
          // One-shot: mark as fired + paused so the index ignores it.
          // Re-pausing an already-paused row is idempotent.
          await sql`
            UPDATE scheduled_jobs
            SET last_fired_at = now(), paused = true, updated_at = now()
            WHERE id = ${row.id} AND next_run_at <= now()
          `;
        }
      }
    },
    { cron: '* * * * *' }
  );
}
