import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/client.js";
import {
  FixedWindowRateLimiter,
  getClientIp,
} from "../../utils/rate-limiter.js";
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from "../helpers/db-setup.js";

describe("FixedWindowRateLimiter", () => {
  beforeAll(async () => {
    await ensurePgliteForGatewayTests();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  test("allows requests within the window and blocks after the limit", async () => {
    const limiter = new FixedWindowRateLimiter();

    const first = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });
    const second = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });
    const third = await limiter.consume({
      key: "rate:test:1",
      limit: 2,
      windowSeconds: 60,
    });

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("resets after the time window", async () => {
    const limiter = new FixedWindowRateLimiter();

    await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    const blocked = await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    expect(blocked.allowed).toBe(false);

    // Force the existing window to be in the past so the next consume()
    // resets the counter via the CASE branch — no clock-shim needed.
    const sql = getDb();
    await sql`UPDATE rate_limits SET expires_at = now() - interval '1 second' WHERE key = 'rate:test:2'`;

    const reset = await limiter.consume({
      key: "rate:test:2",
      limit: 1,
      windowSeconds: 60,
    });
    expect(reset.allowed).toBe(true);
    expect(reset.count).toBe(1);
  });

  test("reset clears the tracked key", async () => {
    const limiter = new FixedWindowRateLimiter();

    await limiter.consume({
      key: "rate:test:3",
      limit: 1,
      windowSeconds: 60,
    });
    await limiter.reset("rate:test:3");

    const next = await limiter.consume({
      key: "rate:test:3",
      limit: 1,
      windowSeconds: 60,
    });
    expect(next.allowed).toBe(true);
    expect(next.count).toBe(1);
  });
});

describe("getClientIp", () => {
  test("prefers x-forwarded-for, then x-real-ip, then unknown", () => {
    expect(
      getClientIp({
        forwardedFor: "203.0.113.1, 10.0.0.1",
        realIp: "198.51.100.1",
      })
    ).toBe("203.0.113.1");

    expect(
      getClientIp({
        realIp: "198.51.100.1",
      })
    ).toBe("198.51.100.1");

    expect(getClientIp({})).toBe("unknown");
  });
});
