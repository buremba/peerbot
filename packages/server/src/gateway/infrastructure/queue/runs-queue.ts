/**
 * Postgres `runs`-table-backed message queue.
 *
 * SKIP-LOCKED claim loop on `public.runs`. The connector worker (run_type IN
 * 'sync', 'action', 'embed_backfill', 'watcher', 'auth') keeps its existing
 * HTTP-poll claim path; this queue strictly handles the lobu-queue lanes
 * ('chat_message', 'schedule', 'agent_run', 'internal').
 *
 * Wakeup is `pg_notify('runs_lobu:<queue_name>', '<run_type>')` on every send;
 * subscribers register via the shared `getRawDb().listen()` socket so all
 * caches and the queue multiplex onto a single LISTEN connection per process.
 *
 * Connection model: this class does NOT open its own pool or LISTEN client.
 * - Read/write queries go through `getDb()` (postgres.js singleton, max 20).
 * - LISTEN goes through `getRawDb().listen(channel, fn)` (postgres.js
 *   internally maintains one shared listener Sql instance with max:1).
 * Reconnect/backoff is handled by postgres.js. We only re-issue LISTENs after
 * postgres.js's `onlisten` callback fires post-reconnect.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@lobu/core";
import * as Sentry from "@sentry/node";
import { getDb, getDbListener, type DbClient } from "../../../db/client.js";
import type {
  IMessageQueue,
  JobHandler,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./types.js";

const logger = createLogger("runs-queue");

/**
 * Per-queue_name NOTIFY channels keyed `runs_lobu:<queue_name>`. Avoids the
 * thundering herd that a single shared channel would cause: every worker
 * would wake on every insert regardless of which queue it owns.
 */
const NOTIFY_CHANNEL_PREFIX = "runs_lobu:";
function notifyChannelFor(queueName: string): string {
  return `${NOTIFY_CHANNEL_PREFIX}${queueName}`;
}
const POLL_INTERVAL_MS = 200;
/** Backoff cap (seconds) when retrying a failed run. */
const MAX_BACKOFF_SECONDS = 300;
/** How often the stale-claim sweeper runs. */
const STALE_SWEEP_INTERVAL_MS = 30_000;
/** Max time to wait for in-flight handlers during graceful stop. */
const SHUTDOWN_DRAIN_MS = 30_000;

/**
 * Sentry alert dedupe. Repeated heartbeat-failure / DLQ alerts for the same
 * runs.id within DEDUPE_WINDOW_MS collapse to a single captureMessage call
 * so a single bad row doesn't spam Sentry.
 */
const SENTRY_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const sentryAlertedRuns = new Map<number, number>();

function shouldEmitSentryAlert(runId: number): boolean {
  const now = Date.now();
  const last = sentryAlertedRuns.get(runId);
  if (last && now - last < SENTRY_DEDUPE_WINDOW_MS) return false;
  sentryAlertedRuns.set(runId, now);
  if (sentryAlertedRuns.size > 1000) {
    for (const [id, ts] of sentryAlertedRuns) {
      if (now - ts > SENTRY_DEDUPE_WINDOW_MS) sentryAlertedRuns.delete(id);
    }
  }
  return true;
}

const sentryAlertedTags = new Map<string, number>();

function shouldEmitSentryAlertByTag(tag: string): boolean {
  const now = Date.now();
  const last = sentryAlertedTags.get(tag);
  if (last && now - last < SENTRY_DEDUPE_WINDOW_MS) return false;
  sentryAlertedTags.set(tag, now);
  return true;
}

function queueBreadcrumb(
  category: string,
  message: string,
  data: Record<string, unknown>,
): void {
  try {
    Sentry.addBreadcrumb({
      category: `runs-queue.${category}`,
      level: "info",
      message,
      data,
    });
  } catch {
    // Sentry init may not be present in tests; ignore.
  }
}
/** Rows in `claimed` for longer than this without a heartbeat are reset to
 *  pending so a fresh claim can pick them up. The active handler heartbeats
 *  every CLAIM_HEARTBEAT_INTERVAL_MS (well under this timeout), so a live
 *  worker keeps its claim indefinitely; only crashed/wedged workers fall
 *  past the timeout. */
const CLAIM_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

/** How often an in-flight handler refreshes `claimed_at` to prove it's still
 *  alive. Must be << CLAIM_VISIBILITY_TIMEOUT_MS so the sweeper doesn't race
 *  a healthy handler. */
const CLAIM_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Lobu-queue run types. Inserts/claims are restricted to these so connector
 *  lanes (sync, action, embed_backfill, watcher, auth) are never disturbed. */
const LOBU_RUN_TYPES = [
  "chat_message",
  "schedule",
  "agent_run",
  "internal",
  "task",
] as const;

type LobuRunType = (typeof LOBU_RUN_TYPES)[number];

/** Per-queue concurrency for handler invocations. Hardcoded today; lift to a
 *  config knob if/when a queue legitimately needs >1. */
const DEFAULT_WORKER_CONCURRENCY = 1;

interface QueueWorker {
  queueName: string;
  runType: LobuRunType;
  handler: JobHandler<unknown>;
  concurrency: number;
  paused: boolean;
  stopped: boolean;
  active: number;
  wakeup: () => void;
  pendingWakeup: boolean;
}

/** Map a queue name to a lobu-queue `run_type`. */
export function classifyQueue(queueName: string): LobuRunType {
  if (queueName === "task" || queueName.startsWith("task:")) return "task";
  if (queueName.startsWith("schedule")) return "schedule";
  if (queueName === "agent_run" || queueName.startsWith("agent_run:"))
    return "agent_run";
  if (queueName.startsWith("internal")) return "internal";
  return "chat_message";
}

/** Compute the next-attempt delay for a failed run. Exponential, base 2 seconds,
 *  capped at MAX_BACKOFF_SECONDS. */
export function backoffSeconds(attempt: number): number {
  const seconds = 2 ** Math.max(0, attempt);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

export class RunsQueue implements IMessageQueue {
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;
  /** Set true on stop(); send/work check this and refuse new work. */
  private shuttingDown = false;

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Workers keyed by queue name. */
  private workers = new Map<string, QueueWorker>();
  /** Per-channel subscribers, keyed by full per-queue_name channel. */
  private subscribersByChannel = new Map<string, Set<QueueWorker>>();
  /** Active LISTEN subscriptions, keyed by channel. */
  private listenSubs = new Map<string, { unlisten: () => Promise<unknown> }>();

  /**
   * Per-process claim identity. UUID instead of `process.pid` because pids
   * collide across Kubernetes pods — two replicas can each have pid 42, and
   * filtering ownership by pid would let one pod's heartbeat / completion
   * silently mutate another pod's claim. Generated once at construction and
   * stamped into `claimed_by` on every claim; every subsequent ownership
   * mutation (heartbeat / mark-completed / mark-failed / schedule-retry /
   * shutdown release) MUST include `AND claimed_by = ${this.claimedBy}` to
   * prevent cross-pod ownership corruption.
   */
  private readonly claimedBy: string;

  constructor() {
    if (!process.env.DATABASE_URL) {
      throw new Error("RunsQueue: DATABASE_URL is required");
    }
    this.claimedBy = `gateway-${randomUUID()}`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isConnected) return;

    this.isConnected = true;
    this.shuttingDown = false;

    // Reset any rows orphaned by a hard crash before SIGTERM ran
    // (claimed/running with no recent heartbeat).
    await this.recoverStaleClaimedRowsOnStartup();

    this.startStaleSweep();
    logger.debug("Runs queue started");
  }

  /** At startup, reset rows orphaned by a hard crash. */
  private async recoverStaleClaimedRowsOnStartup(): Promise<void> {
    const sql = getDb();
    try {
      const recoveryWindowMs = CLAIM_VISIBILITY_TIMEOUT_MS * 2;
      const result = await sql`
        UPDATE public.runs
        SET status = 'pending',
            claimed_at = NULL,
            claimed_by = NULL,
            run_at = now()
        WHERE status IN ('claimed', 'running')
          AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
          AND (claimed_at IS NULL
               OR claimed_at < now() - (${recoveryWindowMs}::int * interval '1 millisecond'))
        RETURNING id
      `;
      if (result.count > 0) {
        logger.warn(
          `Startup recovery: reclaimed ${result.count} stale runs orphaned by crash`,
        );
      }
    } catch (err) {
      logger.warn(
        `Startup recovery scan failed: ${(err as Error).message}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;
    this.shuttingDown = true;

    // Graceful shutdown: stop accepting new claims, wait for in-flight
    // handlers to finish (with a timeout), then release any rows still in
    // `claimed` state by this consumer back to `pending`.
    for (const w of this.workers.values()) {
      w.stopped = true;
      w.wakeup();
    }

    const drainStart = Date.now();
    while (Date.now() - drainStart < SHUTDOWN_DRAIN_MS) {
      const inFlight = Array.from(this.workers.values()).reduce(
        (sum, w) => sum + w.active,
        0,
      );
      if (inFlight === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Release any rows still claimed by this process so a fresh gateway
    // can pick them up immediately rather than waiting for the stale
    // sweeper. Filter by our per-process claim identity so a sibling pod's
    // in-flight claims aren't released out from under it.
    try {
      const sql = getDb();
      const result = await sql`
        UPDATE public.runs
        SET status = 'pending',
            claimed_at = NULL,
            claimed_by = NULL
        WHERE claimed_by = ${this.claimedBy}
          AND status = 'claimed'
      `;
      if (result.count > 0) {
        logger.info(
          `Released ${result.count} claimed run(s) on shutdown`,
        );
      }
    } catch (err) {
      logger.warn(
        `Failed to release claimed rows on shutdown: ${(err as Error).message}`,
      );
    }

    this.workers.clear();
    this.subscribersByChannel.clear();

    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }

    // Tear down all LISTEN subscriptions on the shared postgres-js listener.
    const subs = Array.from(this.listenSubs.values());
    this.listenSubs.clear();
    for (const sub of subs) {
      try {
        await sub.unlisten();
      } catch {
        // ignore
      }
    }

    logger.debug("Runs queue stopped");
  }

  isHealthy(): boolean {
    return this.isConnected;
  }

  // ── Producer ────────────────────────────────────────────────────────────

  async createQueue(queueName: string): Promise<void> {
    if (!queueName) {
      throw new Error("queueName is required");
    }
  }

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions,
  ): Promise<string> {
    if (!this.isConnected) throw new Error("RunsQueue not started");
    if (this.shuttingDown) {
      throw new Error("RunsQueue is shutting down; refusing new work");
    }
    const runType = classifyQueue(queueName);
    const idempotencyKey = options?.singletonKey ?? null;
    const maxAttempts = options?.retryLimit ?? 3;
    const delayMs = options?.delayMs ?? 0;
    const priority = options?.priority ?? 0;
    const retryDelaySeconds = options?.retryDelay ?? null;
    const expireInSeconds = options?.expireInSeconds;
    const actionKey = options?.actionKey ?? null;
    const runAtSql = delayMs > 0
      ? `now() + ${Number(delayMs) / 1000}::float * interval '1 second'`
      : "now()";
    const expiresAtSql = expireInSeconds && expireInSeconds > 0
      ? `now() + ${Number(expireInSeconds)}::int * interval '1 second'`
      : "NULL";

    const sql = getDb();
    const actionInput = JSON.stringify(data ?? {});

    // Insert + ON-CONFLICT-fallback inside a single transaction so a race
    // between two enqueues with the same idempotency key resolves cleanly.
    // pg_notify happens AFTER commit (otherwise listeners may wake before
    // the row is visible).
    //
    // runAt/expires_at are interpolated as raw SQL fragments via two helpers
    // because postgres-js can't parameterize an `interval` argument that is
    // itself a JS number-of-ms — we just compose the SQL.
    const id = await sql.begin(async (tx: DbClient) => {
      // ON CONFLICT must match the index predicate exactly. The
      // `runs_idempotency_key_uniq` index is partial:
      //   WHERE idempotency_key IS NOT NULL
      //     AND status IN ('pending', 'claimed', 'running')
      // Rows whose status has already moved to a terminal value drop out of
      // the index, so a later enqueue with the same singleton key inserts a
      // fresh row instead of being silently swallowed.
      const result = await tx.unsafe<{ id: number | string }>(
        `INSERT INTO public.runs (
          run_type,
          queue_name,
          action_key,
          action_input,
          idempotency_key,
          max_attempts,
          attempts,
          status,
          run_at,
          priority,
          expires_at,
          retry_delay_seconds
        ) VALUES (
          $1, $2, $3, $4::jsonb, $5, $6, 0, 'pending', ${runAtSql}, $7, ${expiresAtSql}, $8
        )
        ON CONFLICT (idempotency_key)
          WHERE idempotency_key IS NOT NULL
            AND status IN ('pending', 'claimed', 'running')
        DO NOTHING
        RETURNING id`,
        [
          runType,
          queueName,
          actionKey,
          actionInput,
          idempotencyKey,
          maxAttempts,
          priority,
          retryDelaySeconds,
        ],
      );

      if (result.length === 0 && idempotencyKey) {
        const existing = await tx<{ id: number | string }>`
          SELECT id FROM public.runs
          WHERE idempotency_key = ${idempotencyKey}
            AND status IN ('pending', 'claimed', 'running')
          ORDER BY id DESC
          LIMIT 1
        `;
        return String(existing[0]?.id ?? "");
      }
      return String(result[0]?.id ?? "");
    });

    // Wake listeners post-commit. Failure here is non-fatal; pollers catch
    // it on the next tick.
    try {
      await sql`SELECT pg_notify(${notifyChannelFor(queueName)}, ${queueName})`;
    } catch (err) {
      logger.warn(
        `pg_notify failed for ${queueName}: ${(err as Error).message}`,
      );
    }

    queueBreadcrumb("enqueue", `Enqueued run ${id}`, {
      runId: id,
      queueName,
      runType,
      priority,
      idempotencyKey,
    });

    return id;
  }

  // ── Consumer ────────────────────────────────────────────────────────────

  async work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean },
  ): Promise<void> {
    if (!this.isConnected) throw new Error("RunsQueue not started");
    if (this.shuttingDown) {
      throw new Error("RunsQueue is shutting down; refusing new work");
    }

    // Replace any existing worker for this queue.
    const existing = this.workers.get(queueName);
    if (existing) {
      existing.stopped = true;
      this.removeFromChannelIndex(existing);
      existing.wakeup();
      this.workers.delete(queueName);
    }

    const runType = classifyQueue(queueName);
    let resolveWake: (() => void) | null = null;
    const worker: QueueWorker = {
      queueName,
      runType,
      handler: handler as JobHandler<unknown>,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
      paused: options?.startPaused ?? false,
      stopped: false,
      active: 0,
      pendingWakeup: false,
      wakeup: () => {
        worker.pendingWakeup = true;
        if (resolveWake) {
          const r = resolveWake;
          resolveWake = null;
          r();
        }
      },
    };
    this.workers.set(queueName, worker);

    const channel = notifyChannelFor(queueName);
    let channelSet = this.subscribersByChannel.get(channel);
    if (!channelSet) {
      channelSet = new Set();
      this.subscribersByChannel.set(channel, channelSet);
    }
    channelSet.add(worker);
    await this.ensureChannelListened(channel);

    // Self-driving poll loop. Sleeps POLL_INTERVAL_MS between empty claims;
    // a NOTIFY for the channel cuts the sleep short.
    const loop = async () => {
      while (!worker.stopped) {
        if (worker.paused) {
          await this.sleep(POLL_INTERVAL_MS, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        if (worker.active >= worker.concurrency) {
          await this.sleep(50, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
          continue;
        }
        try {
          const claimed = await this.claimOne(worker);
          if (!claimed) {
            await this.sleep(POLL_INTERVAL_MS, worker, () => {
              resolveWake = null;
            }, (resolve) => {
              resolveWake = resolve;
            });
            continue;
          }
          worker.active += 1;
          this.runHandler(worker, claimed).finally(() => {
            worker.active -= 1;
          });
        } catch (err) {
          logger.error(`Poll loop error for ${queueName}:`, err);
          await this.sleep(POLL_INTERVAL_MS, worker, () => {
            resolveWake = null;
          }, (resolve) => {
            resolveWake = resolve;
          });
        }
      }
    };
    void loop();
  }

  async pauseWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = true;
  }

  async resumeWorker(queueName: string): Promise<void> {
    const w = this.workers.get(queueName);
    if (!w) return;
    w.paused = false;
    w.wakeup();
  }

  async getQueueStats(queueName: string): Promise<QueueStats> {
    const sql = getDb();
    const rows = await sql<{
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS waiting,
        COALESCE(SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END), 0)::int AS active,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
      FROM public.runs
      WHERE queue_name = ${queueName}
    `;
    const row = rows[0] ?? {} as Partial<{
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    }>;
    return {
      waiting: Number(row.waiting ?? 0),
      active: Number(row.active ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Claim one row scoped to the worker's `queue_name`. */
  private async claimOne(worker: QueueWorker): Promise<{
    runId: number;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    retryDelaySeconds: number | null;
  } | null> {
    const sql = getDb();
    const claimedBy = this.claimedBy;
    const rows = await sql<{
      id: number | string;
      action_input: unknown;
      attempts: number | string;
      max_attempts: number | string;
      retry_delay_seconds: number | string | null;
    }>`
      WITH next_run AS (
        SELECT id FROM public.runs
        WHERE status = 'pending'
          AND run_type = ${worker.runType}
          AND queue_name = ${worker.queueName}
          AND run_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY priority DESC, run_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.runs r
      SET status = 'claimed',
          claimed_at = now(),
          claimed_by = ${claimedBy}
      FROM next_run nr
      WHERE r.id = nr.id
      RETURNING r.id, r.action_input, r.attempts, r.max_attempts, r.retry_delay_seconds
    `;
    const row = rows[0];
    if (!row) return null;
    queueBreadcrumb("claim", `Claimed run ${row.id}`, {
      runId: Number(row.id),
      queueName: worker.queueName,
      attempts: Number(row.attempts ?? 0),
    });
    return {
      runId: Number(row.id),
      payload: row.action_input,
      attempts: Number(row.attempts ?? 0),
      maxAttempts: Number(row.max_attempts ?? 3),
      retryDelaySeconds:
        row.retry_delay_seconds === null
          ? null
          : Number(row.retry_delay_seconds),
    };
  }

  private async runHandler(
    worker: QueueWorker,
    claimed: {
      runId: number;
      payload: unknown;
      attempts: number;
      maxAttempts: number;
      retryDelaySeconds: number | null;
    },
  ): Promise<void> {
    const job: QueueJob<unknown> = {
      id: String(claimed.runId),
      data: claimed.payload,
      name: worker.queueName,
    };
    const heartbeat = setInterval(() => {
      void this.heartbeatClaim(claimed.runId);
    }, CLAIM_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    try {
      await worker.handler(job);
      await this.markCompleted(claimed.runId);
    } catch (err) {
      const nextAttempt = claimed.attempts + 1;
      if (nextAttempt >= claimed.maxAttempts) {
        await this.markFailed(claimed.runId, err);
      } else {
        await this.scheduleRetry(
          claimed.runId,
          nextAttempt,
          claimed.retryDelaySeconds,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Refresh `claimed_at` so the stale-claim sweeper does not reclaim a row
   *  whose handler is still running. Filters on `claimed_by = ${this.claimedBy}`
   *  so a sibling pod that has since reclaimed this row (after a heartbeat
   *  gap → sweep → re-claim cycle) doesn't have its claim silently extended
   *  by ours. */
  private async heartbeatClaim(runId: number): Promise<void> {
    try {
      const sql = getDb();
      await sql`
        UPDATE public.runs
        SET claimed_at = now()
        WHERE id = ${runId}
          AND status = 'claimed'
          AND claimed_by = ${this.claimedBy}
      `;
    } catch (err) {
      logger.warn({ runId, err }, "runs-queue heartbeat failed");
    }
  }

  private async markCompleted(runId: number): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET status = 'completed',
          completed_at = now()
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    queueBreadcrumb("complete", `Completed run ${runId}`, { runId });
  }

  private async markFailed(runId: number, err: unknown): Promise<void> {
    const sql = getDb();
    const message = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE public.runs
      SET status = 'failed',
          completed_at = now(),
          error_message = ${message},
          attempts = attempts + 1
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    logger.warn(
      `Run ${runId} failed after retries: ${message}`,
    );
    if (shouldEmitSentryAlert(runId)) {
      try {
        Sentry.captureMessage(`Queue run failed after retries: ${runId}`, {
          level: "warning",
          extra: { runId, message },
        });
      } catch {
        // ignore
      }
    }
  }

  private async scheduleRetry(
    runId: number,
    attempt: number,
    retryDelaySeconds: number | null,
  ): Promise<void> {
    const sql = getDb();
    const delay = retryDelaySeconds !== null
      ? Math.max(0, retryDelaySeconds)
      : backoffSeconds(attempt);
    await sql`
      UPDATE public.runs
      SET status = 'pending',
          attempts = ${attempt},
          run_at = now() + (${delay}::int * interval '1 second'),
          claimed_at = NULL,
          claimed_by = NULL
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${this.claimedBy}
    `;
    queueBreadcrumb("retry", `Scheduled retry for run ${runId}`, {
      runId,
      attempt,
      delaySeconds: delay,
    });
  }

  private removeFromChannelIndex(worker: QueueWorker): void {
    const channel = notifyChannelFor(worker.queueName);
    const set = this.subscribersByChannel.get(channel);
    if (!set) return;
    set.delete(worker);
    if (set.size === 0) this.subscribersByChannel.delete(channel);
  }

  /**
   * Subscribe to a per-queue_name channel via the shared postgres-js
   * listener. Idempotent — repeat calls return immediately. postgres-js
   * handles disconnect/reconnect internally and re-LISTENs on its own;
   * callers don't need a reconnect timer.
   */
  private async ensureChannelListened(channel: string): Promise<void> {
    if (this.listenSubs.has(channel)) return;
    try {
      const sub = await getDbListener().listen(channel, () => {
        const set = this.subscribersByChannel.get(channel);
        if (!set) return;
        for (const w of set) w.wakeup();
      });
      this.listenSubs.set(channel, { unlisten: sub.unlisten });
      logger.debug(`LISTEN ${channel}`);
    } catch (err) {
      logger.warn(
        `LISTEN ${channel} failed: ${(err as Error).message}`,
      );
    }
  }

  /** Sleep for `ms` or until the worker's wakeup() is called or it stops. */
  private async sleep(
    ms: number,
    worker: QueueWorker,
    onClear: () => void,
    onCapture: (resolve: () => void) => void,
  ): Promise<void> {
    if (worker.pendingWakeup) {
      worker.pendingWakeup = false;
      return;
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        worker.pendingWakeup = false;
        onClear();
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      onCapture(finish);
      if (worker.stopped) finish();
    });
  }

  // ── Stale-claim recovery ────────────────────────────────────────────────

  private staleSweepInFlight = false;

  private startStaleSweep(): void {
    if (this.staleSweepTimer) return;
    const tick = async () => {
      if (this.staleSweepInFlight) return;
      this.staleSweepInFlight = true;
      try {
        const sql = getDb();
        // Threshold is a hard-coded constant; inline as a SQL literal so this
        // query has zero placeholders. Tagged-template parameter interpolation
        // here is unnecessary and trips a PGlite quirk where parameterized
        // RETURNING queries occasionally surface as "supplies N parameters but
        // statement requires 0" under embedded-compat (prepare:false).
        const thresholdMs = CLAIM_VISIBILITY_TIMEOUT_MS;
        const result = await sql.unsafe(
          `UPDATE public.runs
           SET status = 'pending',
               claimed_at = NULL,
               claimed_by = NULL,
               run_at = now()
           WHERE status = 'claimed'
             AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
             AND claimed_at < now() - (${thresholdMs} * interval '1 millisecond')
           RETURNING id`,
        );
        if (result.count > 0) {
          logger.warn(
            `Reclaimed ${result.count} stale runs (claimed > ${
              CLAIM_VISIBILITY_TIMEOUT_MS / 1000
            }s ago)`,
          );
          if (shouldEmitSentryAlertByTag("stale-claim-sweeper")) {
            try {
              Sentry.captureMessage(
                `Stale-claim sweeper reclaimed ${result.count} run(s)`,
                { level: "warning", extra: { count: result.count } },
              );
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        logger.warn(
          `Stale-claim sweep failed: ${(err as Error).message}`,
        );
      } finally {
        this.staleSweepInFlight = false;
      }
    };
    void tick();
    this.staleSweepTimer = setInterval(tick, STALE_SWEEP_INTERVAL_MS);
    this.staleSweepTimer.unref?.();
  }
}

/**
 * Delete expired runs rows AND completed/failed lobu-queue runs older than
 * the configured retention window. Called from the periodic ephemeral-table
 * sweep. RUNS_RETENTION_DAYS env override (defaults to 30).
 */
export async function sweepCompletedRuns(): Promise<number> {
  const sql = getDb();
  const retentionDays = (() => {
    const raw = Number(process.env.RUNS_RETENTION_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  })();

  let total = 0;

  const expired = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE expires_at IS NOT NULL
        AND expires_at <= now()
        AND status = 'pending'
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((expired[0] as { count?: number } | undefined)?.count ?? 0);

  const aged = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status IN ('completed', 'failed', 'cancelled', 'timeout')
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${retentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((aged[0] as { count?: number } | undefined)?.count ?? 0);

  return total;
}
