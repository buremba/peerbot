/**
 * Reproducer: ONE failed turn must produce exactly ONE user-facing error.
 *
 * Observed live (Gemini-only deployment, single Telegram DM "what is the
 * capital of Japan?"): the user received THREE messages for one question —
 *   1. `401 No provider credentials configured…` + a reconnect CTA
 *   2. `Tokyo`   (the correct answer — the turn actually SUCCEEDED)
 *   3. `💥 Worker crashed: Provider finish_reason: … MALFORMED_FUNCTION_CALL`
 *
 * Root cause: three independent, uncoordinated emitters each call `signalError`
 * for the same turn —
 *   (a) `worker.ts` result-false branch  → handleExecutionError
 *   (b) `worker.ts` catch branch         → handleExecutionError
 *   (c) `sse-client.ts` outer catch      → signalError with NO errorCode
 * Every `signalError` is a terminal POST that the gateway turns into its own
 * chat message. Unlike the turn-liveness marker election (`failTurnIfPending`),
 * nothing dedupes these.
 *
 * The transport is the single funnel all three pass through, so it is where the
 * once-per-turn election belongs: the FIRST error wins (it carries the real
 * classification), later ones are logged and dropped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WorkerTransportConfig } from "@lobu/core";
import { HttpWorkerTransport } from "../gateway/gateway-integration";
import type { ResponseData } from "../gateway/types";

const baseConfig: WorkerTransportConfig = {
  gatewayUrl: "https://test-gateway.example.com",
  workerToken: "test-worker-token",
  userId: "U123",
  channelId: "C123",
  conversationId: "CONV123",
  originalMessageTs: "1700000000.000100",
  teamId: "T123",
  platform: "slack",
};

let originalFetch: typeof globalThis.fetch;
let sentPayloads: ResponseData[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  sentPayloads = [];
  globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
    const init = args[1];
    if (init?.body) {
      sentPayloads.push(JSON.parse(init.body as string));
    }
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const errorPayloads = () => sentPayloads.filter((p) => p.error !== undefined);

describe("signalError is once-per-turn", () => {
  test("a second signalError for the same turn is dropped", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    // (a) the real, classified failure the worker detected.
    await transport.signalError(
      new Error("401 No provider credentials configured."),
      "PROVIDER_AUTH",
      { provider: "gemini", model: "gemini-2.5-flash" }
    );
    // (c) sse-client's outer catch re-signals the SAME turn with no code.
    await transport.signalError(
      new Error("Provider finish_reason: function_call_filter")
    );

    const errors = errorPayloads();
    expect(errors).toHaveLength(1);
    // The FIRST (classified) error is the one that survives — it carries the
    // actionable code and CTA context.
    expect(errors[0].error).toBe("401 No provider credentials configured.");
    expect(errors[0].errorCode).toBe("PROVIDER_AUTH");
  });

  test("three emitters still yield exactly one user-facing error", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.signalError(new Error("first"), "PROVIDER_QUOTA_EXHAUSTED");
    await transport.signalError(new Error("second"));
    await transport.signalError(new Error("third"), "PROVIDER_AUTH");

    const errors = errorPayloads();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("first");
  });

  test("a successful turn's completion is unaffected by the error latch", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.signalCompletion();
    expect(errorPayloads()).toHaveLength(0);
    // Completion still posted.
    expect(sentPayloads.length).toBeGreaterThan(0);
  });

  test("a FAILED first delivery does not suppress the retry", async () => {
    // The latch must not swallow the terminal error when the first send never
    // reached the gateway. `sendResponse` retries internally and throws on
    // ultimate failure; latching before delivery would leave the user with NO
    // terminal error at all — worse than the duplicate the latch prevents.
    const transport = new HttpWorkerTransport(baseConfig);

    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as typeof globalThis.fetch;

    await expect(
      transport.signalError(new Error("first attempt"), "PROVIDER_AUTH")
    ).rejects.toThrow();

    // Gateway recovers; the caller's retry must still get through.
    globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      const init = args[1];
      if (init?.body) sentPayloads.push(JSON.parse(init.body as string));
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    await transport.signalError(new Error("second attempt"), "PROVIDER_AUTH");

    const errors = errorPayloads();
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("second attempt");
  });

  test("a fresh transport (next turn) can signal an error again", async () => {
    const first = new HttpWorkerTransport(baseConfig);
    await first.signalError(new Error("turn-1 failure"), "PROVIDER_AUTH");

    const second = new HttpWorkerTransport(baseConfig);
    await second.signalError(new Error("turn-2 failure"), "PROVIDER_AUTH");

    const errors = errorPayloads();
    expect(errors).toHaveLength(2);
    expect(errors[0].error).toBe("turn-1 failure");
    expect(errors[1].error).toBe("turn-2 failure");
  });
});
