/**
 * Reproducer for Finding #18: the sandbox-leak redaction was dead on the
 * production success path because getFinalResult() always returned null
 * (setFinalResult() was only ever called in tests).
 *
 * runAISession() now sets the final result from the processor's output
 * snapshot on the success path, and the finalization (deliverFinalResult)
 * runs checkSandboxLeak against it. These tests drive that wiring:
 *  - WITHOUT the final result set (the old, broken state) the redaction never
 *    fires, even when the streamed output leaks.
 *  - WITH the final result set the way runAISession() now does, the redaction
 *    fires and a redacted full-replacement is sent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { OpenClawProgressProcessor } from "../openclaw/processor";
import { OpenClawWorker } from "../openclaw/worker";
import { mockWorkerConfig } from "./setup";

let originalDispatcherUrl: string | undefined;
let originalWorkerToken: string | undefined;

beforeEach(() => {
  originalDispatcherUrl = process.env.DISPATCHER_URL;
  originalWorkerToken = process.env.WORKER_TOKEN;
  process.env.DISPATCHER_URL = "https://test-dispatcher.example.com";
  process.env.WORKER_TOKEN = "test-worker-token";
});

afterEach(() => {
  if (originalDispatcherUrl === undefined) {
    delete process.env.DISPATCHER_URL;
  } else {
    process.env.DISPATCHER_URL = originalDispatcherUrl;
  }
  if (originalWorkerToken === undefined) {
    delete process.env.WORKER_TOKEN;
  } else {
    process.env.WORKER_TOKEN = originalWorkerToken;
  }
});

type SentDelta = {
  delta: string;
  isFullReplacement?: boolean;
  isFinal?: boolean;
};

function streamLeakyAssistantText(
  processor: OpenClawProgressProcessor,
  text: string
) {
  const event: AgentSessionEvent = {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", delta: text },
  } as unknown as AgentSessionEvent;
  processor.processEvent(event);
}

function buildWorkerWithRecorder() {
  const worker = new OpenClawWorker(mockWorkerConfig);
  const sent: SentDelta[] = [];
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  worker.workerTransport = {
    setJobId: noop,
    async sendStreamDelta(delta, isFullReplacement, isFinal) {
      sent.push({ delta, isFullReplacement, isFinal });
    },
    signalDone: asyncNoop,
    signalCompletion: asyncNoop,
    signalError: asyncNoop,
    sendStatusUpdate: asyncNoop,
    sendCustomEvent: asyncNoop,
  };
  const processor = (worker as any)
    .progressProcessor as OpenClawProgressProcessor;
  const deliverFinalResult = (worker as any).deliverFinalResult.bind(
    worker
  ) as (sawUploadedFileEvent: boolean) => Promise<void>;
  return { worker, sent, processor, deliverFinalResult };
}

const LEAKY_OUTPUT =
  "Here is your report: [report](/app/workspaces/abc/report.pdf)";

describe("sandbox-leak redaction wiring (Finding #18)", () => {
  test("redaction is dead when the final result is never set (old behavior)", async () => {
    const { sent, processor, deliverFinalResult } = buildWorkerWithRecorder();
    streamLeakyAssistantText(processor, LEAKY_OUTPUT);

    // Old production state: nothing calls setFinalResult, so getFinalResult()
    // is null and checkSandboxLeak never runs.
    await deliverFinalResult(false);

    // No redacted full-replacement was sent.
    expect(sent.some((s) => s.isFullReplacement)).toBe(false);
    expect(sent.some((s) => s.delta.includes("not actually upload"))).toBe(
      false
    );
  });

  test("redaction fires when the final result is set as runAISession now does", async () => {
    const { sent, processor, deliverFinalResult } = buildWorkerWithRecorder();
    streamLeakyAssistantText(processor, LEAKY_OUTPUT);

    // Mirror the production success-path wiring.
    processor.setFinalResult({
      text: processor.getOutputSnapshot(),
      isFinal: true,
    });

    await deliverFinalResult(false);

    // A redacted full-replacement was sent.
    const replacement = sent.find((s) => s.isFullReplacement);
    expect(replacement).toBeDefined();
    expect(replacement!.delta).not.toContain("/app/workspaces/abc/report.pdf");
    expect(replacement!.delta).toContain("](about:blank)");
    expect(replacement!.delta).toContain("did not actually upload");
  });

  test("clean output is not re-sent (no duplicate delivery)", async () => {
    const { sent, processor, deliverFinalResult } = buildWorkerWithRecorder();
    streamLeakyAssistantText(processor, "All done. Nothing leaked here.");

    processor.setFinalResult({
      text: processor.getOutputSnapshot(),
      isFinal: true,
    });

    await deliverFinalResult(false);

    // Already-streamed clean content must not be re-sent.
    expect(sent).toHaveLength(0);
  });
});
