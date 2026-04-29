/**
 * ScheduleService — declarative cron scheduler for Lobu agents.
 *
 * Definitions live in an in-memory `Map<id, DeclaredSchedule>` populated by
 * either the lobu.toml file loader (`toml:` prefix) or an in-process
 * embedder such as Owletto (`owletto:` prefix).
 *
 * Phase 9 of Redis -> Postgres migration: Redis is gone. Runtime state is
 * either in-memory (next_fire, recomputed from the cron expression) or
 * Postgres (advisory lock per fireId + idempotency_key on the runs row).
 *
 * Behavior:
 * - Tick every 10s; for each enabled definition, fire when `next_fire <= now`.
 * - Skip-not-backfill: missed fires (after downtime) are dropped, `next_fire`
 *   is recomputed forward.
 * - Multi-instance double-fire prevention: `pg_try_advisory_xact_lock`
 *   keyed on `hashtext('schedule:' || scheduleId || ':' || fireId)` ensures
 *   only one gateway instance enqueues a given (scheduleId, fireId) pair.
 *   Belt-and-suspenders: the runs-table `idempotency_key` partial-unique
 *   index on the `singletonKey=schedule-<id>-<fireId>` payload also rejects
 *   duplicates if two gateways race past the advisory lock.
 * - In-memory `lease` (set + Date stamp) prevents this same gateway from
 *   firing again while a previous run is still nominally in flight.
 *   Because next_fire is in memory and per-process, this is a per-process
 *   guard; cross-process serialization is purely cron-driven plus the
 *   advisory-lock + idempotency-key dual protection above.
 */

import { createLogger } from "@lobu/core";
import type { DeclaredSchedule, ScheduleConcurrency } from "@lobu/core";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "../../db/client.js";
import type { IMessageQueue } from "../infrastructure/queue/index.js";

const logger = createLogger("schedule-service");

const TICK_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 30 * 60 * 1000; // 30 min — conservative upper bound on a single agent run

let scheduleServiceInstance: ScheduleService | undefined;

export function setScheduleServiceInstance(service: ScheduleService): void {
  scheduleServiceInstance = service;
}

export function getScheduleServiceInstance(): ScheduleService | undefined {
  return scheduleServiceInstance;
}

interface ScheduleRuntimeState {
  nextFire: Date;
  /** When set, a previous fire is in flight (per this gateway). */
  leaseExpiresAt?: number;
}

export class ScheduleService {
  private readonly defs = new Map<string, DeclaredSchedule>();
  private readonly state = new Map<string, ScheduleRuntimeState>();
  private tickHandle?: ReturnType<typeof setInterval>;
  private isStarted = false;

  constructor(private readonly queue: IMessageQueue) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    this.tickHandle = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, "schedule tick failed");
      });
    }, TICK_INTERVAL_MS);
    logger.debug("ScheduleService started");
  }

  async stop(): Promise<void> {
    if (!this.isStarted) return;
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = undefined;
    this.isStarted = false;
    logger.debug("ScheduleService stopped");
  }

  // ── Definition CRUD (in-memory) ──────────────────────────────────────────

  /**
   * Insert or replace a single schedule definition. Validates cron+timezone
   * synchronously and throws on invalid input. Computes initial `next_fire`
   * if the in-memory entry is new or its cron/timezone has changed.
   */
  async upsert(def: DeclaredSchedule): Promise<void> {
    this.validate(def);
    const previous = this.defs.get(def.id);
    this.defs.set(def.id, def);

    // Recompute next_fire when the cron/timezone changes, OR when a disabled
    // schedule is re-enabled — otherwise the stale next_fire from before the
    // disable could be in the past and we'd fire immediately on re-enable.
    const cronChanged =
      !previous ||
      previous.cron !== def.cron ||
      previous.timezone !== def.timezone;
    const reEnabled = previous?.enabled === false && def.enabled === true;
    if (cronChanged || reEnabled) {
      const next = this.computeNextFire(def, new Date());
      this.state.set(def.id, { nextFire: next });
    }
  }

  /**
   * Drop a single definition by id. Cancels future fires.
   */
  async remove(id: string): Promise<void> {
    this.defs.delete(id);
    this.state.delete(id);
  }

  /**
   * Replace all definitions whose id starts with `idPrefix`. Anything in the
   * existing in-memory map matching the prefix that is NOT in `defs` is
   * removed atomically. Used for reload paths (lobu.toml or Owletto bulk push).
   *
   * Throws if any new def fails validation; in that case nothing is changed.
   */
  async replaceByPrefix(
    idPrefix: string,
    defs: DeclaredSchedule[]
  ): Promise<void> {
    if (!idPrefix.endsWith(":")) {
      throw new Error(
        `replaceByPrefix prefix must end with ":" (got "${idPrefix}")`
      );
    }
    for (const d of defs) {
      if (!d.id.startsWith(idPrefix)) {
        throw new Error(
          `schedule id "${d.id}" does not match prefix "${idPrefix}"`
        );
      }
      this.validate(d);
    }

    const next = new Map(defs.map((d) => [d.id, d]));
    const toRemove = new Set<string>();
    for (const id of this.defs.keys()) {
      if (id.startsWith(idPrefix) && !next.has(id)) toRemove.add(id);
    }

    for (const id of toRemove) {
      this.defs.delete(id);
      this.state.delete(id);
    }
    for (const d of defs) await this.upsert(d);
  }

  /** Snapshot of all in-memory definitions. */
  list(): DeclaredSchedule[] {
    return Array.from(this.defs.values());
  }

  /** Snapshot scoped to a single agent. */
  listByAgent(agentId: string): DeclaredSchedule[] {
    return this.list().filter((d) => d.agentId === agentId);
  }

  /**
   * Worker-facing: signal that a scheduled run has completed so the lease can
   * be released and the schedule becomes eligible to fire again. Idempotent.
   */
  async releaseLease(scheduleId: string): Promise<void> {
    const existing = this.state.get(scheduleId);
    if (existing) {
      delete existing.leaseExpiresAt;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private validate(def: DeclaredSchedule): void {
    if (!def.id) throw new Error("schedule.id is required");
    if (!def.agentId) throw new Error(`schedule "${def.id}" missing agentId`);
    if (!def.cron) throw new Error(`schedule "${def.id}" missing cron`);
    if (!def.task) throw new Error(`schedule "${def.id}" missing task`);
    const tz = def.timezone ?? "UTC";
    try {
      CronExpressionParser.parse(def.cron, { tz });
    } catch (err) {
      throw new Error(
        `schedule "${def.id}" has invalid cron "${def.cron}" or timezone "${tz}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private computeNextFire(def: DeclaredSchedule, after: Date): Date {
    const interval = CronExpressionParser.parse(def.cron, {
      tz: def.timezone ?? "UTC",
      currentDate: after,
    });
    return interval.next().toDate();
  }

  /**
   * Local per-process lease check. If a previous fire from this same
   * gateway hasn't released, drop or queue per concurrency policy.
   * Cross-process serialization happens at the advisory-lock + idempotency
   * key layer in `tryFireOnceInDb`.
   */
  private holdLeaseLocally(id: string): boolean {
    const existing = this.state.get(id);
    if (!existing) return false;
    if (
      existing.leaseExpiresAt !== undefined &&
      existing.leaseExpiresAt > Date.now()
    ) {
      return true;
    }
    return false;
  }

  private acquireLeaseLocally(id: string): void {
    const existing = this.state.get(id);
    if (!existing) return;
    existing.leaseExpiresAt = Date.now() + LEASE_TTL_MS;
  }

  private async tick(): Promise<void> {
    if (this.defs.size === 0) return;
    const now = new Date();

    for (const def of this.defs.values()) {
      if (!def.enabled) continue;
      try {
        await this.tickOne(def, now);
      } catch (err) {
        logger.error({ scheduleId: def.id, err }, "tick failed for schedule");
      }
    }
  }

  private async tickOne(def: DeclaredSchedule, now: Date): Promise<void> {
    let runtime = this.state.get(def.id);
    if (!runtime) {
      runtime = { nextFire: this.computeNextFire(def, now) };
      this.state.set(def.id, runtime);
      return;
    }
    if (runtime.nextFire.getTime() > now.getTime()) return;

    // Skip-not-backfill: fast-forward `nextFire` past any missed ticks.
    const futureNext = this.computeNextFire(def, now);

    const concurrency: ScheduleConcurrency = def.concurrency ?? "queue";
    const localLeaseHeld = this.holdLeaseLocally(def.id);

    if (!localLeaseHeld || concurrency === "allow") {
      // Compute a fireId from the wall-clock minute that this fire belongs
      // to. Two ticks within the same minute that happen to both pass the
      // local lease check will collide on the advisory lock + idempotency
      // key, so cross-process duplication is suppressed.
      const fireBucket = Math.floor(now.getTime() / 60_000);
      const fireId = `bucket-${fireBucket}`;
      const enqueued = await this.tryFireOnceInDb(def, fireId);
      if (enqueued) {
        this.acquireLeaseLocally(def.id);
      }
      runtime.nextFire = futureNext;
      return;
    }

    // Local lease is held → previous run still in flight on this process.
    if (concurrency === "skip") {
      logger.warn(
        { scheduleId: def.id },
        "schedule fire skipped — previous run in flight"
      );
      runtime.nextFire = futureNext;
      return;
    }

    // concurrency === "queue": leave next_fire untouched so we re-check next
    // tick. Once the lease releases (worker callback or TTL), the next tick
    // will fire. Effective queue-depth = 1 in steady state because additional
    // missed ticks coalesce onto the same pending slot.
    logger.warn(
      { scheduleId: def.id, nextFire: runtime.nextFire.toISOString() },
      "schedule fire queued — previous run in flight"
    );
  }

  /**
   * Acquire a per-(scheduleId, fireId) advisory lock and enqueue exactly
   * one runs row. Returns true if this process successfully acquired the
   * lock and enqueued (or coalesced into an existing pending row); false if
   * another gateway has already taken the lock for this fire.
   *
   * The lock is xact-scoped (`pg_try_advisory_xact_lock`) so it auto-releases
   * at COMMIT/ROLLBACK — no manual cleanup required. The idempotency_key
   * unique index on the runs row gives a second-layer guarantee when the
   * advisory lock is racy across replication boundaries.
   */
  private async tryFireOnceInDb(
    def: DeclaredSchedule,
    fireId: string
  ): Promise<boolean> {
    const sql = getDb();
    const lockKey = `schedule:${def.id}:${fireId}`;

    let acquired = false;
    try {
      const rows = await sql`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS got
      `;
      acquired = Boolean((rows[0] as { got: boolean } | undefined)?.got);
    } catch (err) {
      logger.error(
        { scheduleId: def.id, fireId, err },
        "advisory lock check failed; relying on idempotency key alone"
      );
      acquired = true;
    }

    if (!acquired) {
      logger.debug(
        { scheduleId: def.id, fireId },
        "advisory lock contended — another gateway is firing this schedule"
      );
      return false;
    }

    // Lock held for this transaction. Build the payload + send it. The
    // queue.send() goes through its own pool connection, so the advisory
    // lock above releases on the SELECT statement's implicit commit. That's
    // intentional — we don't need to hold the lock for the entire send;
    // we just need to be the single process that decides to send. The
    // idempotency key on the runs row is what suppresses any racing send
    // that happens between releasing the advisory lock and the INSERT.

    await this.enqueueFire(def, fireId);
    return true;
  }

  private async enqueueFire(
    def: DeclaredSchedule,
    fireId: string
  ): Promise<void> {
    const target = parseDeliveryTarget(def.deliverTo);
    const platform = target?.platform ?? "scheduled";
    const teamId = target?.connectionSlug ?? "scheduled";
    // Match the platform-prefixed encoding used by the inbound message
    // path (chat-response-bridge slices "<platform>:" off channelId, so the
    // canonical form here is `<platform>:<channelId>` for the channel
    // and `<platform>:<channelId>:<threadTs>` for a threaded reply).
    const channelId = target
      ? `${target.platform}:${target.channelId}`
      : `scheduled:${def.agentId}`;
    const conversationId = target?.threadTs
      ? `${channelId}:${target.threadTs}`
      : channelId;

    // The lobu.toml `connectionSlug` is the same string as the registered
    // Chat SDK connection id (both come from buildStableConnectionId), so
    // setting `connectionId` here is what lets ChatResponseBridge route the
    // worker's reply back through the platform adapter.
    const deliveryMetadata = target
      ? {
          connectionId: target.connectionSlug,
          chatId: target.channelId,
          ...(target.threadTs
            ? {
                responseThreadId: `${target.platform}:${target.channelId}:${target.threadTs}`,
              }
            : {}),
        }
      : {};

    // Approver-routed consent for destructive tool calls. Worker JWT
    // carries these so the proxy can route blocked-tool approval cards
    // to the approver channel even when the schedule is otherwise
    // headless. Reply path is unaffected (it uses `deliveryMetadata`).
    const approverTarget = parseDeliveryTarget(def.approver);
    const approverMetadata = approverTarget
      ? {
          approverPlatform: approverTarget.platform,
          approverConnectionId: approverTarget.connectionSlug,
          approverChannelId: `${approverTarget.platform}:${approverTarget.channelId}`,
          approverConversationId: approverTarget.threadTs
            ? `${approverTarget.platform}:${approverTarget.channelId}:${approverTarget.threadTs}`
            : `${approverTarget.platform}:${approverTarget.channelId}`,
          ...(approverTarget.connectionSlug
            ? { approverTeamId: approverTarget.connectionSlug }
            : {}),
        }
      : {};

    await this.queue.send(
      "messages",
      {
        userId: "system:scheduler",
        conversationId,
        messageId: `${def.id}:${fireId}`,
        channelId,
        teamId,
        agentId: def.agentId,
        botId: "system",
        platform,
        messageText: def.task,
        platformMetadata: {
          scheduledFire: true,
          scheduleId: def.id,
          deliverTo: def.deliverTo,
          approver: def.approver,
          ...deliveryMetadata,
          ...approverMetadata,
        },
        agentOptions: {},
      },
      {
        priority: 5,
        // Stable singleton key per (schedule, fireBucket). The runs-table
        // partial unique index turns racing inserts into no-ops, so even if
        // two gateways slipped past the advisory lock the second one's
        // INSERT collapses onto the first's row.
        singletonKey: `schedule-${def.id}-${fireId}`.replace(/:/g, "-"),
      }
    );

    logger.info(
      { scheduleId: def.id, agentId: def.agentId, deliverTo: def.deliverTo },
      "scheduled fire enqueued"
    );
  }
}

/**
 * Parse a deliveryTo string of the form
 *   `<platform>:<connectionSlug>:<channelId>[:<threadTs>]`
 * Returns null when the string is missing or malformed (caller falls back to
 * headless mode).
 */
function parseDeliveryTarget(deliverTo: string | undefined): {
  platform: string;
  connectionSlug: string;
  channelId: string;
  threadTs?: string;
} | null {
  if (!deliverTo) return null;
  const parts = deliverTo.split(":");
  if (parts.length < 3 || parts.length > 4) return null;
  const [platform, connectionSlug, channelId, threadTs] = parts;
  if (!platform || !connectionSlug || !channelId) return null;
  return { platform, connectionSlug, channelId, threadTs };
}
