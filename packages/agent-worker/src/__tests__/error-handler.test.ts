/**
 * Tests for handleExecutionError (Finding #9): SESSION_TIMEOUT must NOT surface
 * a user-facing "💥 Worker crashed" delta — the run is retried automatically by
 * the runs queue, so the timeout is only signalled (with an errorCode) for
 * bookkeeping/cleanup.
 */

import { describe, expect, test } from "bun:test";
import type { WorkerTransport } from "@lobu/core";
import { handleExecutionError } from "../core/error-handler";

type Recorder = {
  transport: WorkerTransport;
  deltas: Array<{
    delta: string;
    isFullReplacement?: boolean;
    isFinal?: boolean;
  }>;
  errors: Array<{ message: string; code?: string }>;
};

function makeTransport(): Recorder {
  const deltas: Recorder["deltas"] = [];
  const errors: Recorder["errors"] = [];
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const transport: WorkerTransport = {
    setJobId: noop,
    async sendStreamDelta(delta, isFullReplacement, isFinal) {
      deltas.push({ delta, isFullReplacement, isFinal });
    },
    signalDone: asyncNoop,
    signalCompletion: asyncNoop,
    async signalError(error, errorCode) {
      errors.push({ message: error.message, code: errorCode });
    },
    sendStatusUpdate: asyncNoop,
    sendCustomEvent: asyncNoop,
  };
  return { transport, deltas, errors };
}

describe("handleExecutionError", () => {
  test("SESSION_TIMEOUT does not emit a user-facing crash delta", async () => {
    const { transport, deltas, errors } = makeTransport();

    await handleExecutionError(new Error("SESSION_TIMEOUT"), transport);

    // No user-facing delta at all (especially no "💥 Worker crashed").
    expect(deltas).toHaveLength(0);
    // But the error is still signalled with a classification code so the
    // gateway/cleanup path can act on it.
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("SESSION_TIMEOUT");
    expect(errors[0].code).toBe("SESSION_TIMEOUT");
  });

  test("generic errors still emit a user-facing crash delta", async () => {
    const { transport, deltas, errors } = makeTransport();

    await handleExecutionError(new Error("kaboom"), transport);

    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toContain("💥 Worker crashed: kaboom");
    expect(deltas[0].isFullReplacement).toBe(true);
    expect(deltas[0].isFinal).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBeUndefined();
  });

  test("NO_MODEL_CONFIGURED signals code without a user-facing delta", async () => {
    const { transport, deltas, errors } = makeTransport();

    await handleExecutionError(new Error("No model configured"), transport);

    expect(deltas).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("NO_MODEL_CONFIGURED");
  });
});
