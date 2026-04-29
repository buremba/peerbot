/**
 * Postgres `runs`-table-backed message queue.
 *
 * Phase 5 of the Redis -> Postgres migration: replaces BullMQ with a SKIP-
 * LOCKED claim loop on `public.runs`. The connector worker (run_type IN
 * 'sync', 'action', 'embed_backfill', 'watcher', 'auth') keeps its existing
 * HTTP-poll claim path; this queue strictly handles the lobu-queue lanes
 * ('chat_message', 'schedule', 'agent_run', 'internal').
 *
 * Wakeup is `pg_notify('runs_lobu_pending', '<run_type>')` on every send;
 * subscribers LISTEN on a dedicated long-lived `pg.Client` so the poll cadence
 * can stay slow (200ms) without sacrificing latency.
 *
 * The IMessageQueue interface still exposes `getRedisClient()` because many
 * non-queue consumers (secret-store, grant-store, scheduled-wakeup, cli-auth,
 * Slack OAuth state) read/write Redis directly. Phase 11 removes ioredis
 * entirely; until then this class still owns a Redis client for them.
 */

import { createLogger } from "@lobu/core";
import * as Sentry from "@sentry/node";
import { Redis } from "ioredis";
import { Client, Pool, type PoolConfig } from "pg";
import { getDb } from "../../../db/client.js";
import type {
  IMessageQueue,
  JobHandler,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./types.js";

const logger = createLogger("runs-queue");

/**
 * Per-queue_name NOTIFY channels. Phase 10: previously every queue's wakeup
 * fanned out to every worker via a single channel + run_type filter, which
 * made every chat_message worker wake on every chat_message insert
 * (thundering herd at scale). Channels are now keyed by queue_name, e.g.
 * `runs_lobu:chat_message:thread_response`, so the listener forwards a
 * NOTIFY only to the workers that actually want it.
 *
 * The base prefix is constant so the LISTEN side knows which channels to
 * subscribe to (one per worker registered).
 */
const NOTIFY_CHANNEL_PREFIX = "runs_lobu:";
function notifyChannelFor(queueName: string): string {
  // pg_notify channel names must be plain identifiers (or quoted). We pass
  // the channel name as a parameter to pg_notify so postgres will accept the
  // colon and slash characters; the LISTEN side quotes the identifier.
  return `${NOTIFY_CHANNEL_PREFIX}${queueName}`;
}
const POLL_INTERVAL_MS = 200;
const RECONNECT_DELAY_MS = 1000;
/** Backoff cap (seconds) when retrying a failed run. */
const MAX_BACKOFF_SECONDS = 300;
/** How often the stale-claim sweeper runs. */
const STALE_SWEEP_INTERVAL_MS = 30_000;
/** Phase 10: max time to wait for in-flight handlers during graceful stop. */
const SHUTDOWN_DRAIN_MS = 30_000;

/**
 * Phase 10: Sentry alert dedupe. Repeated heartbeat-failure / DLQ alerts
 * for the same runs.id within DEDUPE_WINDOW_MS collapse to a single
 * captureMessage call so a single bad row doesn't spam Sentry.
 */
const SENTRY_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const sentryAlertedRuns = new Map<number, number>();

function shouldEmitSentryAlert(runId: number): boolean {
  const now = Date.now();
  const last = sentryAlertedRuns.get(runId);
  if (last && now - last < SENTRY_DEDUPE_WINDOW_MS) return false;
  sentryAlertedRuns.set(runId, now);
  // Keep the map bounded — drop old entries opportunistically on writes.
  if (sentryAlertedRuns.size > 1000) {
    for (const [id, ts] of sentryAlertedRuns) {
      if (now - ts > SENTRY_DEDUPE_WINDOW_MS) sentryAlertedRuns.delete(id);
    }
  }
  return true;
}

/**
 * Per-tag Sentry dedupe for non-runId alerts (e.g. stale-claim sweeper).
 * Shared 5-minute window so a hot reclaim loop doesn't spam every 30s.
 */
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
 *  pending so a fresh claim can pick them up. Matches typical max agent-turn
 *  duration with a generous buffer. */
const CLAIM_VISIBILITY_TIMEOUT_MS = 5 * 60 * 1000;

/** Lobu-queue run types. Inserts/claims are restricted to these so connector
 *  lanes (sync, action, embed_backfill, watcher, auth) are never disturbed. */
const LOBU_RUN_TYPES = [
  "chat_message",
  "schedule",
  "agent_run",
  "internal",
] as const;

type LobuRunType = (typeof LOBU_RUN_TYPES)[number];

export interface RunsQueueConfig {
  /** Postgres connection string. Defaults to `process.env.DATABASE_URL`. */
  connectionString?: string;
  /** Optional Redis URL for backward-compat consumers (secret-store etc.).
   *  When omitted, falls back to `process.env.REDIS_URL`. */
  redisUrl?: string;
  /** Pool size for queue operations. */
  poolMax?: number;
  /** Per-queue concurrency. Default 1 — matches BullMQ's per-worker default. */
  defaultConcurrency?: number;
}

interface QueueWorker {
  queueName: string;
  runType: LobuRunType;
  handler: JobHandler<unknown>;
  concurrency: number;
  /** When true the poll loop sleeps without claiming. */
  paused: boolean;
  /** When true the loop exits on next tick. */
  stopped: boolean;
  /** Number of in-flight handler invocations. */
  active: number;
  /** Wake-up signal: a NOTIFY for this run_type sets this. The loop checks it
   *  to skip the poll-interval sleep. */
  wakeup: () => void;
  pendingWakeup: boolean;
}

/**
 * Map a queue name to a lobu-queue `run_type`. Every queue the gateway uses
 * (`messages`, `thread_message_<deploymentName>`, `thread_response`,
 * `messages:dlq`, `schedule:*`, …) collapses to one of the four lanes.
 *
 * The full queue name is preserved in `runs.queue_name` so the SKIP LOCKED
 * claim can scope to exactly the producer's queue.
 */
export function classifyQueue(queueName: string): LobuRunType {
  if (queueName.startsWith("schedule")) return "schedule";
  if (queueName === "agent_run" || queueName.startsWith("agent_run:"))
    return "agent_run";
  if (queueName.startsWith("internal")) return "internal";
  // `messages`, `thread_response`, `thread_message_*`, anything DLQ — all
  // chat-driven dispatch.
  return "chat_message";
}

/**
 * Compute the next-attempt delay for a failed run. Exponential, base 2 seconds,
 * capped at MAX_BACKOFF_SECONDS.
 */
export function backoffSeconds(attempt: number): number {
  const seconds = 2 ** Math.max(0, attempt);
  return Math.min(seconds, MAX_BACKOFF_SECONDS);
}

export class RunsQueue implements IMessageQueue {
  private pool: Pool | null = null;
  private listener: Client | null = null;
  /** Set when a reconnect timer is armed; lets us short-circuit overlapping
   *  reconnects. */
  private listenerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private listenerStopped = false;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private redisClient: Redis | null = null;
  private isConnected = false;
  /** Phase 10: set true on stop(); send/work check this and refuse new work. */
  private shuttingDown = false;

  /** Whether send() / work() should refuse new work because we're stopping. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Workers keyed by queue name. */
  private workers = new Map<string, QueueWorker>();
  /**
   * Per-channel subscribers. Phase 10: previously was per run_type; now keyed
   * by full per-queue_name channel so every NOTIFY only wakes the worker(s)
   * actually subscribed to that queue.
   */
  private subscribersByChannel = new Map<string, Set<QueueWorker>>();
  /** Channels we've already issued LISTEN on. */
  private listenedChannels = new Set<string>();

  private readonly poolMax: number;
  private readonly defaultConcurrency: number;
  private readonly connectionString: string;
  private readonly redisUrl: string | undefined;

  constructor(config: RunsQueueConfig = {}) {
    const cs = config.connectionString ?? process.env.DATABASE_URL;
    if (!cs) {
      throw new Error("RunsQueue: DATABASE_URL is required");
    }
    this.connectionString = cs;
    this.redisUrl = config.redisUrl ?? process.env.REDIS_URL;
    this.poolMax = config.poolMax ?? 5;
    this.defaultConcurrency = config.defaultConcurrency ?? 1;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isConnected) return;

    const ssl = pgSslOpt();
    const cfg: PoolConfig = {
      connectionString: this.connectionString,
      ssl,
      application_name: "owletto-runs-queue",
      max: this.poolMax,
      idleTimeoutMillis: 30_000,
    };
    this.pool = new Pool(cfg);
    this.pool.on("error", (err) => {
      logger.warn(`Pool idle client error: ${err.message}`);
    });

    // Backwards-compat Redis client for consumers that still call
    // `getRedisClient()`. Phase 11 removes this.
    if (this.redisUrl) {
      this.redisClient = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null,
      });
      // Prevent unhandled errors from crashing the process.
      this.redisClient.on("error", (err) => {
        logger.warn(`Redis client error: ${err.message}`);
      });
    } else {
      logger.warn(
        "REDIS_URL not configured; RunsQueue.getRedisClient() will throw"
      );
    }

    this.isConnected = true;
    this.listenerStopped = false;
    await this.connectListener();

    // Phase 10: startup recovery scan. Reset any rows orphaned by a hard
    // crash before SIGTERM ran (claimed/running, no recent heartbeat).
    await this.recoverStaleClaimedRowsOnStartup();

    this.startStaleSweep();
    logger.debug("Runs queue started");
  }

  /**
   * Phase 10: at startup, find rows in `claimed` or `running` state that
   * have no fresh claimed_at (older than 2× visibility timeout) and reset
   * them to pending. Catches rows orphaned by a hard crash before SIGTERM
   * ran (graceful shutdown's "release claimed rows" never executed).
   */
  private async recoverStaleClaimedRowsOnStartup(): Promise<void> {
    if (!this.pool) return;
    try {
      const result = await this.pool.query(
        `UPDATE public.runs
         SET status = 'pending',
             claimed_at = NULL,
             claimed_by = NULL,
             run_at = now()
         WHERE status IN ('claimed', 'running')
           AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal')
           AND (claimed_at IS NULL
                OR claimed_at < now() - ($1::int * interval '1 millisecond'))
         RETURNING id`,
        [CLAIM_VISIBILITY_TIMEOUT_MS * 2],
      );
      if (result.rowCount && result.rowCount > 0) {
        logger.warn(
          `Startup recovery: reclaimed ${result.rowCount} stale runs orphaned by crash`,
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
    this.listenerStopped = true;

    // Phase 10: graceful shutdown. Stop accepting new claims, wait for
    // in-flight handlers to finish (with a timeout), then release any
    // rows still in `claimed` state by this consumer back to `pending`.
    for (const w of this.workers.values()) {
      w.stopped = true;
      w.wakeup();
    }

    // Wait for in-flight handler runs to finish, up to SHUTDOWN_DRAIN_MS.
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
    // sweeper.
    if (this.pool) {
      try {
        const claimedBy = `gateway-${process.pid}`;
        const result = await this.pool.query(
          `UPDATE public.runs
           SET status = 'pending',
               claimed_at = NULL,
               claimed_by = NULL
           WHERE claimed_by = $1
             AND status = 'claimed'`,
          [claimedBy],
        );
        if (result.rowCount && result.rowCount > 0) {
          logger.info(
            `Released ${result.rowCount} claimed run(s) on shutdown`,
          );
        }
      } catch (err) {
        logger.warn(
          `Failed to release claimed rows on shutdown: ${(err as Error).message}`,
        );
      }
    }

    this.workers.clear();
    this.subscribersByChannel.clear();
    this.listenedChannels.clear();

    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
    if (this.listenerReconnectTimer) {
      clearTimeout(this.listenerReconnectTimer);
      this.listenerReconnectTimer = null;
    }
    if (this.listener) {
      try {
        await this.listener.end();
      } catch {
        // ignore
      }
      this.listener = null;
    }
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        // ignore
      }
      this.redisClient = null;
    }
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {
        // ignore
      }
      this.pool = null;
    }
    logger.debug("Runs queue stopped");
  }

  isHealthy(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Returns a Redis client for backward-compat consumers (secret-store,
   * grant-store, scheduled-wakeup, cli-auth, Slack OAuth state). This is NOT
   * used by the queue itself — pure ioredis for non-queue code paths until
   * Phase 11.
   */
  getRedisClient(): unknown {
    if (!this.redisClient) {
      throw new Error(
        "Redis client not configured. Set REDIS_URL on the RunsQueue config."
      );
    }
    return this.redisClient;
  }

  // ── Producer ────────────────────────────────────────────────────────────

  async createQueue(queueName: string): Promise<void> {
    // No-op — queues are virtual under the runs-table substrate; the row's
    // `queue_name` column is the only thing that distinguishes them. Kept for
    // IMessageQueue compat; tests and the code paths that pre-create queues
    // don't need to do anything here.
    if (!queueName) {
      throw new Error("queueName is required");
    }
  }

  async send<T>(
    queueName: string,
    data: T,
    options?: QueueOptions,
  ): Promise<string> {
    if (!this.pool) throw new Error("RunsQueue not started");
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
    const runAtSql = delayMs > 0
      ? `now() + ${Number(delayMs) / 1000}::float * interval '1 second'`
      : "now()";
    const expiresAtSql = expireInSeconds && expireInSeconds > 0
      ? `now() + ${Number(expireInSeconds)}::int * interval '1 second'`
      : "NULL";

    // Use a single round-trip: INSERT ... RETURNING id, and do the NOTIFY
    // *after* COMMIT (otherwise listeners may wake before the row is
    // visible).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // ON CONFLICT must match the index predicate exactly. The
      // `runs_idempotency_key_uniq` index is partial:
      //   WHERE idempotency_key IS NOT NULL
      //     AND status IN ('pending', 'claimed', 'running')
      // Rows whose status has already moved to a terminal value drop out of
      // the index, so a later enqueue with the same singleton key inserts a
      // fresh row instead of being silently swallowed.
      const sql = `
        INSERT INTO public.runs (
          run_type,
          queue_name,
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
          $1, $2, $3::jsonb, $4, $5, 0, 'pending', ${runAtSql}, $6, ${expiresAtSql}, $7
        )
        ON CONFLICT (idempotency_key)
          WHERE idempotency_key IS NOT NULL
            AND status IN ('pending', 'claimed', 'running')
        DO NOTHING
        RETURNING id
      `;
      const result = await client.query(sql, [
        runType,
        queueName,
        JSON.stringify(data ?? {}),
        idempotencyKey,
        maxAttempts,
        priority,
        retryDelaySeconds,
      ]);
      await client.query("COMMIT");

      // ON CONFLICT DO NOTHING: an active row already holds the key. Return
      // its id so callers always get something sensible back.
      let id: string;
      if (result.rows.length === 0 && idempotencyKey) {
        const existing = await client.query(
          `SELECT id FROM public.runs
           WHERE idempotency_key = $1
             AND status IN ('pending', 'claimed', 'running')
           ORDER BY id DESC
           LIMIT 1`,
          [idempotencyKey],
        );
        id = String(existing.rows[0]?.id ?? "");
      } else {
        id = String(result.rows[0].id);
      }

      // Wake listeners. Failure here is non-fatal — pollers will catch it on
      // the next tick. Phase 10: NOTIFY on the per-queue_name channel so
      // we don't fan out to every worker subscribed to this run_type.
      try {
        await client.query("SELECT pg_notify($1, $2)", [
          notifyChannelFor(queueName),
          queueName,
        ]);
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
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Consumer ────────────────────────────────────────────────────────────

  async work<T>(
    queueName: string,
    handler: JobHandler<T>,
    options?: { startPaused?: boolean },
  ): Promise<void> {
    if (!this.pool) throw new Error("RunsQueue not started");
    if (this.shuttingDown) {
      throw new Error("RunsQueue is shutting down; refusing new work");
    }

    // Replace any existing worker for this queue (matches RedisQueue behavior).
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
      concurrency: this.defaultConcurrency,
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

    // Register the worker against its per-queue_name channel and ensure the
    // listener has issued LISTEN for it.
    const channel = notifyChannelFor(queueName);
    let channelSet = this.subscribersByChannel.get(channel);
    if (!channelSet) {
      channelSet = new Set();
      this.subscribersByChannel.set(channel, channelSet);
    }
    channelSet.add(worker);
    await this.ensureChannelListened(channel);

    // Self-driving poll loop. Sleeps POLL_INTERVAL_MS between empty claims;
    // a NOTIFY for `runType` cuts the sleep short.
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
          // Run the handler without blocking the poll loop so concurrency > 1
          // can claim more rows.
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
    if (!this.pool) {
      return { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0)::int AS waiting,
         COALESCE(SUM(CASE WHEN status IN ('claimed','running') THEN 1 ELSE 0 END), 0)::int AS active,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)::int AS completed,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::int AS failed
       FROM public.runs
       WHERE queue_name = $1`,
      [queueName],
    );
    const row = result.rows[0] ?? {};
    return {
      waiting: Number(row.waiting ?? 0),
      active: Number(row.active ?? 0),
      completed: Number(row.completed ?? 0),
      failed: Number(row.failed ?? 0),
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Claim one row scoped to the worker's `queue_name` (or the run_type when
   *  the worker subscribes to all rows of a type — currently every worker is
   *  queue-scoped). Returns `null` if nothing was available.  */
  private async claimOne(worker: QueueWorker): Promise<{
    runId: number;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    retryDelaySeconds: number | null;
  } | null> {
    if (!this.pool) return null;
    const claimedBy = `gateway-${process.pid}`;
    const result = await this.pool.query(
      `WITH next_run AS (
         SELECT id FROM public.runs
         WHERE status = 'pending'
           AND run_type = $1
           AND queue_name = $2
           AND run_at <= now()
           AND (expires_at IS NULL OR expires_at > now())
         ORDER BY priority DESC, run_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE public.runs r
       SET status = 'claimed',
           claimed_at = now(),
           claimed_by = $3
       FROM next_run nr
       WHERE r.id = nr.id
       RETURNING r.id, r.action_input, r.attempts, r.max_attempts, r.retry_delay_seconds`,
      [worker.runType, worker.queueName, claimedBy],
    );
    const row = result.rows[0];
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
    }
  }

  private async markCompleted(runId: number): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'completed',
           completed_at = now()
       WHERE id = $1
         AND status = 'claimed'`,
      [runId],
    );
    queueBreadcrumb("complete", `Completed run ${runId}`, { runId });
  }

  private async markFailed(runId: number, err: unknown): Promise<void> {
    if (!this.pool) return;
    const message = err instanceof Error ? err.message : String(err);
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'failed',
           completed_at = now(),
           error_message = $2,
           attempts = attempts + 1
       WHERE id = $1
         AND status = 'claimed'`,
      [runId, message],
    );
    logger.warn(
      `Run ${runId} failed after retries: ${message}`,
    );
    // Phase 10: surface DLQ inserts as a Sentry warning. Debounced so a
    // hot-loop failure on one row doesn't spam Sentry.
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
    if (!this.pool) return;
    // Phase 10: when the caller specified a fixed retryDelay, use it
    // verbatim (constant backoff). Otherwise fall back to the existing
    // exponential cap-300s curve.
    const delay = retryDelaySeconds !== null
      ? Math.max(0, retryDelaySeconds)
      : backoffSeconds(attempt);
    await this.pool.query(
      `UPDATE public.runs
       SET status = 'pending',
           attempts = $2,
           run_at = now() + ($3::int * interval '1 second'),
           claimed_at = NULL,
           claimed_by = NULL
       WHERE id = $1
         AND status = 'claimed'`,
      [runId, attempt, delay],
    );
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
   * Issue LISTEN on the given channel if we haven't already. Phase 10:
   * each per-queue_name channel is dynamically subscribed when its first
   * worker registers.
   */
  private async ensureChannelListened(channel: string): Promise<void> {
    if (this.listenedChannels.has(channel)) return;
    this.listenedChannels.add(channel);
    if (!this.listener) return; // Will be picked up by reconnect.
    try {
      await this.listener.query(`LISTEN ${quoteIdent(channel)}`);
      logger.debug(`LISTEN ${channel}`);
    } catch (err) {
      logger.warn(
        `LISTEN ${channel} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Sleep for `ms` or until the worker's wakeup() is called or it stops.
   * The two callbacks let the caller capture the resolve fn so wakeup() can
   * cut the sleep short.
   */
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

  /**
   * Periodically sweep `runs` for rows that have been `claimed` longer than
   * `CLAIM_VISIBILITY_TIMEOUT_MS` and reset them to `pending` so another
   * worker can pick them up. This is the safety net for crashed gateway
   * processes.
   */
  private staleSweepInFlight = false;

  private startStaleSweep(): void {
    if (this.staleSweepTimer) return;
    const tick = async () => {
      if (!this.pool) return;
      if (this.staleSweepInFlight) return; // overlap guard
      this.staleSweepInFlight = true;
      try {
        const result = await this.pool.query(
          `UPDATE public.runs
           SET status = 'pending',
               claimed_at = NULL,
               claimed_by = NULL,
               run_at = now()
           WHERE status = 'claimed'
             AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal')
             AND claimed_at < now() - ($1::int * interval '1 millisecond')
           RETURNING id`,
          [CLAIM_VISIBILITY_TIMEOUT_MS],
        );
        if (result.rowCount && result.rowCount > 0) {
          logger.warn(
            `Reclaimed ${result.rowCount} stale runs (claimed > ${
              CLAIM_VISIBILITY_TIMEOUT_MS / 1000
            }s ago)`,
          );
          if (shouldEmitSentryAlertByTag("stale-claim-sweeper")) {
            try {
              Sentry.captureMessage(
                `Stale-claim sweeper reclaimed ${result.rowCount} run(s)`,
                { level: "warning", extra: { count: result.rowCount } },
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
    // Kick off immediately so a fresh restart reclaims old rows without
    // waiting for the first interval.
    void tick();
    this.staleSweepTimer = setInterval(tick, STALE_SWEEP_INTERVAL_MS);
    this.staleSweepTimer.unref?.();
  }

  // ── Listener ────────────────────────────────────────────────────────────

  private async connectListener(): Promise<void> {
    if (this.listenerStopped) return;
    if (this.listener) return;

    const ssl = pgSslOpt();
    const client = new Client({
      connectionString: this.connectionString,
      ssl,
      application_name: "owletto-runs-queue-listener",
    });

    let connectFailed = false;
    client.on("notification", (msg) => {
      // Phase 10: NOTIFY arrives on a per-queue_name channel
      // (`runs_lobu:<queueName>`); the payload is the queue name (informational).
      const set = this.subscribersByChannel.get(msg.channel);
      if (!set) return;
      for (const w of set) w.wakeup();
    });
    client.on("error", (err: Error) => {
      if (this.listener !== client) {
        connectFailed = true;
        return;
      }
      this.handleListenerDisconnect(err);
    });
    client.on("end", () => {
      if (this.listener !== client) {
        connectFailed = true;
        return;
      }
      this.handleListenerDisconnect(new Error("listener ended"));
    });

    try {
      await client.connect();
      if (connectFailed) {
        throw new Error("listener failed before LISTEN");
      }
      // Phase 10: subscribe to every per-queue channel any registered
      // worker cares about. New workers added later trigger
      // `ensureChannelListened` which issues LISTEN against this same client.
      for (const channel of this.listenedChannels) {
        await client.query(`LISTEN ${quoteIdent(channel)}`);
      }
      if (this.listenerStopped) {
        await client.end().catch(() => {});
        return;
      }
      this.listener = client;
      logger.debug("RunsQueue listener connected");
    } catch (err) {
      try {
        await client.end();
      } catch {
        // ignore
      }
      this.handleListenerDisconnect(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private handleListenerDisconnect(error: Error): void {
    if (this.listenerStopped) return;
    if (!this.listener && !this.listenerReconnectTimer) {
      // First disconnect — schedule reconnect.
    }
    this.listener = null;
    if (this.listenerReconnectTimer) return;
    logger.warn(`RunsQueue listener disconnected: ${error.message}`);
    this.listenerReconnectTimer = setTimeout(() => {
      this.listenerReconnectTimer = null;
      if (this.listenerStopped) return;
      this.connectListener().catch((err) => {
        logger.warn(
          `RunsQueue listener reconnect failed: ${(err as Error).message}`,
        );
        this.handleListenerDisconnect(
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, RECONNECT_DELAY_MS);
    this.listenerReconnectTimer.unref?.();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function pgSslOpt() {
  return process.env.PGSSLMODE === "require" ||
    process.env.PGSSLMODE === "prefer"
    ? { rejectUnauthorized: false }
    : undefined;
}

function quoteIdent(name: string): string {
  // Allow letters/digits/underscore plus colon, slash, and hyphen so per-queue
  // channel names like `runs_lobu:chat_message` survive identifier quoting.
  if (!/^[a-zA-Z_][a-zA-Z0-9_:/\-]*$/.test(name)) {
    throw new Error(`Channel name must be a plain identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Phase 10: delete expired runs rows (caller-supplied `expires_at` window
 * crossed) AND completed/failed lobu-queue runs older than the configured
 * retention window. Called from the periodic ephemeral-table sweep.
 *
 * RUNS_RETENTION_DAYS env override (defaults to 30) so operators can tune
 * the window without a redeploy.
 */
export async function sweepCompletedRuns(): Promise<number> {
  const sql = getDb();
  const retentionDays = (() => {
    const raw = Number(process.env.RUNS_RETENTION_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  })();

  let total = 0;

  // Drop pending rows that ran past their TTL. Only `pending` — claimed/running
  // rows are in flight by a worker that owns retry/terminal accounting; the
  // claim filter already excludes them so the worker simply finishes its
  // current handler call. Killing a running row would orphan its in-memory
  // handler.
  const expired = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE expires_at IS NOT NULL
        AND expires_at <= now()
        AND status = 'pending'
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((expired[0] as { count?: number } | undefined)?.count ?? 0);

  // Drop terminated runs older than the retention window.
  const aged = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status IN ('completed', 'failed', 'cancelled', 'timed_out')
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${retentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((aged[0] as { count?: number } | undefined)?.count ?? 0);

  return total;
}
