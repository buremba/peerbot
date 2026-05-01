/**
 * Tests for OpenClawWorker constructor validation and basic setup.
 * Full execution tests require the OpenClaw runtime and are covered
 * by integration tests via test-bot.sh.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenClawWorker } from "../openclaw/worker";
import { mockWorkerConfig, TestHelpers } from "./setup";

describe("OpenClawWorker", () => {
  let restoreFetch: () => void;
  let originalDispatcherUrl: string | undefined;
  let originalWorkerToken: string | undefined;

  beforeEach(() => {
    originalDispatcherUrl = process.env.DISPATCHER_URL;
    originalWorkerToken = process.env.WORKER_TOKEN;
    process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
    process.env.WORKER_TOKEN = "test-worker-token";
    restoreFetch = TestHelpers.mockFetch();
  });

  afterEach(() => {
    restoreFetch();
    if (originalDispatcherUrl) {
      process.env.DISPATCHER_URL = originalDispatcherUrl;
    } else {
      delete process.env.DISPATCHER_URL;
    }
    if (originalWorkerToken) {
      process.env.WORKER_TOKEN = originalWorkerToken;
    } else {
      delete process.env.WORKER_TOKEN;
    }
  });

  test("constructor requires DISPATCHER_URL", () => {
    const original = process.env.DISPATCHER_URL;
    delete process.env.DISPATCHER_URL;

    expect(
      () => new OpenClawWorker({ ...mockWorkerConfig, sessionKey: "missing" })
    ).toThrow(
      "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
    );

    process.env.DISPATCHER_URL = original;
  });

  test("constructor requires WORKER_TOKEN", () => {
    const original = process.env.WORKER_TOKEN;
    delete process.env.WORKER_TOKEN;

    expect(
      () => new OpenClawWorker({ ...mockWorkerConfig, sessionKey: "missing" })
    ).toThrow(
      "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
    );

    process.env.WORKER_TOKEN = original;
  });

  test("constructor requires teamId", () => {
    expect(
      () => new OpenClawWorker({ ...mockWorkerConfig, teamId: undefined })
    ).toThrow("teamId is required for worker initialization");
  });

  test("constructor requires conversationId", () => {
    expect(
      () =>
        new OpenClawWorker({
          ...mockWorkerConfig,
          conversationId: undefined as any,
        })
    ).toThrow("conversationId is required for worker initialization");
  });

  test("getWorkerTransport returns transport after construction", () => {
    const worker = new OpenClawWorker(mockWorkerConfig);
    expect(worker.getWorkerTransport()).not.toBeNull();
  });

  test("cleanup completes without error", async () => {
    const worker = new OpenClawWorker(mockWorkerConfig);
    await expect(worker.cleanup()).resolves.toBeUndefined();
  });
});
