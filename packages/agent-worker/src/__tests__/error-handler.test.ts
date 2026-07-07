/**
 * Tests for handleExecutionError (Finding #9): SESSION_TIMEOUT must NOT surface
 * a user-facing "💥 Worker crashed" delta — the run is retried automatically by
 * the runs queue, so the timeout is only signalled (with an errorCode) for
 * bookkeeping/cleanup.
 */

import { describe, expect, test } from "bun:test";
import type { WorkerTransport } from "@lobu/core";
import { classifyError, handleExecutionError } from "../core/error-handler";

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

  test("classified PROVIDER_* failures signal code + context, NO worker delta", async () => {
    const { transport, deltas, errors } = makeTransport();

    await handleExecutionError(
      new Error('Model "gpt-nope" not found for provider "openai".'),
      transport
    );

    // New contract: the gateway renderer owns the user-facing text (via
    // AGENT_ERRORS), so the worker must NOT also emit a formatted delta —
    // that historical double-formatting is exactly what made the same error
    // render differently across surfaces.
    expect(deltas).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("PROVIDER_UNKNOWN_MODEL");
  });

  test("provider routing failures signal a code, not a crash delta", async () => {
    const { transport, deltas, errors } = makeTransport();

    await handleExecutionError(
      new Error(
        'The selected model (z-ai/glm-5.2) uses provider "z-ai", but that provider is not connected to this agent.'
      ),
      transport
    );

    expect(deltas).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("PROVIDER_BASE_URL_UNRESOLVED");
  });

  test("provider QUOTA (z.ai 429) classifies + relays the raw message verbatim", async () => {
    const { transport, deltas, errors } = makeTransport();

    // The exact prod shape from the app pod logs.
    const raw =
      "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
    await handleExecutionError(new Error(raw), transport, { provider: "z-ai" });

    // No worker-formatted delta — the renderer presents it (raw message body +
    // the code's CTA link). The raw message reaches the wire UNCHANGED: it
    // already tells the user when the quota resets, so we relay it verbatim
    // instead of parsing a reset time out of it.
    expect(deltas).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(errors[0].message).toBe(raw);
  });
});

describe("classifyError", () => {
  test("recognizes provider auth failures", () => {
    expect(classifyError(new Error("Authentication failed for openai"))).toBe(
      "PROVIDER_AUTH"
    );
    expect(classifyError(new Error("incorrect api key provided"))).toBe(
      "PROVIDER_AUTH"
    );
    // The secret-proxy's every-tier-missed 401 (live red-test LOBU-BACKEND-W
    // landed as `unclassified` and dodged the PROVIDER_* alert).
    expect(
      classifyError(
        new Error(
          "401 No provider credentials configured. End-user provider setup is not available in chat yet."
        )
      )
    ).toBe("PROVIDER_AUTH");
  });

  test("recognizes unknown-model failures", () => {
    expect(
      classifyError(
        new Error('Model "x" not found for provider "openai". Check ...')
      )
    ).toBe("PROVIDER_UNKNOWN_MODEL");
    expect(
      classifyError(new Error("400 gpt-foo is not a valid model ID"))
    ).toBe("PROVIDER_UNKNOWN_MODEL");
  });

  test("recognizes unresolved provider base URL", () => {
    expect(
      classifyError(
        new Error('Could not resolve a base URL for provider "z-ai".')
      )
    ).toBe("PROVIDER_BASE_URL_UNRESOLVED");
    expect(
      classifyError(
        new Error(
          'The selected model (z-ai/glm-5.2) uses provider "z-ai", but that provider is not connected to this agent.'
        )
      )
    ).toBe("PROVIDER_BASE_URL_UNRESOLVED");
  });

  test("recognizes provider quota / rate-limit exhaustion", () => {
    expect(
      classifyError(
        new Error(
          "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47"
        )
      )
    ).toBe("PROVIDER_QUOTA_EXHAUSTED");
    expect(classifyError(new Error("429 Too Many Requests"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
    expect(classifyError(new Error("rate limit exceeded"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
    expect(classifyError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe(
      "PROVIDER_QUOTA_EXHAUSTED"
    );
  });

  test("leaves unrelated crashes unclassified", () => {
    expect(classifyError(new Error("kaboom"))).toBeUndefined();
    expect(classifyError("not an error")).toBeUndefined();
  });

  test("SESSION_TIMEOUT and NO_MODEL_CONFIGURED still classify", () => {
    expect(classifyError(new Error("SESSION_TIMEOUT"))).toBe("SESSION_TIMEOUT");
    expect(classifyError(new Error("No model configured"))).toBe(
      "NO_MODEL_CONFIGURED"
    );
  });

  test("model-resolver's 'No model resolved' now classifies (was unclassified)", () => {
    // model-resolver.ts throws this when no default/per-behavior/org model is
    // set. It previously fell through to `undefined` → raw crash delta + dodged
    // the PROVIDER_* Sentry alert. Now it renders the actionable catalog line.
    expect(
      classifyError(
        new Error(
          "No model resolved for this run. Set the agent's default model, a per-behavior model, or an org default inference provider."
        )
      )
    ).toBe("NO_MODEL_CONFIGURED");
  });
});
