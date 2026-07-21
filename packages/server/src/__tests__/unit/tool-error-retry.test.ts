/**
 * Retry-decision contract for the connector/query error taxonomy (lobu#2051 Item 2).
 *
 * The `executeTool` auto-retry wrapper drives `retryWithBackoff` with a
 * `shouldRetry` predicate that fires only for *retryable thrown* ToolErrors /
 * ToolUserErrors. This test pins that decision matrix directly against the same
 * primitive the wrapper uses, so a regression in the catalog's `retryable` flags
 * or the predicate shape is caught without spinning up the whole tool path.
 */

import { describe, expect, it } from "bun:test";
import { isToolError, retryWithBackoff, ToolError } from "@lobu/core";
import { ToolUserError } from "../../utils/errors";

// Mirror of the predicate in executeTool (kept in sync intentionally — the wrapper
// uses this exact shape). If executeTool's gate changes, this test should too.
function isRetryableToolError(err: Error): boolean {
  if (isToolError(err)) return err.retryable;
  if (err instanceof ToolUserError) return err.retryable;
  return false;
}

async function runWithRetry(fn: () => Promise<unknown>) {
  let calls = 0;
  const wrapped = async () => {
    calls++;
    return fn();
  };
  try {
    const result = await retryWithBackoff(wrapped, {
      maxRetries: 2,
      baseDelay: 1, // keep the test fast; behavior is identical
      shouldRetry: (err) => isRetryableToolError(err),
    });
    return { calls, result, threw: undefined as unknown };
  } catch (err) {
    return { calls, result: undefined, threw: err };
  }
}

describe("auto-retry decision", () => {
  it("retries a transient ToolError until it succeeds", async () => {
    let attempt = 0;
    const { calls, result } = await runWithRetry(async () => {
      attempt++;
      if (attempt < 3) throw new ToolError("RATE_LIMITED");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it("does NOT retry a permanent ToolError", async () => {
    const { calls, threw } = await runWithRetry(async () => {
      throw new ToolError("AUTH_MISSING");
    });
    expect(calls).toBe(1);
    expect(isToolError(threw)).toBe(true);
    expect((threw as ToolError).code).toBe("AUTH_MISSING");
  });

  it("retries a retryable ToolUserError", async () => {
    let attempt = 0;
    const { calls, result } = await runWithRetry(async () => {
      attempt++;
      if (attempt < 2) throw new ToolUserError("upstream 502", 502, "UPSTREAM_5XX");
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("does NOT retry a ToolUserError with no code (retryable=false)", async () => {
    const { calls, threw } = await runWithRetry(async () => {
      throw new ToolUserError("bad input", 400);
    });
    expect(calls).toBe(1);
    expect((threw as ToolUserError).retryable).toBe(false);
  });

  it("does NOT retry a NOT_FOUND ToolUserError", async () => {
    const { calls } = await runWithRetry(async () => {
      throw new ToolUserError("missing feed", 404, "NOT_FOUND");
    });
    expect(calls).toBe(1);
  });

  it("does NOT retry a plain Error", async () => {
    const { calls } = await runWithRetry(async () => {
      throw new Error("boom");
    });
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries when a transient error never clears", async () => {
    const { calls, threw } = await runWithRetry(async () => {
      throw new ToolError("UPSTREAM_TIMEOUT");
    });
    expect(calls).toBe(3); // 1 initial + 2 retries, then rethrow
    expect((threw as ToolError).code).toBe("UPSTREAM_TIMEOUT");
  });
});

describe("ToolUserError taxonomy fields", () => {
  it("derives retryable from the code via the catalog", () => {
    expect(new ToolUserError("x", 429, "RATE_LIMITED").retryable).toBe(true);
    expect(new ToolUserError("x", 401, "AUTH_INVALID").retryable).toBe(false);
    expect(new ToolUserError("x", 400).retryable).toBe(false);
  });
});
