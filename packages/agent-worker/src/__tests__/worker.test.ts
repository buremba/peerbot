/**
 * Tests for LobuAgentWorker constructor validation and basic setup.
 * Full execution tests require the Lobu runtime and are covered
 * by integration tests via test-bot.sh.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LobuAgentWorker } from "../runtime/worker";
import { mockWorkerConfig, TestHelpers } from "./setup";

describe("LobuAgentWorker", () => {
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
      () => new LobuAgentWorker({ ...mockWorkerConfig, sessionKey: "missing" })
    ).toThrow(
      "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
    );

    process.env.DISPATCHER_URL = original;
  });

  test("constructor requires WORKER_TOKEN", () => {
    const original = process.env.WORKER_TOKEN;
    delete process.env.WORKER_TOKEN;

    expect(
      () => new LobuAgentWorker({ ...mockWorkerConfig, sessionKey: "missing" })
    ).toThrow(
      "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
    );

    process.env.WORKER_TOKEN = original;
  });

  test("constructor requires teamId", () => {
    expect(
      () => new LobuAgentWorker({ ...mockWorkerConfig, teamId: undefined })
    ).toThrow("teamId is required for worker initialization");
  });

  test("constructor requires conversationId", () => {
    expect(
      () =>
        new LobuAgentWorker({
          ...mockWorkerConfig,
          conversationId: undefined as any,
        })
    ).toThrow("conversationId is required for worker initialization");
  });

  test("getWorkerTransport returns transport after construction", () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    expect(worker.getWorkerTransport()).not.toBeNull();
  });

  test("cleanup completes without error", async () => {
    const worker = new LobuAgentWorker(mockWorkerConfig);
    await expect(worker.cleanup()).resolves.toBeUndefined();
  });

  test("a successful session reset acknowledges completion without checkpointing the deleted transcript", async () => {
    const worker = new LobuAgentWorker({
      ...mockWorkerConfig,
      runId: 1,
      runJobToken: "reset-run-token",
      platformMetadata: { sessionReset: true },
    });
    const checkpointSuccessfulRun = mock(async () => {
      throw new Error("reset transcript should not be checkpointed");
    });
    const signalDone = mock(async () => undefined);
    const asyncNoop = async () => undefined;

    (worker as any).workspaceManager = {
      setupWorkspace: asyncNoop,
      getCurrentWorkingDirectory: () => "/tmp",
    };
    (worker as any).setupIODirectories = asyncNoop;
    (worker as any).downloadInputFiles = asyncNoop;
    (worker as any).getFileIOInstructions = () => "";
    (worker as any).runAISession = async () => ({
      success: true,
      exitCode: 0,
      output: "Context saved. Starting fresh.",
      sessionKey: mockWorkerConfig.sessionKey,
    });
    (worker as any).checkpointSuccessfulRun = checkpointSuccessfulRun;
    (worker as any).deliverFinalResult = asyncNoop;
    worker.workerTransport = {
      setJobId: () => undefined,
      sendStreamDelta: asyncNoop,
      signalDone,
      signalCompletion: asyncNoop,
      signalError: asyncNoop,
      sendStatusUpdate: asyncNoop,
      sendCustomEvent: asyncNoop,
    };

    await worker.execute();

    expect(checkpointSuccessfulRun).not.toHaveBeenCalled();
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  // Shared harness for the checkpoint-gating tests below.
  function wireExecutableWorker(worker: LobuAgentWorker) {
    const checkpointSuccessfulRun = mock(async () => undefined);
    const signalDone = mock(async () => undefined);
    const asyncNoop = async () => undefined;
    (worker as any).workspaceManager = {
      setupWorkspace: asyncNoop,
      getCurrentWorkingDirectory: () => "/tmp",
    };
    (worker as any).setupIODirectories = asyncNoop;
    (worker as any).downloadInputFiles = asyncNoop;
    (worker as any).getFileIOInstructions = () => "";
    (worker as any).runAISession = async () => ({
      success: true,
      exitCode: 0,
      output: "done",
      sessionKey: mockWorkerConfig.sessionKey,
    });
    (worker as any).checkpointSuccessfulRun = checkpointSuccessfulRun;
    (worker as any).deliverFinalResult = asyncNoop;
    worker.workerTransport = {
      setJobId: () => undefined,
      sendStreamDelta: asyncNoop,
      signalDone,
      signalCompletion: asyncNoop,
      signalError: asyncNoop,
      sendStatusUpdate: asyncNoop,
      sendCustomEvent: asyncNoop,
    } as any;
    return { checkpointSuccessfulRun, signalDone };
  }

  test("a starters turn completes WITHOUT checkpointing a transcript snapshot", async () => {
    const worker = new LobuAgentWorker({
      ...mockWorkerConfig,
      runId: 2,
      runJobToken: "starters-run-token",
      platformMetadata: { source: "starters" },
    });
    const { checkpointSuccessfulRun, signalDone } =
      wireExecutableWorker(worker);

    await worker.execute();

    // The hidden starters turn's reply is discarded — no transcript snapshot.
    expect(checkpointSuccessfulRun).not.toHaveBeenCalled();
    expect(signalDone).toHaveBeenCalledTimes(1);
  });

  test("a normal turn DOES checkpoint its transcript snapshot", async () => {
    const worker = new LobuAgentWorker({
      ...mockWorkerConfig,
      runId: 3,
      runJobToken: "normal-run-token",
      platformMetadata: { source: "direct-api" },
    });
    const { checkpointSuccessfulRun, signalDone } =
      wireExecutableWorker(worker);

    await worker.execute();

    expect(checkpointSuccessfulRun).toHaveBeenCalledTimes(1);
    expect(signalDone).toHaveBeenCalledTimes(1);
  });
});
