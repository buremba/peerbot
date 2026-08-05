/**
 * The success-side half of provider health: `signalCompletion()` must carry the
 * Lobu provider slug that resolution picked, because the gateway clears an
 * `inference_providers` error only when a completion names the provider that
 * served it (`recordProviderHealth` in the worker gateway).
 *
 * The error-side half already travels as `errorContext.provider`. Without this
 * stamp the mark would be write-only: a workspace that recovered would keep
 * reading `error` forever.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
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
    if (init?.body) sentPayloads.push(JSON.parse(init.body as string));
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("the completion carries the recorded provider slug", async () => {
  const transport = new HttpWorkerTransport(baseConfig);
  transport.recordProviderSlug("z-ai");

  await transport.signalCompletion();

  expect(sentPayloads.at(-1)?.providerSlug).toBe("z-ai");
});

test("a turn that never resolved a model claims no provider", async () => {
  const transport = new HttpWorkerTransport(baseConfig);

  await transport.signalCompletion();

  // Absent, not empty-string: the gateway must read this as "no signal", which
  // leaves an existing error mark in place rather than clearing it.
  expect(sentPayloads.at(-1)).not.toHaveProperty("providerSlug");
});

test("re-resolution within a turn stamps the provider that ran last", async () => {
  const transport = new HttpWorkerTransport(baseConfig);
  transport.recordProviderSlug("gemini");
  transport.recordProviderSlug("z-ai");

  await transport.signalCompletion();

  expect(sentPayloads.at(-1)?.providerSlug).toBe("z-ai");
});

test("an error row does not claim the provider is healthy", async () => {
  const transport = new HttpWorkerTransport(baseConfig);
  transport.recordProviderSlug("z-ai");

  await transport.signalError(
    new Error("429 Insufficient balance"),
    "PROVIDER_QUOTA_EXHAUSTED",
    { provider: "z-ai" }
  );

  const sent = sentPayloads.at(-1);
  expect(sent).not.toHaveProperty("providerSlug");
  expect(sent?.errorContext?.provider).toBe("z-ai");
});
