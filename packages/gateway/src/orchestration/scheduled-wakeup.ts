/**
 * ScheduleService — declarative cron scheduler for Lobu agents.
 *
 * Definitions live in an in-memory `Map<id, DeclaredSchedule>` populated by
 * either the lobu.toml file loader (`toml:` prefix) or an in-process
 * embedder such as Owletto (`owletto:` prefix). Redis stores ONLY runtime
 * state: next-fire timestamp and a per-schedule lease.
 *
 * Behavior:
 * - Tick every 10s; for each enabled definition, fire when `next_fire <= now`.
 * - Skip-not-backfill: missed fires (after downtime) are dropped, `next_fire`
 *   is recomputed forward.
 * - Lease-based serialization: while a schedule is "in flight" (lease held)
 *   subsequent fires are dropped per `concurrency` policy. The worker should
 *   call `releaseLease(scheduleId)` when its run completes; otherwise the
 *   lease auto-expires after `LEASE_TTL_MS`.
 * - Multi-instance: not yet hardened. In a multi-replica gateway, both
 *   instances will tick and may double-fire. Documented follow-up.
 */

import { createLogger } from "@lobu/core";
import type { DeclaredSchedule, ScheduleConcurrency } from "@lobu/core";
import { CronExpressionParser } from "cron-parser";
import type { IMessageQueue } from "../infrastructure/queue";

const logger = createLogger("schedule-service");

const TICK_INTERVAL_MS = 10_000;
const LEASE_TTL_MS = 30 * 60 * 1000; // 30 min — conservative upper bound on a single agent run
const NEXT_FIRE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days; tick will refresh

const REDIS_NEXT_FIRE_PREFIX = "schedule:next_fire:";
const REDIS_LEASE_PREFIX = "schedule:lease:";

export interface ScheduleFirePayload {
  scheduleId: string;
  agentId: string;
  task: string;
  deliverTo?: string;
  approver?: string;
}

let scheduleServiceInstance: ScheduleService | undefined;

export function setScheduleServiceInstance(service: ScheduleService): void {
  scheduleServiceInstance = service;
}

export function getScheduleServiceInstance(): ScheduleService | undefined {
  return scheduleServiceInstance;
}

export class ScheduleService {
  private readonly defs = new Map<string, DeclaredSchedule>();
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
      await this.setNextFire(def.id, next);
    }
  }

  /**
   * Drop a single definition by id. Cancels future fires (clears next_fire and
   * lease so a re-add of the same id starts clean).
   */
  async remove(id: string): Promise<void> {
    this.defs.delete(id);
    const redis = this.queue.getRedisClient();
    await redis.del(`${REDIS_NEXT_FIRE_PREFIX}${id}`);
    await redis.del(`${REDIS_LEASE_PREFIX}${id}`);
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

    // Also reconcile against Redis so orphan keys from a previous process
    // (e.g. a schedule removed from lobu.toml between restarts) get cleaned
    // up. The in-memory map is always empty on a fresh start, so without
    // this scan, removed schedules would linger until their TTL.
    // Scan both prefixes — a schedule with a held lease but expired
    // next_fire would otherwise leave a stale lease that blocks re-adds.
    const redis = this.queue.getRedisClient();
    const orphanedIds = await this.scanRedisIdsForPrefix(idPrefix);
    for (const id of orphanedIds) {
      if (!next.has(id)) toRemove.add(id);
    }

    for (const id of toRemove) {
      this.defs.delete(id);
      await redis.del(`${REDIS_NEXT_FIRE_PREFIX}${id}`);
      await redis.del(`${REDIS_LEASE_PREFIX}${id}`);
    }
    for (const d of defs) await this.upsert(d);
  }

  private async scanRedisIdsForPrefix(idPrefix: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const keyPrefix of [REDIS_NEXT_FIRE_PREFIX, REDIS_LEASE_PREFIX]) {
      const pattern = `${keyPrefix}${idPrefix}*`;
      for (const key of await this.scanRedisKeys(pattern)) {
        ids.add(key.slice(keyPrefix.length));
      }
    }
    return ids;
  }

  private async scanRedisKeys(pattern: string): Promise<string[]> {
    const redis = this.queue.getRedisClient();
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        200
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
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
    const redis = this.queue.getRedisClient();
    await redis.del(`${REDIS_LEASE_PREFIX}${scheduleId}`);
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

  private async setNextFire(id: string, when: Date): Promise<void> {
    const redis = this.queue.getRedisClient();
    await redis.set(
      `${REDIS_NEXT_FIRE_PREFIX}${id}`,
      when.toISOString(),
      "PX",
      NEXT_FIRE_TTL_MS
    );
  }

  private async getNextFire(id: string): Promise<Date | null> {
    const redis = this.queue.getRedisClient();
    const raw = await redis.get(`${REDIS_NEXT_FIRE_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private async tryAcquireLease(id: string): Promise<boolean> {
    const redis = this.queue.getRedisClient();
    const result = await redis.set(
      `${REDIS_LEASE_PREFIX}${id}`,
      "1",
      "NX",
      "PX",
      LEASE_TTL_MS
    );
    return result === "OK";
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
    let nextFire = await this.getNextFire(def.id);
    if (!nextFire) {
      // First time we've seen this id (or TTL expired). Compute and store.
      nextFire = this.computeNextFire(def, now);
      await this.setNextFire(def.id, nextFire);
      return;
    }
    if (nextFire.getTime() > now.getTime()) return;

    // Skip-not-backfill: fast-forward `nextFire` past any missed ticks.
    const futureNext = this.computeNextFire(def, now);

    const concurrency: ScheduleConcurrency = def.concurrency ?? "queue";
    const leased = await this.tryAcquireLease(def.id);

    if (leased || concurrency === "allow") {
      await this.enqueueFire(def);
      await this.setNextFire(def.id, futureNext);
      return;
    }

    // Lease is held → previous run still in flight (or its TTL hasn't expired).
    if (concurrency === "skip") {
      logger.warn(
        { scheduleId: def.id },
        "schedule fire skipped — previous run in flight"
      );
      await this.setNextFire(def.id, futureNext);
      return;
    }

    // concurrency === "queue": leave next_fire untouched so we re-check next
    // tick. Once the lease releases (worker callback or TTL), the next tick
    // will fire. Effective queue-depth = 1 in steady state because additional
    // missed ticks coalesce onto the same pending slot.
    logger.warn(
      { scheduleId: def.id, nextFire: nextFire.toISOString() },
      "schedule fire queued — previous run in flight"
    );
  }

  private async enqueueFire(def: DeclaredSchedule): Promise<void> {
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

    const fireId = `fire-${Date.now()}`;

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
        // Use a stable singleton key to coalesce double-ticks within the
        // same wall-clock millisecond (rare but possible under load).
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
export function parseDeliveryTarget(deliverTo: string | undefined): {
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
