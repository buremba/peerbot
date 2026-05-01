/**
 * Unit tests for `RunsQueue` helpers and shape.
 *
 * The integration tests that exercise a real Postgres claim loop live in
 * `src/gateway/__tests__/integration/runs-queue.integration.test.ts` and are
 * gated on `DATABASE_URL`.
 */

import { describe, expect, test } from "bun:test";
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
