/**
 * Postgres `runs`-table-backed message queue.
 *
 * SKIP-LOCKED claim loop on `public.runs`. The connector worker (run_type IN
 * 'sync', 'action', 'embed_backfill', 'automation', 'auth') keeps its existing
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
import {
	AgentErrorCode,
	createLogger,
	ErrorCode,
	getErrorMessage,
	OrchestratorError,
} from "@lobu/core";
import * as Sentry from "@sentry/node";
import { intervals } from "../../../config/intervals.js";
import {
	getDb,
	getDbListener,
	type DbClient,
} from "../../../db/client.js";
import { incrementCounter } from "../../metrics/prometheus.js";
import { failAutomationParentRunFromQueue } from "../../../automations/run-completion.js";
import { AUTOMATION_RUN_TYPES_PG } from "../../../runs/run-types.js";
import { deploymentNameForLinkedChild } from "../../orchestration/deployment-identity.js";
import {
	failTurnIfPendingInTransaction,
	notifyThreadResponse,
} from "../../orchestration/turn-liveness.js";
import {
  isDeferralError,
  type IMessageQueue,
  type JobHandler,
  type QueueJob,
  type QueueOptions,
  type QueueStats,
} from "./types.js";

const logger = createLogger("runs-queue");

/**
 * Per-queue_name NOTIFY channels keyed `runs_lobu:<queue_name>`. Avoids the
 * thundering herd that a single shared channel would cause: every worker
 * would wake on every insert regardless of which queue it owns.
 */
const NOTIFY_CHANNEL_PREFIX = "runs_lobu:";
export function notifyChannelFor(queueName: string): string {
  return `${NOTIFY_CHANNEL_PREFIX}${queueName}`;
}
// Poll cadence lives in config/intervals.ts (`runsPollIntervalMs`),
// env-overridable.
/** Backoff cap (seconds) when retrying a failed run. */
const MAX_BACKOFF_SECONDS = 300;
/** How often the stale-claim sweeper runs. */
const STALE_SWEEP_INTERVAL_MS = 30_000;
/** Upper bound on graceful-shutdown drain before claims are released. */
const SHUTDOWN_DRAIN_MS = 30_000;
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

interface LinkedAutomationChild {
	id: number;
	queue_name: string;
	organization_id: string | null;
	parent_run_id: number;
	message_id: string | null;
	agent_id: string | null;
	user_id: string | null;
	conversation_id: string | null;
	channel_id: string | null;
	platform: string | null;
}

async function lockLinkedAutomationOwner(
	tx: DbClient,
	parentRunId: number,
	organizationId: string,
): Promise<void> {
	await tx`
		SELECT a.id
		FROM automations a
		JOIN public.runs parent
		  ON parent.automation_id = a.id
		 AND parent.organization_id = a.organization_id
		WHERE parent.id = ${parentRunId}
		  AND parent.organization_id = ${organizationId}
		  AND parent.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
		FOR UPDATE OF a
	`;
}

async function terminalizeLinkedAutomationParent(
	tx: DbClient,
	child: LinkedAutomationChild,
	message: string,
	code: AgentErrorCode,
): Promise<{ parentFailed: boolean; responseEmitted: boolean }> {
	const organizationId = child.organization_id?.trim();
	const messageId = child.message_id?.trim();
	if (!organizationId || !messageId) {
		return { parentFailed: false, responseEmitted: false };
	}
	await lockLinkedAutomationOwner(tx, child.parent_run_id, organizationId);
	const [parent] = await tx<{
		status: string;
		dispatched_message_id: string | null;
	}>`
		SELECT status, dispatched_message_id
		FROM public.runs
		WHERE id = ${child.parent_run_id}
		  AND run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
		  AND organization_id = ${organizationId}
		FOR UPDATE
	`;
	if (
		!parent ||
		!['pending', 'claimed', 'running'].includes(parent.status) ||
		parent.dispatched_message_id !== messageId
	) {
		return { parentFailed: false, responseEmitted: false };
	}

	let responseEmitted = false;
	if (
		child.queue_name.startsWith("thread_message_") ||
		child.queue_name === "messages"
	) {
		const deploymentName = deploymentNameForLinkedChild(child, organizationId);
		if (!deploymentName) {
			return { parentFailed: false, responseEmitted: false };
		}
		responseEmitted = await failTurnIfPendingInTransaction(tx, {
			deploymentName,
			messageId,
			organizationId,
			code,
		});
		if (!responseEmitted && child.queue_name.startsWith("thread_message_")) {
			return { parentFailed: false, responseEmitted: false };
		}
		if (!responseEmitted) {
			const recorded = await tx`
				SELECT 1
				FROM agent_run_input
				WHERE organization_id = ${organizationId}
				  AND deployment_name = ${deploymentName}
				  AND message_id = ${messageId}
				LIMIT 1
			`;
			if (recorded.length > 0) {
				return { parentFailed: false, responseEmitted: false };
			}
		}
	} else {
		return { parentFailed: false, responseEmitted: false };
	}

	return {
		parentFailed: await failAutomationParentRunFromQueue(
			tx,
			child.parent_run_id,
			child.id,
			message,
		),
		responseEmitted,
	};
}
// Claim visibility timeout + heartbeat cadence live in config/intervals.ts
// (`runsClaimVisibilityTimeoutMs` / `runsClaimHeartbeatIntervalMs`),
// env-overridable. Rows in `claimed` for longer than the visibility timeout
// without a heartbeat are reset to pending so a fresh claim can pick them up;
// the active handler heartbeats well under the timeout, so a live worker
// keeps its claim indefinitely and only crashed/wedged workers fall past it.

/** Lobu-queue run types. Inserts/claims are restricted to these so connector
 *  lanes (sync, action, embed_backfill, automation, auth) are never disturbed. */
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
  generation: number;
  claiming: number;
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
      const recoveryWindowMs = intervals.runsClaimVisibilityTimeoutMs * 2;
      const result = await sql`
        UPDATE public.runs
        SET status = 'pending',
            claimed_at = NULL,
            claimed_by = NULL,
            run_at = now()
        WHERE status IN ('claimed', 'running')
          AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
          AND NOT (
            run_type = 'chat_message'
            AND COALESCE(
              action_input->'executionTarget'->>'kind' = 'device',
              false
            )
          )
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

    // Counting `claiming` as well as `active` is the fence: a worker that has
    // taken a row but not yet started its handler still owns it. The deadline
    // is what keeps that from turning a wedged handler into a shutdown that
    // never returns — drain is best-effort, and releaseAllClaims below hands
    // anything still held back to `pending` for the next gateway.
    const drainStart = Date.now();
    while (Date.now() - drainStart < SHUTDOWN_DRAIN_MS) {
      const inFlight = Array.from(this.workers.values()).reduce(
        (sum, w) => sum + w.claiming + w.active,
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
      const released = await this.releaseAllClaims();
      if (released > 0) {
        logger.info(
          `Released ${released} claimed run(s) on shutdown`,
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
    // Pass the payload object through postgres-js's `sql.json()` helper so
    // the driver sends it as a single-encoded JSONB value. The previous
    // shape — `JSON.stringify(data)` bound to a `$4::jsonb` parameter via
    // `tx.unsafe()` — round-tripped through Postgres as a JSONB *string*
    // (jsonb_typeof = 'string'), not a JSONB object. That broke every
    // downstream reader using `action_input ->> 'field'`, including the
    // snapshot-route ownership verifier in transcript-routes.ts.
    const actionInput = sql.json(data ?? {});

    // Populate runs.organization_id from the payload. This column is
    // preexisting (NOT from PR #870's denormalization — that one removed
    // agent_id+conversation_id only) and is the column the snapshot
    // verifier checks via `WHERE organization_id = $X` in
    // isRunOwnedByJwtScope. PR #873's denormalize revert accidentally
    // dropped organization_id from the INSERT alongside agent_id/
    // conversation_id, leaving the column NULL on every new chat_message
    // row. Result: verifier returned false for every snapshot POST,
    // workers rejected with 403 the moment Phase 5 flipped snapshot
    // mode to default. Re-add organization_id only.
    const organizationIdFromPayload =
      typeof (data as { organizationId?: unknown })?.organizationId ===
        "string" &&
      ((data as { organizationId?: string }).organizationId as string).length >
        0
        ? (data as { organizationId: string }).organizationId
        : null;
	const payloadObject =
	  typeof data === "object" && data !== null
		? (data as { parentRunId?: unknown })
		: null;
	// `!= null` on purpose: a caller spreading `parentRunId: undefined` (or the
	// `?? null` idiom used everywhere else for "no parent") means no parent, not
	// a malformed one. Only a present, non-null, unusable value fails closed.
	const parentWasRequested = payloadObject?.parentRunId != null;
	const requestedParentRunId = Number(payloadObject?.parentRunId);
    const hasRequestedParent =
      Number.isSafeInteger(requestedParentRunId) && requestedParentRunId > 0;

    // Insert + ON-CONFLICT-fallback inside a single transaction so a race
    // between two enqueues with the same idempotency key resolves cleanly.
    // pg_notify happens AFTER commit (otherwise listeners may wake before
    // the row is visible).
    //
    // runAt/expires_at are interpolated as raw SQL fragments via two helpers
    // because postgres-js can't parameterize an `interval` argument that is
    // itself a JS number-of-ms — we just compose the SQL.
    const id = await sql.begin(async (tx: DbClient) => {
      let parentRunId: number | null = null;
	  if (parentWasRequested && (!hasRequestedParent || !organizationIdFromPayload)) {
		throw new OrchestratorError(
		  ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
		  "Verified Automation parent link is malformed or missing organization scope",
		  { requestedParentRunId, organizationIdFromPayload },
		  false,
		);
	  }
	  if (hasRequestedParent && organizationIdFromPayload) {
		if (
			queueName !== "messages" &&
			!queueName.startsWith("thread_message_")
		) {
			throw new OrchestratorError(
				ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
				"Verified Automation parent links are only valid on message queues",
				{ queueName, requestedParentRunId },
				false,
			);
		}
		const requestedMessageId =
			typeof (data as { messageId?: unknown }).messageId === "string"
				? (data as { messageId: string }).messageId.trim()
				: "";
        const parent = await tx<{
			id: number | string;
			status: string;
			dispatched_message_id: string | null;
		}>`
          SELECT id, status, dispatched_message_id
          FROM public.runs
          WHERE id = ${requestedParentRunId}
			AND run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
            AND organization_id = ${organizationIdFromPayload}
          LIMIT 1
		  FOR UPDATE
        `;
        parentRunId = parent[0] ? Number(parent[0].id) : null;
        if (parentRunId == null) {
          throw new OrchestratorError(
            // The verified session intent named a parent that is no longer
            // active/owned. Retrying this enqueue cannot make that relation
            // valid and must not create an unlinked zombie child.
            ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
			"Verified Automation parent run does not exist in this organization",
            { requestedParentRunId, organizationIdFromPayload },
            false
          );
        }
		if (
			!requestedMessageId ||
			parent[0]?.dispatched_message_id !== requestedMessageId
		) {
			throw new OrchestratorError(
				ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
				"Verified Automation child message does not match its parent dispatch",
				{ requestedParentRunId, requestedMessageId },
				false,
			);
		}
		// Terminal-sticky idempotency: retries after an ambiguous HTTP response
		// reuse the first durable child even after it has completed/failed. The
		// parent row lock serializes concurrent POSTs for this exact dispatch.
		const existingChild = await tx<{ id: number | string }>`
			SELECT id
			FROM public.runs
			WHERE parent_run_id = ${parentRunId}
			  AND run_type = 'chat_message'
			  AND queue_name = ${queueName}
			  AND action_input->>'messageId' = ${requestedMessageId}
			ORDER BY id ASC
			LIMIT 1
		`;
		if (existingChild[0]) return String(existingChild[0].id);
		if (!['pending', 'claimed', 'running'].includes(parent[0]?.status ?? '')) {
			throw new OrchestratorError(
				ErrorCode.QUEUE_JOB_PROCESSING_FAILED,
				"Verified Automation parent run is no longer active",
				{ requestedParentRunId, organizationIdFromPayload },
				false,
			);
		}
      }
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
          retry_delay_seconds,
          organization_id,
          parent_run_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, 0, 'pending', ${runAtSql}, $7, ${expiresAtSql}, $8, $9, $10
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
          organizationIdFromPayload,
          parentRunId,
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

    // Re-register in place. The worker object is the serialization boundary;
    // reconnects update future handlers but never reset active state or start
    // a second poll loop.
    const existing = this.workers.get(queueName);
    if (existing) {
      existing.generation += 1;
      existing.handler = handler as JobHandler<unknown>;
      existing.concurrency = DEFAULT_WORKER_CONCURRENCY;
      existing.paused = options?.startPaused ?? false;
      existing.wakeup();
      await this.ensureChannelListened(notifyChannelFor(queueName));
      return;
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
      generation: 0,
      claiming: 0,
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

    // Self-driving poll loop. Sleeps `intervals.runsPollIntervalMs` between
    // empty claims;
    // a NOTIFY for the channel cuts the sleep short.
    const loop = async () => {
      while (!worker.stopped) {
        if (worker.paused) {
          await this.sleep(intervals.runsPollIntervalMs, worker, () => {
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
          const generation = worker.generation;
          const claimOwner = this.claimOwner(worker);
          worker.claiming += 1;
          let claimed: Awaited<ReturnType<RunsQueue["claimOne"]>> = null;
          try {
            claimed = await this.claimOne(worker, claimOwner);
          } finally {
            worker.claiming -= 1;
          }

          if (
            claimed &&
            (worker.stopped ||
              this.shuttingDown ||
              this.workers.get(queueName) !== worker ||
              worker.generation !== generation)
          ) {
            await this.releaseClaim(claimed.runId, claimed.claimOwner);
            claimed = null;
          }
          // There is no await between this fence and active++/runHandler().
          // A stale generation can therefore never cross the handler boundary.
          if (
            worker.stopped ||
            this.shuttingDown ||
            this.workers.get(queueName) !== worker ||
            worker.generation !== generation
          ) {
            if (claimed) await this.releaseClaim(claimed.runId, claimed.claimOwner);
            continue;
          }
          if (!claimed) {
            await this.sleep(intervals.runsPollIntervalMs, worker, () => {
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
          await this.sleep(intervals.runsPollIntervalMs, worker, () => {
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

  private claimOwner(worker: QueueWorker): string {
    return `${this.claimedBy}:${worker.queueName}:${worker.generation}`;
  }

  /** Claim one row scoped to the worker's `queue_name`. */
  private async claimOne(worker: QueueWorker, claimOwner: string): Promise<{
    runId: number;
    claimOwner: string;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    retryDelaySeconds: number | null;
  } | null> {
    const sql = getDb();
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
          -- Device-placed chat turns stay on the same messages/chat_message
          -- substrate, but are claimed by that device's worker poller. The
          -- gateway consumer must never race it for the same row.
          AND NOT (
            queue_name = 'messages'
            AND COALESCE(
              action_input->'executionTarget'->>'kind' = 'device',
              false
            )
          )
          AND run_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
		  AND (
		    -- Task parents are causal provenance, not a liveness lease. In
		    -- particular, complete_window commits an Automation's terminal state
		    -- and its durable reaction task together; requiring that completed
		    -- parent to remain active would strand every reaction forever.
		    run_type = 'task'
		    OR parent_run_id IS NULL
		    OR EXISTS (
		      SELECT 1
		      FROM public.runs parent
		      WHERE parent.id = public.runs.parent_run_id
		        AND parent.organization_id = public.runs.organization_id
		        AND parent.run_type = ANY(${AUTOMATION_RUN_TYPES_PG}::text[])
		        AND parent.status IN ('pending', 'claimed', 'running')
		        AND parent.dispatched_message_id = public.runs.action_input->>'messageId'
		    )
		  )
        ORDER BY priority DESC, run_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.runs r
      SET status = 'claimed',
          claimed_at = now(),
          claimed_by = ${claimOwner}
      FROM next_run nr
      WHERE r.id = nr.id
      RETURNING r.id, r.action_input, r.attempts, r.max_attempts, r.retry_delay_seconds
    `;
    const row = rows[0];
    if (!row) return null;
    queueBreadcrumb("claim", `Claimed run ${row.id}`, {
      runId: Number(row.id),
      claimOwner,
      queueName: worker.queueName,
      attempts: Number(row.attempts ?? 0),
    });
    return {
      runId: Number(row.id),
      claimOwner,
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
      claimOwner: string;
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
      attempt: claimed.attempts,
      maxAttempts: claimed.maxAttempts,
    };
    const heartbeat = setInterval(() => {
      void this.heartbeatClaim(claimed.runId, claimed.claimOwner);
    }, intervals.runsClaimHeartbeatIntervalMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    try {
      await worker.handler(job);
      await this.markCompleted(claimed.runId, claimed.claimOwner);
    } catch (err) {
      if (isDeferralError(err)) {
        // Waiting, not failing — reschedule without consuming an attempt
        // (see isDeferralError in types.ts for the contract).
        await this.scheduleRetry(
          claimed.runId,
          claimed.claimOwner,
          claimed.attempts,
          claimed.retryDelaySeconds,
        );
      } else {
        const nextAttempt = claimed.attempts + 1;
        const retryable =
          !(err instanceof OrchestratorError) || err.shouldRetry;
        if (!retryable || nextAttempt >= claimed.maxAttempts) {
          await this.markFailed(claimed.runId, claimed.claimOwner, err);
        } else {
          await this.scheduleRetry(
            claimed.runId,
            claimed.claimOwner,
            nextAttempt,
            claimed.retryDelaySeconds,
          );
        }
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
  private async heartbeatClaim(runId: number, claimOwner: string): Promise<void> {
    try {
      const sql = getDb();
      await sql`
        UPDATE public.runs
        SET claimed_at = now()
        WHERE id = ${runId}
          AND status = 'claimed'
          AND claimed_by = ${claimOwner}
      `;
    } catch (err) {
      logger.warn({ runId, err }, "runs-queue heartbeat failed");
    }
  }

  private async markCompleted(runId: number, claimOwner: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET status = 'completed',
          completed_at = now()
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${claimOwner}
    `;
    queueBreadcrumb("complete", `Completed run ${runId}`, { runId });
  }

  private async markFailed(
    runId: number,
    claimOwner: string,
    err: unknown,
  ): Promise<void> {
    const sql = getDb();
	const message = getErrorMessage(err);
	const outcome = await sql.begin(async (tx) => {
	  const [linkage] = await tx<{
		parent_run_id: number | string | null;
		organization_id: string | null;
	  }>`
		SELECT parent_run_id, organization_id
		FROM public.runs
		WHERE id = ${runId}
		  AND status = 'claimed'
		  AND claimed_by = ${claimOwner}
	  `;
	  const linkedParentId = Number(linkage?.parent_run_id);
	  const linkedOrganizationId = linkage?.organization_id?.trim();
	  if (
		Number.isSafeInteger(linkedParentId) &&
		linkedParentId > 0 &&
		linkedOrganizationId
	  ) {
		await lockLinkedAutomationOwner(tx, linkedParentId, linkedOrganizationId);
		await tx`SELECT id FROM public.runs WHERE id = ${linkedParentId} FOR UPDATE`;
	  }
      const failed = await tx`
        UPDATE public.runs
        SET status = 'failed',
            completed_at = now(),
            error_message = ${message},
            attempts = attempts + 1
        WHERE id = ${runId}
          AND status = 'claimed'
          AND claimed_by = ${claimOwner}
		RETURNING id, run_type, queue_name, organization_id, parent_run_id,
		          action_input->>'messageId' AS message_id,
		          action_input->>'agentId' AS agent_id,
		          action_input->>'userId' AS user_id,
		          action_input->>'conversationId' AS conversation_id,
		          action_input->>'channelId' AS channel_id,
		          action_input->>'platform' AS platform
      `;
	  const row = failed[0] as {
		id?: unknown;
		queue_name?: unknown;
		organization_id?: unknown;
		parent_run_id?: unknown;
		message_id?: unknown;
		agent_id?: unknown;
		user_id?: unknown;
		conversation_id?: unknown;
		channel_id?: unknown;
		platform?: unknown;
	  } | undefined;
      const parentRunId = Number(row?.parent_run_id);
	  let responseEmitted = false;
      if (Number.isSafeInteger(parentRunId) && parentRunId > 0) {
		const terminalized = await terminalizeLinkedAutomationParent(
		  tx,
		  {
			id: Number(row?.id),
			queue_name: String(row?.queue_name ?? ""),
			organization_id:
			  typeof row?.organization_id === "string"
				? row.organization_id
				: null,
			parent_run_id: parentRunId,
			message_id:
			  typeof row?.message_id === "string" ? row.message_id : null,
			agent_id: typeof row?.agent_id === "string" ? row.agent_id : null,
			user_id: typeof row?.user_id === "string" ? row.user_id : null,
			conversation_id:
			  typeof row?.conversation_id === "string"
				? row.conversation_id
				: null,
			channel_id:
			  typeof row?.channel_id === "string" ? row.channel_id : null,
			platform: typeof row?.platform === "string" ? row.platform : null,
		  },
		  message,
		  AgentErrorCode.WORKER_DIED,
		);
		responseEmitted = terminalized.responseEmitted;
      }
	  return { failed, responseEmitted };
    });
	if (outcome.responseEmitted) await notifyThreadResponse();
	const row = outcome.failed[0] as
      | { run_type?: string; queue_name?: string }
      | undefined;
    // Only emit when we actually transitioned the row (a sibling pod may have
    // reclaimed it after a heartbeat gap). The failed `runs` row is the durable
    // dead-letter record (kept FAILED_RUNS_RETENTION_DAYS); this counter is the
    // aggregate, alertable signal the log alone never provided — a
    // user-facing reply (run_type='chat_message') here was silently dropped.
    if (row) {
      incrementCounter("lobu_runs_failed_total", {
        run_type: row.run_type ?? "unknown",
        queue: row.queue_name ?? "unknown",
      });
    }
    // Logged as a warning; not emitted to Sentry. Per-run terminal failures
    // are high-volume and low-actionable (each is a separate event in Sentry,
    // burning the org quota with no per-incident signal beyond the log).
    // The aggregate "we have failed runs" signal lives on lobu_runs_failed_total.
    logger.warn(`Run ${runId} failed after retries: ${message}`);
  }

  private async scheduleRetry(
    runId: number,
    claimOwner: string,
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
        AND claimed_by = ${claimOwner}
    `;
    queueBreadcrumb("retry", `Scheduled retry for run ${runId}`, {
      runId,
      attempt,
      delaySeconds: delay,
    });
  }

  /** Release only the exact owner that acquired a raced claim. */
  private async releaseClaim(runId: number, claimOwner: string): Promise<void> {
    const sql = getDb();
    await sql`
      UPDATE public.runs
      SET status = 'pending',
          claimed_at = NULL,
          claimed_by = NULL
      WHERE id = ${runId}
        AND status = 'claimed'
        AND claimed_by = ${claimOwner}
    `;
  }

  /**
   * Release every claim this process issued, never another worker's.
   *
   * Each owner is `<claimedBy>:<queue>:<generation>` and `claimedBy` carries a
   * per-instance UUID, so the prefix identifies exactly this process's rows --
   * across every queue and every worker generation it went through. Matching on
   * the prefix is why nothing has to remember the owners: a long-lived gateway
   * re-registers workers indefinitely, and a remembered set would grow for the
   * life of the process to serve one statement at shutdown.
   */
  private async releaseAllClaims(): Promise<number> {
    const result = await getDb()`
      UPDATE public.runs
      SET status = 'pending',
          claimed_at = NULL,
          claimed_by = NULL
      WHERE status = 'claimed'
        AND starts_with(claimed_by, ${`${this.claimedBy}:`})
    `;
    return result.count;
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
        // Threshold comes from intervals.ts, which guarantees a positive
        // integer (parseEnvInt rounds and falls back on bad input), so it is
        // safe to inline as a SQL literal — no placeholders needed.
        const thresholdMs = intervals.runsClaimVisibilityTimeoutMs;
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
          // Operational housekeeping, not an incident — log it, but don't
          // page Sentry (Seer flagged the alert super-low actionability).
          logger.warn(
            `Reclaimed ${result.count} stale runs (claimed > ${
              thresholdMs / 1000
            }s ago)`,
          );
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
  // Failed runs are the dead-letter record an operator inspects/replays. Keep
  // them at least as long as completed runs, but allow a longer, independent
  // window via FAILED_RUNS_RETENTION_DAYS so the dead-letter lane isn't pruned
  // at the same cadence as routine completions. Defaults to retentionDays, so
  // execution is unchanged unless an operator opts into a longer window.
  const failedRetentionDays = (() => {
    const raw = Number(process.env.FAILED_RUNS_RETENTION_DAYS);
    return Number.isFinite(raw) && raw > 0
      ? Math.max(raw, retentionDays)
      : retentionDays;
  })();

  let total = 0;

	// A linked message is the durable child of an Automation parent. Expiry is
	// therefore a terminal dispatch failure, not disposable queue debris: retain
	// the child as a dead letter and resolve the parent in the same transaction.
	const expiredLinked = await sql.begin(async (tx) => {
		const candidates = await tx<{
			id: number;
			queue_name: string;
			organization_id: string | null;
			parent_run_id: number;
			message_id: string | null;
			agent_id: string | null;
			user_id: string | null;
			conversation_id: string | null;
			channel_id: string | null;
			platform: string | null;
		}>`
			SELECT id, queue_name, organization_id, parent_run_id,
			       action_input->>'messageId' AS message_id,
			       action_input->>'agentId' AS agent_id,
			       action_input->>'userId' AS user_id,
			       action_input->>'conversationId' AS conversation_id,
			       action_input->>'channelId' AS channel_id,
			       action_input->>'platform' AS platform
			FROM public.runs
			WHERE expires_at IS NOT NULL
			  AND expires_at <= now()
			  AND status = 'pending'
			  AND run_type = 'chat_message'
			  AND parent_run_id IS NOT NULL
			ORDER BY expires_at ASC, id ASC
			LIMIT 100
		`;
		let failed = 0;
		let responses = 0;
		for (const candidate of candidates) {
			const message = "Automation queue child expired before it could run.";
			const organizationId = candidate.organization_id?.trim();
			if (!organizationId) {
				// Without an org the parent cannot be located, so this child can't be
				// resolved the usual way -- but it still has to leave `pending`. The
				// DELETE below deliberately spares parent-linked chat_message rows,
				// so a plain `continue` strands this one at the head of a window
				// ordered by `expires_at ASC` and capped at 100; enough of them and
				// the linked-child sweep stops making progress at all.
				const orphaned = await tx`
					UPDATE public.runs
					SET status = 'failed',
					    completed_at = now(),
					    error_message = ${`${message} Its organization scope was missing, so the Automation parent could not be resolved.`},
					    attempts = attempts + 1
					WHERE id = ${candidate.id}
					  AND status = 'pending'
					RETURNING id
				`;
				if (orphaned.length > 0) failed++;
				continue;
			}
			await lockLinkedAutomationOwner(
				tx,
				candidate.parent_run_id,
				organizationId,
			);
			await tx`
				SELECT id FROM public.runs
				WHERE id = ${candidate.parent_run_id}
				FOR UPDATE
			`;
			const transitioned = await tx`
				UPDATE public.runs
				SET status = 'failed',
				    completed_at = now(),
				    error_message = ${message},
				    attempts = attempts + 1
				WHERE id = ${candidate.id}
				  AND status = 'pending'
				RETURNING id
			`;
			if (transitioned.length === 0) continue;
			failed++;
			const terminalized = await terminalizeLinkedAutomationParent(
				tx,
				candidate,
				message,
				AgentErrorCode.WORKER_UNRESPONSIVE,
			);
			if (terminalized.responseEmitted) responses++;
		}
		return { failed, responses };
	});
	total += expiredLinked.failed;
	if (expiredLinked.responses > 0) await notifyThreadResponse();

  const expired = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE expires_at IS NOT NULL
        AND expires_at <= now()
        AND status = 'pending'
		AND (parent_run_id IS NULL OR run_type <> 'chat_message')
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((expired[0] as { count?: number } | undefined)?.count ?? 0);

  const aged = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status IN ('completed', 'cancelled', 'timeout')
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${retentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((aged[0] as { count?: number } | undefined)?.count ?? 0);

  // Dead-letter lane: prune failed runs on their own (>=) retention window.
  const agedFailed = await sql`
    WITH d AS (
      DELETE FROM runs
      WHERE status = 'failed'
        AND run_type IN ('chat_message', 'schedule', 'agent_run', 'internal', 'task')
        AND completed_at IS NOT NULL
        AND completed_at < now() - (${failedRetentionDays}::int * interval '1 day')
      RETURNING id
    )
    SELECT count(*)::int AS count FROM d
  `;
  total += Number((agedFailed[0] as { count?: number } | undefined)?.count ?? 0);

  return total;
}
