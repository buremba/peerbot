/**
 * Connector repair-agent triggers.
 *
 * When a feed accumulates persistent failures, the worker-completion path
 * calls `maybeOpenOrAppendRepairThread` to (a) decide whether to open a
 * Lobu agent thread for triage, (b) win an atomic UPDATE so racing workers
 * don't double-open, and (c) post the diagnostic packet to the resulting
 * thread. On success after a streak, `maybeCloseRepairThread` posts a
 * one-line "resolved" message and clears the open-thread pointer.
 *
 * The trigger logic is deliberately conservative: bounded retries, a
 * cooldown window, a per-feed first-failure-duration gate, and a per-org
 * kill switch all prevent runaway behavior.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type DbClient, getDb } from '../db/client';
import { createThreadForAgent, enqueueAgentMessage } from '../gateway/services/agent-threads';
import { getLobuCoreServices } from '../lobu/gateway';
import logger from '../utils/logger';
import {
  type DiagnosticRunRow,
  buildAppendPacket,
  buildOpenPacket,
} from './repair-agent-packet';

const DEFAULT_THRESHOLD = 3;
const DEFAULT_MIN_FAILING_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface RepairAgentConfig {
  threshold: number;
  minFailingDurationMs: number;
  maxAttempts: number;
  cooldownMs: number;
}

export function loadRepairConfigFromEnv(): RepairAgentConfig {
  return {
    threshold: envInt('CONNECTOR_REPAIR_THRESHOLD', DEFAULT_THRESHOLD),
    minFailingDurationMs: envInt('CONNECTOR_REPAIR_MIN_FAILING_MS', DEFAULT_MIN_FAILING_MS),
    maxAttempts: envInt('CONNECTOR_REPAIR_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS),
    cooldownMs: envInt('CONNECTOR_REPAIR_COOLDOWN_MS', DEFAULT_COOLDOWN_MS),
  };
}

interface FeedState {
  id: number;
  organization_id: string;
  consecutive_failures: number;
  first_failure_at: Date | null;
  repair_thread_id: string | null;
  repair_attempt_count: number;
  last_repair_at: Date | null;
  repair_agent_id: string | null;
  connector_key: string | null;
  display_name: string | null;
  config: Record<string, unknown> | null;
  schedule: string | null;
  default_repair_agent_id: string | null;
  connection_id: number | null;
  connection_display_name: string | null;
  auth_profile_status: string | null;
  connector_name: string | null;
  connector_version: string | null;
}

async function loadFeedState(
  sql: DbClient,
  feedId: number
): Promise<FeedState | null> {
  // Pick the most-specific connector definition for the feed:
  //   1. org-scoped + active row (idx_connector_defs_org_key)
  //   2. system-level + active row (idx_connector_defs_system_key)
  // The DISTINCT ON + ORDER BY ensures exactly one cd row per feed and gives
  // org-specific definitions priority.
  const rows = (await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (f.id)
        f.id,
        f.organization_id,
        f.consecutive_failures,
        f.first_failure_at,
        f.repair_thread_id,
        f.repair_attempt_count,
        f.last_repair_at,
        f.repair_agent_id,
        f.display_name,
        f.config,
        f.schedule,
        c.id AS connection_id,
        c.connector_key,
        c.display_name AS connection_display_name,
        ap.status AS auth_profile_status,
        cd.name AS connector_name,
        cd.version AS connector_version,
        cd.default_repair_agent_id
      FROM feeds f
      LEFT JOIN connections c ON c.id = f.connection_id
      LEFT JOIN auth_profiles ap ON ap.id = c.auth_profile_id
      LEFT JOIN connector_definitions cd ON cd.key = c.connector_key
        AND cd.status = 'active'
        AND (cd.organization_id = f.organization_id OR cd.organization_id IS NULL)
      WHERE f.id = ${feedId}
      ORDER BY f.id,
               (cd.organization_id IS NULL) ASC -- org-specific first
    ) sub
    LIMIT 1
  `) as unknown as Array<FeedState>;
  return rows[0] ?? null;
}

async function loadRecentRuns(
  sql: DbClient,
  feedId: number,
  limit = 10
): Promise<DiagnosticRunRow[]> {
  const rows = (await sql`
    SELECT id, status, started_at, completed_at, error_message,
           exit_reason, exit_code, exit_signal, output_tail
    FROM runs
    WHERE feed_id = ${feedId}
    ORDER BY id DESC
    LIMIT ${limit}
  `) as unknown as Array<{
    id: number;
    status: string;
    started_at: Date | null;
    completed_at: Date | null;
    error_message: string | null;
    exit_reason: string | null;
    exit_code: number | null;
    exit_signal: string | null;
    output_tail: string | null;
  }>;
  return rows.map((r) => ({
    id: Number(r.id),
    status: r.status,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    durationMs:
      r.started_at && r.completed_at
        ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
        : null,
    errorMessage: r.error_message,
    exitReason: r.exit_reason,
    exitCode: r.exit_code,
    exitSignal: r.exit_signal,
    outputTail: r.output_tail,
  }));
}

function resolveRepairAgentId(state: FeedState): string | null {
  if (state.repair_agent_id) return state.repair_agent_id;
  if (state.default_repair_agent_id) return state.default_repair_agent_id;
  return null;
}

/**
 * Hash the run's failure signature so repeated identical failures don't spam
 * the thread. Combines `error_message`, `exit_reason`, and a hash of
 * `output_tail` (which itself is already redacted by the worker).
 */
export function hashFailureSignature(run: DiagnosticRunRow): string {
  const tailHash = run.outputTail
    ? createHash('sha256').update(run.outputTail).digest('hex')
    : '';
  return createHash('sha256')
    .update([run.errorMessage ?? '', run.exitReason ?? '', tailHash].join('\x1f'))
    .digest('hex');
}

interface CallableServices {
  sessionManager: any;
  queueProducer: any;
  createThreadForAgent: (deps: any, args: any) => Promise<{ threadId: string }>;
  enqueueAgentMessage: (deps: any, args: any) => Promise<unknown>;
}

function loadCallableServices(): CallableServices | null {
  const core = getLobuCoreServices();
  if (!core) return null;
  return {
    sessionManager: core.getSessionManager(),
    queueProducer: core.getQueueProducer(),
    createThreadForAgent,
    enqueueAgentMessage,
  };
}

export interface RepairTriggerDeps {
  /** Override the gateway services (used in tests). */
  services?: CallableServices;
  /** Override the env-loaded config (used in tests). */
  config?: RepairAgentConfig;
  /** Override the wall clock (used in tests). */
  now?: () => number;
  /** Override the DB client (used in tests). */
  sql?: DbClient;
  /** Override thread id minting (used in tests for deterministic ids). */
  mintThreadId?: () => string;
}

/**
 * Decide and execute the repair-thread side effects for a feed that just
 * had its `consecutive_failures` incremented.
 *
 * Called from `worker-api.ts:completeWorkerJob` after the feed UPDATE.
 *
 * - If no thread is open and the gating conditions hold, opens a new thread
 *   via an atomic UPDATE on `feeds(repair_thread_id IS NULL)` to win against
 *   racing workers, then enqueues the diagnostic packet.
 * - If a thread is already open, optionally appends the new failure
 *   subject to a content-hash + every-Nth-failure throttle.
 * - On the cap, pauses the feed and stops.
 *
 * All errors are logged and swallowed — the repair trigger must never
 * block the worker-completion path.
 */
export async function maybeOpenOrAppendRepairThread(
  feedId: number,
  runId: number,
  deps: RepairTriggerDeps = {}
): Promise<void> {
  const cfg = deps.config ?? loadRepairConfigFromEnv();
  const now = deps.now ?? (() => Date.now());
  const sql = deps.sql ?? getDb();

  let state: FeedState | null;
  try {
    state = await loadFeedState(sql, feedId);
  } catch (error) {
    logger.error({ feed_id: feedId, error: String(error) }, '[repair-agent] failed to load feed state');
    return;
  }
  if (!state) return;

  // Defensive: this function is only meant to fire after the worker-api
  // failure path has incremented consecutive_failures, but a future caller
  // path could violate that. Bail at <= 0 so the bucket=0 claim slot
  // doesn't get consumed before the first real failure.
  if (state.consecutive_failures <= 0) return;

  const recentRuns = await loadRecentRuns(sql, feedId, 10);
  // The completed run we were called for is the canonical signature source —
  // not whichever run happens to be at the top of recentRuns. Out-of-order
  // worker completions (later run finishes before an earlier one) would
  // otherwise attach the wrong run's diagnostics. If the runId we were
  // called for isn't yet visible in the recent runs (DB read raced the
  // INSERT), skip silently — the next failure cron will pick it up.
  const completedRun = recentRuns.find((r) => r.id === runId) ?? null;

  // Branch 1: Thread already open — consider appending.
  if (state.repair_thread_id) {
    if (!completedRun) {
      logger.debug(
        { feed_id: feedId, run_id: runId },
        '[repair-agent] completed run not yet visible in recent_runs — skipping append'
      );
      return;
    }
    // Encode (signature, ceil-floor-of-5 bucket) into the claim key so the
    // dedupe is purely IS-DISTINCT-FROM and doesn't need an OR-clause that
    // would let concurrent workers both win on multiples of 5. Same hash
    // within the same 5-failure bucket → same key → only one UPDATE wins;
    // signature changes OR crossing a 5-boundary → key changes → next post
    // fires once.
    //   consec 1..4  → `${hash}@0`   (initial post)
    //   consec 5..9  → `${hash}@5`   (every-5th override fires once at 5)
    //   consec 10..14→ `${hash}@10`  (every-5th override fires once at 10)
    const baseHash = hashFailureSignature(completedRun);
    const bucket = Math.floor(state.consecutive_failures / 5) * 5;
    const claimKey = `${baseHash}@${bucket}`;

    // Atomic dedupe: claim the new key in one UPDATE that's a no-op when
    // another concurrent worker just wrote the same key. Prevents two
    // workers from observing the same `last_repair_post_hash` and both
    // posting duplicate appends.
    const claimRows = (await sql`
      UPDATE feeds
      SET last_repair_post_hash = ${claimKey}
      WHERE id = ${feedId}
        AND last_repair_post_hash IS DISTINCT FROM ${claimKey}
      RETURNING last_repair_post_hash
    `) as unknown as Array<{ last_repair_post_hash: string | null }>;
    if (claimRows.length === 0) {
      logger.debug(
        { feed_id: feedId, claim_key: claimKey },
        '[repair-agent] suppressing append — same claim key already recorded'
      );
      return;
    }

    const services = deps.services ?? loadCallableServices();
    if (!services) return;

    try {
      const packet = buildAppendPacket({
        consecutiveFailures: state.consecutive_failures,
        run: completedRun,
      });
      await services.enqueueAgentMessage(
        { sessionManager: services.sessionManager, queueProducer: services.queueProducer },
        { threadId: state.repair_thread_id, messageText: packet, source: 'connector-repair' }
      );
      logger.info(
        { feed_id: feedId, thread_id: state.repair_thread_id, run_id: runId },
        '[repair-agent] appended failure to existing repair thread'
      );
    } catch (error) {
      logger.error(
        { feed_id: feedId, error: String(error) },
        '[repair-agent] failed to append to existing thread'
      );
    }
    return;
  }

  // Branch 2: No thread — check gating conditions.
  if (state.consecutive_failures < cfg.threshold) return;
  if (
    !state.first_failure_at ||
    now() - new Date(state.first_failure_at).getTime() < cfg.minFailingDurationMs
  ) {
    return;
  }
  if (
    state.last_repair_at &&
    now() - new Date(state.last_repair_at).getTime() < cfg.cooldownMs
  ) {
    return;
  }

  if (state.repair_attempt_count >= cfg.maxAttempts) {
    // Lifetime budget exhausted — pause the feed and stop.
    try {
      await sql`
        UPDATE feeds
        SET status = 'paused', next_run_at = NULL, updated_at = current_timestamp
        WHERE id = ${feedId} AND status <> 'paused'
      `;
      logger.warn(
        { feed_id: feedId, attempt_count: state.repair_attempt_count },
        '[repair-agent] repair budget exhausted — paused feed'
      );
    } catch (error) {
      logger.error(
        { feed_id: feedId, error: String(error) },
        '[repair-agent] failed to pause feed at budget cap'
      );
    }
    return;
  }

  const repairAgentId = resolveRepairAgentId(state);
  if (!repairAgentId) {
    logger.debug({ feed_id: feedId }, '[repair-agent] no repair agent resolves — skipping');
    return;
  }

  const services = deps.services ?? loadCallableServices();
  if (!services) return;

  // Mint the thread id BEFORE the atomic UPDATE so we can race-guard on
  // `feeds.repair_thread_id IS NULL`. Only after winning do we materialize
  // the session and enqueue. Losing workers exit silently — no orphan
  // session is created.
  const userId = repairAgentId;
  const mint = deps.mintThreadId ?? (() => randomUUID());
  const externalThreadId = mint();
  const conversationId = `${repairAgentId}_${userId}_${externalThreadId}`;

  // All gates re-checked atomically inside the UPDATE, not just the
  // already-read JS values. Stale readers (e.g. another worker that loaded
  // state before a manual pause / budget reset) cannot win the claim if any
  // gate has flipped between the read and the UPDATE.
  const minFailingDurationSeconds = Math.floor(cfg.minFailingDurationMs / 1000);
  const cooldownSeconds = Math.floor(cfg.cooldownMs / 1000);
  let won = false;
  try {
    const claim = (await sql`
      UPDATE feeds
      SET repair_thread_id = ${conversationId},
          repair_attempt_count = repair_attempt_count + 1,
          last_repair_at = current_timestamp,
          updated_at = current_timestamp
      WHERE id = ${feedId}
        AND repair_thread_id IS NULL
        AND status <> 'paused'
        AND consecutive_failures >= ${cfg.threshold}
        AND first_failure_at IS NOT NULL
        AND first_failure_at <= current_timestamp - make_interval(secs => ${minFailingDurationSeconds})
        AND (last_repair_at IS NULL
             OR last_repair_at <= current_timestamp - make_interval(secs => ${cooldownSeconds}))
        AND repair_attempt_count < ${cfg.maxAttempts}
      RETURNING repair_thread_id
    `) as unknown as Array<{ repair_thread_id: string | null }>;
    won = claim.length > 0;
  } catch (error) {
    logger.error(
      { feed_id: feedId, error: String(error) },
      '[repair-agent] atomic UPDATE failed'
    );
    return;
  }

  if (!won) {
    logger.debug({ feed_id: feedId }, '[repair-agent] another worker won the open — skipping');
    return;
  }

  try {
    await services.createThreadForAgent(
      { sessionManager: services.sessionManager },
      {
        agentId: repairAgentId,
        organizationId: state.organization_id,
        userId,
        externalThreadId,
        reason: 'connector-repair',
      }
    );
    const packet = buildOpenPacket({
      feedId: state.id,
      feedDisplayName: state.display_name,
      connectorKey: state.connector_key,
      connectorName: state.connector_name,
      connectorVersion: state.connector_version,
      feedConfig: state.config,
      feedSchedule: state.schedule,
      consecutiveFailures: state.consecutive_failures,
      firstFailureAt: state.first_failure_at
        ? new Date(state.first_failure_at).toISOString()
        : null,
      connectionId: state.connection_id,
      connectionDisplayName: state.connection_display_name,
      authProfileStatus: state.auth_profile_status,
      recentRuns,
    });
    await services.enqueueAgentMessage(
      { sessionManager: services.sessionManager, queueProducer: services.queueProducer },
      { threadId: conversationId, messageText: packet, source: 'connector-repair' }
    );
    logger.info(
      {
        feed_id: feedId,
        thread_id: conversationId,
        run_id: runId,
        repair_agent_id: repairAgentId,
      },
      '[repair-agent] opened repair thread'
    );
  } catch (error) {
    logger.error(
      { feed_id: feedId, thread_id: conversationId, error: String(error) },
      '[repair-agent] thread create/enqueue failed after winning UPDATE — thread row left in feeds.repair_thread_id; will be retried on next failure if cleared'
    );
  }
}

/**
 * Called from `completeWorkerJob` on a successful run that resets
 * `consecutive_failures` to zero. Posts a one-line "resolved" message to
 * the open repair thread (if any) and clears the open-thread pointer.
 *
 * Note: `repair_attempt_count` is intentionally NOT reset — that field is
 * the lifetime budget. Operators can reset it manually if they want.
 */
export async function maybeCloseRepairThread(
  feedId: number,
  runId: number,
  deps: RepairTriggerDeps = {}
): Promise<void> {
  const sql = deps.sql ?? getDb();

  // Atomic claim: only the caller whose UPDATE actually clears the row sees
  // the previously-open thread id. The `consecutive_failures = 0` guard
  // ensures a stale success completion arriving AFTER a new failure has
  // restarted the streak does not erase the new failure state.
  let claimedThreadId: string | null = null;
  try {
    const rows = (await sql`
      WITH old AS (
        SELECT id, repair_thread_id
        FROM feeds
        WHERE id = ${feedId}
          AND consecutive_failures = 0
        FOR UPDATE
      )
      UPDATE feeds f
      SET first_failure_at = NULL,
          last_repair_post_hash = NULL,
          repair_thread_id = NULL,
          updated_at = current_timestamp
      FROM old
      WHERE f.id = old.id
      RETURNING old.repair_thread_id
    `) as unknown as Array<{ repair_thread_id: string | null }>;
    claimedThreadId = rows[0]?.repair_thread_id ?? null;
  } catch (error) {
    logger.error(
      { feed_id: feedId, error: String(error) },
      '[repair-agent] failed to atomically clear streak state on success'
    );
    return;
  }

  if (!claimedThreadId) return;

  const services = deps.services ?? loadCallableServices();
  if (!services) return;

  try {
    await services.enqueueAgentMessage(
      { sessionManager: services.sessionManager, queueProducer: services.queueProducer },
      {
        threadId: claimedThreadId,
        messageText: `Resolved: feed has resumed successfully (run id ${runId})`,
        source: 'connector-repair',
      }
    );
    logger.info(
      { feed_id: feedId, thread_id: claimedThreadId, run_id: runId },
      '[repair-agent] posted resolved message and cleared open thread'
    );
  } catch (error) {
    logger.error(
      { feed_id: feedId, thread_id: claimedThreadId, error: String(error) },
      '[repair-agent] failed to post resolved message'
    );
  }
}
