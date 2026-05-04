import { describe, expect, mock, test } from "bun:test";
import { retryWithBackoff } from "../utils/retry";

describe("retryWithBackoff", () => {
  test("returns result on first success", async () => {
    const fn = mock(() => Promise.resolve("ok"));
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries on failure and returns on eventual success", async () => {
    let attempt = 0;
    const fn = mock(async () => {
      attempt++;
      if (attempt < 3) throw new Error(`fail ${attempt}`);
      return "success";
    });

    const result = await retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelay: 0,
    });
    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("throws last error when all retries exhausted", async () => {
    const fn = mock(async () => {
      throw new Error("always fails");
    });

    await expect(
      retryWithBackoff(fn, { maxRetries: 2, baseDelay: 0 })
    ).rejects.toThrow("always fails");
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("maxRetries=0 means single attempt, no retries", async () => {
    const fn = mock(async () => {
      throw new Error("fail");
    });

    await expect(
      retryWithBackoff(fn, { maxRetries: 0, baseDelay: 0 })
    ).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("calls onRetry callback with attempt number and error", async () => {
    let attempt = 0;
    const fn = async () => {
      attempt++;
      if (attempt < 3) throw new Error(`err-${attempt}`);
      return "done";
    };

    const retries: { attempt: number; message: string }[] = [];
    await retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelay: 0,
      onRetry: (attempt, error) => {
        retries.push({ attempt, message: error.message });
      },
    });

    expect(retries).toEqual([
      { attempt: 1, message: "err-1" },
      { attempt: 2, message: "err-2" },
    ]);
  });

  test("uses defaults when no options provided", async () => {
    const fn = mock(() => Promise.resolve(42));
    const result = await retryWithBackoff(fn);
    expect(result).toBe(42);
  });

  test("linear strategy increases delay linearly", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Patch setTimeout to capture delays (but resolve immediately)
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    let attempt = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempt++;
          if (attempt <= 3) throw new Error("fail");
          return "ok";
        },
        { maxRetries: 3, baseDelay: 100, strategy: "linear" }
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Linear: 100*(0+1)=100, 100*(1+1)=200, 100*(2+1)=300
    expect(delays).toEqual([100, 200, 300]);
  });

  test("exponential strategy doubles delay", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    let attempt = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempt++;
          if (attempt <= 3) throw new Error("fail");
          return "ok";
        },
        { maxRetries: 3, baseDelay: 100, strategy: "exponential" }
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Exponential: 100*2^0=100, 100*2^1=200, 100*2^2=400
    expect(delays).toEqual([100, 200, 400]);
  });

  test("shouldRetry=false aborts immediately and rethrows", async () => {
    const fn = mock(async () => {
      throw new Error("permanent");
    });

    await expect(
      retryWithBackoff(fn, {
        maxRetries: 5,
        baseDelay: 0,
        shouldRetry: () => false,
      })
    ).rejects.toThrow("permanent");
    // Only one call — no retries because shouldRetry returned false.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("shouldRetry receives the error and continues retrying when true", async () => {
    let attempt = 0;
    const seen: string[] = [];
    const fn = async () => {
      attempt++;
      if (attempt < 3) throw new Error(`transient-${attempt}`);
      return "ok";
    };

    const result = await retryWithBackoff(fn, {
      maxRetries: 5,
      baseDelay: 0,
      shouldRetry: (error) => {
        seen.push(error.message);
        return true;
      },
    });

    expect(result).toBe("ok");
    expect(seen).toEqual(["transient-1", "transient-2"]);
  });

  test("maxDelay caps the computed backoff", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    let attempt = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempt++;
          if (attempt <= 4) throw new Error("fail");
          return "ok";
        },
        {
          maxRetries: 4,
          baseDelay: 100,
          maxDelay: 250,
          strategy: "exponential",
        }
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // 100, 200, 400→capped 250, 800→capped 250
    expect(delays).toEqual([100, 200, 250, 250]);
  });

  test('jitter="full" multiplies delay by random in [1, 2)', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return originalSetTimeout(fn, 0);
    }) as any;

    let attempt = 0;
    try {
      await retryWithBackoff(
        async () => {
          attempt++;
          if (attempt <= 2) throw new Error("fail");
          return "ok";
        },
        { maxRetries: 2, baseDelay: 1000, jitter: "full" }
      );
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Full jitter multiplier is 1 + Math.random() ∈ [1, 2).
    // Base delays are 1000 (attempt 1) and 2000 (attempt 2), so jittered
    // delays must fall in [1000, 2000) and [2000, 4000) respectively.
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(2000);
    expect(delays[1]).toBeGreaterThanOrEqual(2000);
    expect(delays[1]).toBeLessThan(4000);
  });
});
