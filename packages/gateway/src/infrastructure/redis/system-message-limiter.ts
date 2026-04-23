import { createLogger } from "@lobu/core";
import type Redis from "ioredis";

const logger = createLogger("system-message-limiter");

interface SendOnceOptions {
  /**
   * How long to remember that this message was successfully sent.
   * This is the main debounce window.
   */
  sentTtlSeconds: number;
  /**
   * How long to hold an in-flight lock to prevent concurrent duplicate sends.
   * Keep short (10-60s) to bound crash edge cases.
   */
  lockTtlSeconds?: number;
  /**
   * If Redis is unavailable, allow the send to proceed (fail-open) or suppress it (fail-closed).
   * For spammy system prompts, fail-closed is usually safer.
   */
  failOpen?: boolean;
}

/**
 * Generic idempotency gate for outbound "system" messages (auth/setup prompts, warnings, etc.).
 *
 * Pattern:
 * - `sentKey` is written only after a successful send.
 * - `lockKey` prevents concurrent callers from sending duplicates while the first send is in-flight.
 *
 * This is intentionally small and Redis-only (no in-memory fallback) so behavior is consistent
 * across replicas.
 */
export class SystemMessageLimiter {
  constructor(
    private redis: Redis,
    private namespace: string = "sysmsg"
  ) {}

  async sendOnce(
    dedupeKey: string,
    sendFn: () => Promise<void>,
    options: SendOnceOptions
  ): Promise<boolean> {
    const sentTtlSeconds = Math.max(1, options.sentTtlSeconds);
    const lockTtlSeconds = Math.max(1, options.lockTtlSeconds ?? 30);
    const failOpen = options.failOpen ?? false;

    const sentKey = `${this.namespace}:sent:${dedupeKey}`;
    const lockKey = `${this.namespace}:lock:${dedupeKey}`;

    try {
      const alreadySent = (await this.redis.exists(sentKey)) === 1;
      if (alreadySent) {
        return false;
      }

      // Use a lock so concurrent callers (or retries) don't double-send before sentKey is written.
      const lockResult = await this.redis.set(
        lockKey,
        "1",
        "EX",
        lockTtlSeconds,
        "NX"
      );
      if (lockResult !== "OK") {
        return false;
      }
    } catch (error) {
      logger.warn(
        { error: String(error), sentKey, lockKey, failOpen },
        "Redis unavailable while gating system message"
      );
      return failOpen;
    }

    try {
      await sendFn();
      // Mark as sent only after successful delivery attempt.
      await this.redis.set(sentKey, "1", "EX", sentTtlSeconds);
      return true;
    } finally {
      // Best-effort lock cleanup; key also expires automatically.
      try {
        await this.redis.del(lockKey);
      } catch (error) {
        logger.debug(
          { error: String(error), lockKey },
          "Failed to release system-message lock"
        );
      }
    }
  }
}
