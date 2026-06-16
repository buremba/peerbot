import { describe, expect, test } from "bun:test";
import { extractApiError, fetchWithRetry } from "../http.js";

describe("fetchWithRetry", () => {
  test("retries a 5xx GET up to the bound, then returns the last response", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("boom", { status: 503, statusText: "Unavailable" });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry(
      "https://api.test/x",
      { method: "GET" },
      { fetchImpl, retries: 2 }
    );
    // 1 initial + 2 retries = 3 attempts, then surfaces the 503 to the caller.
    expect(calls).toBe(3);
    expect(res.status).toBe(503);
  });

  test("stops early once a GET succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 2)
        return new Response("", { status: 500, statusText: "err" });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry(
      "https://api.test/x",
      { method: "GET" },
      { fetchImpl, retries: 3 }
    );
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
  });

  test("does not retry non-GET methods on 5xx", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 500, statusText: "err" });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry(
      "https://api.test/x",
      { method: "POST" },
      { fetchImpl }
    );
    expect(calls).toBe(1);
    expect(res.status).toBe(500);
  });

  test("retries on a network error then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchWithRetry(
      "https://api.test/x",
      { method: "GET" },
      { fetchImpl, retries: 1 }
    );
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
  });

  test("injects a timeout signal only when the caller provided none", async () => {
    let sawSignal = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sawSignal = init.signal instanceof AbortSignal;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchWithRetry(
      "https://api.test/x",
      { method: "GET" },
      { fetchImpl }
    );
    expect(sawSignal).toBe(true);
  });
});

describe("extractApiError", () => {
  test("string error prefers error_description, falls back to error", () => {
    expect(
      extractApiError(
        { error: "invalid_grant", error_description: "Token expired" },
        400,
        "Bad Request"
      )
    ).toEqual({ message: "Token expired", code: "invalid_grant" });

    expect(extractApiError({ error: "nope" }, 409, "Conflict")).toEqual({
      message: "nope",
      code: "nope",
    });
  });

  test("object error reads message + code", () => {
    expect(
      extractApiError(
        { error: { message: "boom", code: "x_failed" } },
        500,
        "Server Error"
      )
    ).toEqual({ message: "boom", code: "x_failed" });
  });

  test("falls back to HTTP status when no envelope matches", () => {
    expect(extractApiError(null, 503, "Unavailable")).toEqual({
      message: "HTTP 503 Unavailable",
    });
  });
});
