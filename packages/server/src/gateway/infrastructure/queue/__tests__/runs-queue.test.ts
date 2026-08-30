/**
 * Unit tests for `RunsQueue` helpers and shape.
 *
 * The integration tests that exercise a real Postgres claim loop live in
 * `src/gateway/__tests__/integration/runs-queue.integration.test.ts` and are
 * gated on `DATABASE_URL`.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  backoffSeconds,
  classifyQueue,
  RunsQueue,
} from "../runs-queue.js";

describe("classifyQueue", () => {
  test("messages -> chat_message", () => {
    expect(classifyQueue("messages")).toBe("chat_message");
  });
  test("thread_message_* -> chat_message", () => {
    expect(classifyQueue("thread_message_telegram-1234")).toBe("chat_message");
  });
  test("thread_response -> chat_message", () => {
    expect(classifyQueue("thread_response")).toBe("chat_message");
  });
  test("messages:dlq -> chat_message", () => {
    expect(classifyQueue("messages:dlq")).toBe("chat_message");
  });
  test("schedule -> schedule", () => {
    expect(classifyQueue("schedule")).toBe("schedule");
    expect(classifyQueue("schedule:cron")).toBe("schedule");
  });
  test("agent_run -> agent_run", () => {
    expect(classifyQueue("agent_run")).toBe("agent_run");
    expect(classifyQueue("agent_run:abc123")).toBe("agent_run");
  });
  test("internal -> internal", () => {
    expect(classifyQueue("internal")).toBe("internal");
    expect(classifyQueue("internal:metrics")).toBe("internal");
  });
  test("task -> task", () => {
    expect(classifyQueue("task")).toBe("task");
    expect(classifyQueue("task:cron-tick")).toBe("task");
  });
});

describe("backoffSeconds", () => {
  test("exponential ramp", () => {
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(2)).toBe(4);
    expect(backoffSeconds(3)).toBe(8);
    expect(backoffSeconds(4)).toBe(16);
  });
  test("capped at 300s", () => {
    expect(backoffSeconds(20)).toBe(300);
  });
  test("attempt 0 is 1s", () => {
    expect(backoffSeconds(0)).toBe(1);
  });
});

describe("RunsQueue construction", () => {
  test("requires DATABASE_URL", () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => new RunsQueue({})).toThrow(
        /DATABASE_URL is required/,
      );
    } finally {
      if (prev) process.env.DATABASE_URL = prev;
    }
  });
  test("constructs when DATABASE_URL is set (no per-instance config required)", () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    try {
      expect(() => new RunsQueue()).not.toThrow();
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
      else delete process.env.DATABASE_URL;
    }
  });
});

describe("RunsQueue worker registration", () => {
  test("re-registering a queue preserves its single active handler", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    const queue = new RunsQueue();
    if (previousDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = previousDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    const claimed = [
      {
        runId: 1,
        payload: { turn: 1 },
        attempts: 0,
        maxAttempts: 3,
        retryDelaySeconds: null,
      },
      {
        runId: 2,
        payload: { turn: 2 },
        attempts: 0,
        maxAttempts: 3,
        retryDelaySeconds: null,
      },
    ];
    let releaseFirst: (() => void) | null = null;
    let signalFirstStarted: (() => void) | null = null;
    let signalSecondStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      signalSecondStarted = resolve;
    });
    let activeHandlers = 0;
    let maxActiveHandlers = 0;

    // Keep this a unit test: drive the production worker loop with deterministic
    // claims while replacing only the database-facing seams.
    (queue as any).isConnected = true;
    (queue as any).ensureChannelListened = async () => undefined;
    (queue as any).claimOne = async () => claimed.shift() ?? null;
    (queue as any).heartbeatClaim = async () => undefined;
    (queue as any).markCompleted = async () => undefined;

    const firstHandler = async () => {
      activeHandlers += 1;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      signalFirstStarted?.();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      activeHandlers -= 1;
    };
    const replacementHandler = async () => {
      activeHandlers += 1;
      maxActiveHandlers = Math.max(maxActiveHandlers, activeHandlers);
      signalSecondStarted?.();
      activeHandlers -= 1;
    };

    try {
      await queue.work("same-conversation", firstHandler);
      await firstStarted;

      // Worker SSE reconnects call work() again for the same deployment. The
      // replacement may update future delivery handling, but it must not start
      // a second claim loop alongside the turn already in flight.
      await queue.work("same-conversation", replacementHandler);
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(maxActiveHandlers).toBe(1);

      releaseFirst?.();
      await Promise.race([
        secondStarted,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("second turn was not processed")), 500)
        ),
      ]);
      expect(maxActiveHandlers).toBe(1);
    } finally {
      releaseFirst?.();
      for (const worker of (queue as any).workers.values()) {
        worker.stopped = true;
        worker.wakeup();
      }
      (queue as any).workers.clear();
    }
  });

  test("stop fences and releases a claim that resolves during shutdown", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    const queue = new RunsQueue();
    if (previousDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = previousDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }

    let signalClaimStarted: (() => void) | null = null;
    let releaseClaimAttempt: (() => void) | null = null;
    const claimStarted = new Promise<void>((resolve) => {
      signalClaimStarted = resolve;
    });
    const claimMayFinish = new Promise<void>((resolve) => {
      releaseClaimAttempt = resolve;
    });
    const claimedRows = new Set<number>();
    const handler = mock(async () => undefined);
    let signalReleasedAfterShutdown: (() => void) | null = null;
    const releasedAfterShutdown = new Promise<void>((resolve) => {
      signalReleasedAfterShutdown = resolve;
    });
    const releaseClaim = mock(async (runId: number) => {
      claimedRows.delete(runId);
      signalReleasedAfterShutdown?.();
    });

    (queue as any).isConnected = true;
    // Exercise the hard-timeout path without waiting 30 seconds: stop returns
    // while claimOne is still held, so its later continuation owns the release.
    (queue as any).shutdownDrainMs = 0;
    (queue as any).ensureChannelListened = async () => undefined;
    (queue as any).claimOne = async () => {
      signalClaimStarted?.();
      await claimMayFinish;
      claimedRows.add(41);
      return {
        runId: 41,
        payload: { turn: 1 },
        attempts: 0,
        maxAttempts: 3,
        retryDelaySeconds: null,
      };
    };
    (queue as any).releaseClaim = releaseClaim;
    (queue as any).releaseAllClaims = async () => {
      const count = claimedRows.size;
      claimedRows.clear();
      return count;
    };
    (queue as any).heartbeatClaim = async () => undefined;
    (queue as any).markCompleted = async () => undefined;

    try {
      await queue.work("shutdown-race", handler);
      await claimStarted;
      expect((queue as any).workers.get("shutdown-race").claiming).toBe(1);

      await queue.stop();
      releaseClaimAttempt?.();
      await Promise.race([
        releasedAfterShutdown,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("late claim was not released")),
            500,
          )
        ),
      ]);

      expect(handler).not.toHaveBeenCalled();
      expect(releaseClaim).toHaveBeenCalledWith(41);
      expect(claimedRows.size).toBe(0);
    } finally {
      releaseClaimAttempt?.();
      for (const worker of (queue as any).workers.values()) {
        worker.stopped = true;
        worker.wakeup();
      }
      (queue as any).workers.clear();
    }
  });
});
