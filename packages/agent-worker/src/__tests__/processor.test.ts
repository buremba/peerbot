import { describe, expect, test } from "bun:test";
import { OpenClawProgressProcessor } from "../openclaw/processor";

function makeEvent(type: string, extra: Record<string, any> = {}): any {
  return { type, ...extra };
}

function makeMessageUpdate(
  assistantEventType: string,
  delta = "",
  role = "assistant"
): any {
  return makeEvent("message_update", {
    message: { role },
    assistantMessageEvent: { type: assistantEventType, delta },
  });
}

describe("OpenClawProgressProcessor", () => {
  test("processEvent returns false for non-assistant message_update", () => {
    const p = new OpenClawProgressProcessor();
    const event = makeMessageUpdate("text_delta", "hi", "user");
    expect(p.processEvent(event)).toBe(false);
  });

  test("text_delta appends to output", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeMessageUpdate("text_delta", "Hello"));
    p.processEvent(makeMessageUpdate("text_delta", " world"));
    expect(p.getDelta()).toBe("Hello world");
  });

  test("thinking_delta does not append by default", () => {
    const p = new OpenClawProgressProcessor();
    const result = p.processEvent(
      makeMessageUpdate("thinking_delta", "thinking...")
    );
    expect(result).toBe(false);
    expect(p.getDelta()).toBeNull();
  });

  test("thinking_delta appends when verbose", () => {
    const p = new OpenClawProgressProcessor();
    p.setVerboseLogging(true);
    const result = p.processEvent(
      makeMessageUpdate("thinking_delta", "thinking...")
    );
    expect(result).toBe(true);
    expect(p.getDelta()).toContain("thinking...");
  });

  test("thinking_start/end output in verbose mode only", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.processEvent(makeMessageUpdate("thinking_start"))).toBe(false);
    expect(p.processEvent(makeMessageUpdate("thinking_end"))).toBe(false);

    p.setVerboseLogging(true);
    expect(p.processEvent(makeMessageUpdate("thinking_start"))).toBe(true);
    expect(p.processEvent(makeMessageUpdate("thinking_end"))).toBe(true);
  });

  test("getCurrentThinking tracks thinking content", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.getCurrentThinking()).toBeNull();
    p.processEvent(makeMessageUpdate("thinking_delta", "step 1"));
    expect(p.getCurrentThinking()).toBe("step 1");
  });

  test("message_end with error stores fatal error", () => {
    const p = new OpenClawProgressProcessor();
    const event = makeEvent("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Something broke",
      },
    });
    expect(p.processEvent(event)).toBe(false);
    expect(p.consumeFatalErrorMessage()).toBe("Something broke");
    // Consumed, so second call returns null
    expect(p.consumeFatalErrorMessage()).toBeNull();
  });

  test("message_end extracts text when no streaming happened", () => {
    const p = new OpenClawProgressProcessor();
    const event = makeEvent("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    });
    expect(p.processEvent(event)).toBe(true);
    expect(p.getDelta()).toContain("Final answer");
  });

  test("message_end skips extraction if text already streamed", () => {
    const p = new OpenClawProgressProcessor();
    // Stream some text first
    p.processEvent(makeMessageUpdate("text_delta", "streamed"));
    p.getDelta(); // consume
    // Now message_end should skip
    const event = makeEvent("message_end", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final" }],
      },
    });
    expect(p.processEvent(event)).toBe(false);
  });

  test("auto_compaction_start appends message", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.processEvent(makeEvent("auto_compaction_start"))).toBe(true);
    expect(p.getDelta()).toContain("Compacting context");
  });

  test("auto_compaction_end with aborted", () => {
    const p = new OpenClawProgressProcessor();
    expect(
      p.processEvent(makeEvent("auto_compaction_end", { aborted: true }))
    ).toBe(true);
    expect(p.getDelta()).toContain("Compaction aborted");
  });

  test("auto_compaction_end with result", () => {
    const p = new OpenClawProgressProcessor();
    expect(
      p.processEvent(makeEvent("auto_compaction_end", { result: {} }))
    ).toBe(true);
    expect(p.getDelta()).toContain("Context compacted");
  });

  test("auto_retry_start appends retry message", () => {
    const p = new OpenClawProgressProcessor();
    expect(
      p.processEvent(
        makeEvent("auto_retry_start", { attempt: 2, maxAttempts: 3 })
      )
    ).toBe(true);
    expect(p.getDelta()).toContain("Retrying (attempt 2/3)");
  });

  test("auto_retry_end with failure appends error", () => {
    const p = new OpenClawProgressProcessor();
    expect(
      p.processEvent(
        makeEvent("auto_retry_end", {
          success: false,
          finalError: "timeout",
        })
      )
    ).toBe(true);
    expect(p.getDelta()).toContain("Retry failed: timeout");
  });

  test("auto_retry_end with success returns false", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.processEvent(makeEvent("auto_retry_end", { success: true }))).toBe(
      false
    );
  });

  test("unknown event type returns false", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.processEvent(makeEvent("unknown_event"))).toBe(false);
  });
});

describe("getDelta", () => {
  test("returns null when no content", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.getDelta()).toBeNull();
  });

  test("returns null when content unchanged", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeMessageUpdate("text_delta", "hello"));
    p.getDelta(); // consume
    expect(p.getDelta()).toBeNull();
  });

  test("returns only the new suffix on incremental append", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeMessageUpdate("text_delta", "Hello"));
    p.getDelta(); // consume "Hello"
    p.processEvent(makeMessageUpdate("text_delta", " world"));
    expect(p.getDelta()).toBe(" world");
  });

  test("returns full content on first call", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeMessageUpdate("text_delta", "first"));
    expect(p.getDelta()).toBe("first");
  });
});

describe("finalResult lifecycle", () => {
  test("set and get final result", () => {
    const p = new OpenClawProgressProcessor();
    expect(p.getFinalResult()).toBeNull();

    p.setFinalResult({ text: "done", isFinal: true });
    const result = p.getFinalResult();
    expect(result).toEqual({ text: "done", isFinal: true });

    // Consumed, so next call returns null
    expect(p.getFinalResult()).toBeNull();
  });
});

describe("reset", () => {
  test("clears all state", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeMessageUpdate("text_delta", "content"));
    p.processEvent(makeMessageUpdate("thinking_delta", "thought"));
    p.setFinalResult({ text: "done", isFinal: true });

    p.reset();

    expect(p.getDelta()).toBeNull();
    expect(p.getCurrentThinking()).toBeNull();
    expect(p.getFinalResult()).toBeNull();
    expect(p.consumeFatalErrorMessage()).toBeNull();
  });
});
