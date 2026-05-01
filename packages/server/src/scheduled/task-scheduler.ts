/**
 * TaskScheduler — unified primitive for periodic + one-shot platform-internal
 * jobs.
 *
 * Why this exists
 * ---------------
 * Before this module, each "background job" picked its own pattern: most used
 * `setInterval` from `scheduled/jobs.ts`, some used the runs-queue, some used
 * advisory locks directly. That meant N different mental models for "do work
 * regularly" with no shared observability, no cross-pod coordination beyond
 * a hand-rolled advisory lock, and no idempotency on dispatch.
 *
 * The TaskScheduler collapses all of that into a single concept: every
 * platform-side scheduled or lazy job is a *task* with a registered handler.
 * Tasks live as rows in `public.runs` (run_type='task', queue_name='task'),
 * which gives us — for free — claim semantics, retry/backoff, heartbeats,
 * idempotency-key dedup, observability via the existing runs/operations
 * dashboards, and LISTEN/NOTIFY wakeups via the existing runs-queue.
 *
 * Two invocation patterns
 * -----------------------
 *  1. Periodic (cron): `scheduler.register('foo', fn, { cron: '* * * * *' })`.
 *     The scheduler keeps a stream of one row per cron tick in the runs
 *     table. Each tick has idempotency_key = 'cron:<name>:<iso-tick>' so
 *     N pods racing to seed the same tick produce exactly one row.
 *
 *  2. Lazy / on-demand: `scheduler.spawn('foo', payload, opts)`. Caller-driven
 *     dispatch with optional idempotency key. Useful when the platform wants
 *     "fire-and-forget durable work" — e.g. refresh a token, reconcile a
 *     specific entity. Many concurrent callers + same idempotency key →
 *     one row.
 *
 * Crash + retry semantics
 * -----------------------
 * Periodic runs schedule their NEXT tick *before* running the handler. So
 * if the handler crashes, the runs-queue retries the current row (existing
 * exponential backoff path); the next tick is already queued and unaffected.
 * A pod restart between ticks is also fine — at boot, every cron registration
 * tries to seed the next tick, and idempotency dedups against any seed an
 * earlier pod (or this pod's last lifetime) already inserted.
 */

import { createLogger } from '@lobu/core';
import * as Sentry from '@sentry/node';
import type { IMessageQueue, QueueJob } from '../gateway/infrastructure/queue/types';
import { nextRunAt } from '../utils/cron';

const logger = createLogger('task-scheduler');

const TASK_QUEUE_NAME = 'task';

export interface TaskContext<P = unknown> {
  /** Decoded task payload. */
  payload: P;
  /** runs.id — useful for correlating logs. */
  taskRunId: number;
}

export type TaskHandler<P = unknown> = (ctx: TaskContext<P>) => Promise<void>;

export interface SpawnOptions {
  /** Dedup key. While a row with this key is in (pending|claimed|running),
   *  spawn() is a no-op. */
  idempotencyKey?: string;
  /** Run no earlier than this absolute time. Default: now. */
  runAt?: Date;
  /** Override registration retryLimit. Default: 3. */
  maxAttempts?: number;
  /** Higher runs first. Default: 0. */
  priority?: number;
}

interface TaskJobData {
  name: string;
  payload: unknown;
  /** ISO timestamp of the cron tick this row represents. Set only on cron
   *  seeds (not on `spawn()` calls). Carrying it in the payload makes
   *  next-tick computation deterministic across pods regardless of local-
   *  clock drift: every claimer computes nextTick from this field, so the
   *  idempotency key for the next seed is identical for everyone, and dedup
   *  on the partial unique index wins. Computing nextTick from local
   *  `new Date()` would race the row's own claim window — if the pod's
   *  clock is slightly behind Postgres, `nextRunAt()` returns the SAME
   *  tick as the currently-claimed row, the seed conflicts, no new row is
   *  inserted, and the cron permanently stops. */
  __scheduledTick?: string;
}

interface TaskRegistration {
  name: string;
  handler: TaskHandler;
  cron?: string;
}

/** Cron seed key — per-tick so each scheduled fire produces exactly one row.
 *  Race-safe: N pods seeing "next tick is at T" all attempt insert with the
 *  same key; the partial unique index on idempotency_key admits exactly one. */
function cronSeedKey(name: string, tick: Date): string {
  return `cron:${name}:${tick.toISOString()}`;
}

export class TaskScheduler {
  private handlers = new Map<string, TaskRegistration>();
  private started = false;

  constructor(private readonly queue: IMessageQueue) {}

  /** Register a task handler. Call before `start()`. */
  register<P = unknown>(
    name: string,
    handler: TaskHandler<P>,
    opts?: { cron?: string },
  ): void {
    if (this.started) {
      throw new Error(
        `TaskScheduler.register("${name}") called after start(); register all tasks first`,
      );
    }
    if (this.handlers.has(name)) {
      throw new Error(`Task "${name}" already registered`);
    }
    this.handlers.set(name, {
      name,
      handler: handler as TaskHandler,
      cron: opts?.cron,
    });
  }

  /** Spawn a one-shot task invocation. */
  async spawn<P>(name: string, payload: P, opts?: SpawnOptions): Promise<string> {
    if (!this.handlers.has(name)) {
      throw new Error(`Cannot spawn unknown task "${name}"`);
    }
    const data: TaskJobData = { name, payload };
    const delayMs = opts?.runAt
      ? Math.max(0, opts.runAt.getTime() - Date.now())
      : 0;
    return this.queue.send(TASK_QUEUE_NAME, data, {
      singletonKey: opts?.idempotencyKey,
      delayMs,
      retryLimit: opts?.maxAttempts,
      priority: opts?.priority,
      actionKey: name,
    });
  }

  /** Start dispatching. Seeds the first tick for every cron-registered task,
   *  then registers the in-process handler with the runs-queue. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const reg of this.handlers.values()) {
      if (!reg.cron) continue;
      try {
        await this.seedNextCronTick(reg);
      } catch (err) {
        logger.error(
          { err, taskName: reg.name, cron: reg.cron },
          '[task-scheduler] Failed to seed cron row at boot',
        );
      }
    }

    await this.queue.work<TaskJobData>(TASK_QUEUE_NAME, (job) => this.dispatch(job));

    const periodic = [...this.handlers.values()].filter((r) => r.cron).length;
    logger.info(
      { total: this.handlers.size, periodic },
      '[task-scheduler] Started',
    );
  }

  /** Stop dispatching. The underlying queue handles in-flight drain on its
   *  own `stop()`; this just flips the local started flag. */
  stop(): void {
    this.started = false;
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async dispatch(job: QueueJob<TaskJobData>): Promise<void> {
    const data = job.data ?? ({ name: '', payload: {} } as TaskJobData);
    const reg = this.handlers.get(data.name);
    if (!reg) {
      logger.error(
        { taskName: data.name, runId: job.id },
        '[task-scheduler] No handler registered for task; failing run',
      );
      Sentry.captureMessage(
        `[task-scheduler] No handler for task "${data.name}" (run ${job.id})`,
        'error' as any,
      );
      throw new Error(`No handler registered for task "${data.name}"`);
    }

    // Periodic tasks: queue the next tick BEFORE running the handler. If
    // seeding fails, do NOT swallow — re-throw so the runs-queue marks this
    // row failed/retry; the retry path will re-attempt the seed before next
    // running the handler. Silent failure here would leave the cron stranded
    // with no successor row.
    //
    // Compute nextTick from the row's own scheduled tick (carried in payload)
    // not from local `new Date()`. See the comment on TaskJobData.__scheduledTick
    // for the clock-drift hazard this avoids.
    if (reg.cron) {
      const fromTick = data.__scheduledTick
        ? new Date(data.__scheduledTick)
        : new Date();
      // Add 1ms so nextRunAt skips past the current tick when fromTick falls
      // exactly on a cron boundary.
      await this.seedNextCronTick(reg, new Date(fromTick.getTime() + 1));
    }

    await reg.handler({
      payload: data.payload,
      taskRunId: Number(job.id),
    });
  }

  /** Insert (or no-op if already present) a row for this task's next cron
   *  tick after `from`. The idempotency key is per-tick so successive ticks
   *  each get a fresh row.
   *
   *  Throws on insert failure — callers (boot + dispatch) decide whether to
   *  surface or downgrade. The dispatch path re-throws so the run retries;
   *  the boot path logs and continues so a transient DB hiccup at boot
   *  doesn't crash the pod (next pod start retries via the same path). */
  private async seedNextCronTick(
    reg: TaskRegistration,
    from: Date = new Date(),
  ): Promise<void> {
    if (!reg.cron) return;
    const tick = new Date(nextRunAt(reg.cron, from));
    const delayMs = Math.max(0, tick.getTime() - Date.now());
    const data: TaskJobData = {
      name: reg.name,
      payload: {},
      __scheduledTick: tick.toISOString(),
    };
    await this.queue.send(TASK_QUEUE_NAME, data, {
      singletonKey: cronSeedKey(reg.name, tick),
      delayMs,
      actionKey: reg.name,
    });
  }
}
