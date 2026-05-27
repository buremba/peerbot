/**
 * Reproducer: `signalCompletion()` must send an AUTHORITATIVE `finalText`.
 *
 * `finalText` is the multi-replica delivery mechanism (PR #1087): a possibly-
 * different replica than the one that streamed delivers it to Slack and
 * persists it to chat history (gateway `chat-response-bridge.ts` /
 * `platform-strategies/index.ts`).
 *
 * Bug (CodeRabbit, merged #1087): in `sendStreamDelta(...)`'s `isFinal`
 * "content differs" branch, the FULL final `delta` was pushed onto
 * `accumulatedStreamContent` — which already held the *partial streamed*
 * content. So `accumulatedStreamContent.join("")` (the old `finalText` source)
 * became `partial_stream + full_final` → a garbled `finalText` delivered
 * cross-pod and written to history.
 *
 * These tests drive the divergent-final branch and assert `finalText` equals
 * the authoritative full final, not partial+full. The happy paths (final
 * identical to / a prefix-extension of the stream) are also covered to guard
 * the dedupe optimizations.
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
  // Capture every payload POSTed to the gateway's /worker/response endpoint.
  // `fetch(url, init)` — we only need `init` (the second positional arg), so
  // bind the args via rest and read index 1 rather than naming an unused URL
  // parameter.
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

/** The `finalText` carried on the terminal completion row. */
function completionFinalText(): string | undefined {
  const completion = sentPayloads.find((p) => "finalText" in p);
  return completion?.finalText;
}

describe("HttpWorkerTransport finalText is authoritative", () => {
  test("divergent final: finalText is the full final, NOT partial+full", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    // Stream a couple of partial deltas.
    await transport.sendStreamDelta("Hello ");
    await transport.sendStreamDelta("wor");

    // Final result that is neither identical to nor a prefix-extension of the
    // accumulated stream ("Hello wor") → the "content differs" branch.
    const finalAnswer = "Completely different answer.";
    await transport.sendStreamDelta(finalAnswer, false, true);

    await transport.signalCompletion();

    // The OLD logic produced "Hello wor" + "Completely different answer."
    // (accumulatedStreamContent.join("")). The fix sends the authoritative
    // full final only.
    expect(completionFinalText()).toBe(finalAnswer);
    expect(completionFinalText()).not.toBe(
      "Hello worCompletely different answer."
    );
    expect(completionFinalText()).not.toContain("Hello wor");
  });

  test("prefix-extension final: finalText is the full final text", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.sendStreamDelta("Hello ");
    await transport.sendStreamDelta("wor");
    // Final extends the stream (accumulated is a prefix of the final).
    await transport.sendStreamDelta("Hello world!", false, true);

    await transport.signalCompletion();

    expect(completionFinalText()).toBe("Hello world!");
  });

  test("identical final: finalText is the full final text", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.sendStreamDelta("Hello ");
    await transport.sendStreamDelta("world");
    // Final identical to accumulated → dedupe skips the duplicate delta send,
    // but finalText must still be authoritative.
    await transport.sendStreamDelta("Hello world", false, true);

    await transport.signalCompletion();

    expect(completionFinalText()).toBe("Hello world");
  });

  test("pure streaming (no explicit final): finalText falls back to the stream", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.sendStreamDelta("Hello ");
    await transport.sendStreamDelta("world");

    // No isFinal delta was sent — the accumulation IS the final text.
    await transport.signalCompletion();

    expect(completionFinalText()).toBe("Hello world");
  });

  test("signalDone with a divergent final delta yields the authoritative finalText", async () => {
    const transport = new HttpWorkerTransport(baseConfig);

    await transport.sendStreamDelta("Hello ");
    await transport.sendStreamDelta("wor");

    // signalDone(finalDelta) sends the final delta (isFinal) then completes.
    await transport.signalDone("Completely different answer.");

    expect(completionFinalText()).toBe("Completely different answer.");
  });
});
