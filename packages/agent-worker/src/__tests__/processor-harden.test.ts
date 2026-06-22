/**
 * Hardening tests for OpenClawProgressProcessor.
 *
 * Covers gaps in the existing processor.test.ts:
 * - Malformed / missing fields on events (robustness, no throws)
 * - getDelta when output was non-monotonically modified (rare guard)
 * - reset() clears hasStreamedText so message_end re-extracts text
 * - message_end with empty content blocks emits nothing
 * - message_end with whitespace-only text emits nothing
 * - Multiple consecutive getDelta() calls return only new content
 * - tool_execution_start with non-object args does not throw
 * - getOutputSnapshot reflects full output including already-sent content
 */

import { describe, expect, test } from "bun:test";
import { OpenClawProgressProcessor } from "../openclaw/processor";

function makeTextDelta(delta: string, role = "assistant"): any {
  return {
    type: "message_update",
    message: { role },
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

function makeMessageEnd(opts: {
  role?: string;
  content?: any[];
  stopReason?: string;
  errorMessage?: string;
}): any {
  return {
    type: "message_end",
    message: {
      role: opts.role ?? "assistant",
      content: opts.content ?? [],
      stopReason: opts.stopReason,
      errorMessage: opts.errorMessage,
    },
  };
}

// ---------------------------------------------------------------------------
// Malformed event fields
// ---------------------------------------------------------------------------

describe("OpenClawProgressProcessor — malformed events don't throw", () => {
  test("message_update with null assistantMessageEvent returns false without throwing", () => {
    const p = new OpenClawProgressProcessor();
    const event = {
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: null,
    };
    let result: boolean | undefined;
    expect(() => {
      result = p.processEvent(event as any);
    }).not.toThrow();
    expect(result).toBe(false);
    expect(p.getDelta()).toBeNull();
  });

  test("tool_execution_start with null args does not throw", () => {
    const p = new OpenClawProgressProcessor();
    expect(() =>
      p.processEvent({
        type: "tool_execution_start",
        toolName: "Read",
        args: null,
      } as any)
    ).not.toThrow();
  });

  test("tool_execution_start with string args does not throw", () => {
    const p = new OpenClawProgressProcessor();
    expect(() =>
      p.processEvent({
        type: "tool_execution_start",
        toolName: "Read",
        args: "unexpected-string",
      } as any)
    ).not.toThrow();
  });

  test("compaction_end with neither aborted nor result returns true", () => {
    const p = new OpenClawProgressProcessor();
    // No aborted, no result — the current implementation still returns true
    const result = p.processEvent({ type: "compaction_end" } as any);
    expect(result).toBe(true);
  });

  test("auto_retry_end with success=true and no finalError returns false", () => {
    const p = new OpenClawProgressProcessor();
    const result = p.processEvent({
      type: "auto_retry_end",
      success: true,
      finalError: undefined,
    } as any);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// message_end content extraction edge cases
// ---------------------------------------------------------------------------

describe("message_end content extraction", () => {
  test("empty content array produces no output", () => {
    const p = new OpenClawProgressProcessor();
    const result = p.processEvent(makeMessageEnd({ content: [] }));
    expect(result).toBe(false);
    expect(p.getDelta()).toBeNull();
  });

  test("whitespace-only text block produces no output", () => {
    const p = new OpenClawProgressProcessor();
    const result = p.processEvent(
      makeMessageEnd({ content: [{ type: "text", text: "   \n\t  " }] })
    );
    expect(result).toBe(false);
    expect(p.getDelta()).toBeNull();
  });

  test("non-text blocks are skipped", () => {
    const p = new OpenClawProgressProcessor();
    const result = p.processEvent(
      makeMessageEnd({ content: [{ type: "tool_use", id: "x" }] })
    );
    expect(result).toBe(false);
  });

  test("multiple text blocks concatenated", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(
      makeMessageEnd({
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " World" },
        ],
      })
    );
    expect(p.getDelta()).toContain("Hello World");
  });

  test("message_end with error does not append content text", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(
      makeMessageEnd({
        stopReason: "error",
        errorMessage: "Boom",
        content: [{ type: "text", text: "Should not appear" }],
      })
    );
    expect(p.getDelta()).toBeNull();
    expect(p.consumeFatalErrorMessage()).toBe("Boom");
  });

  test("message_end after streaming skips re-extraction", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeTextDelta("streamed text"));
    p.getDelta();

    // Now simulate message_end with content
    const result = p.processEvent(
      makeMessageEnd({ content: [{ type: "text", text: "duplicate" }] })
    );
    expect(result).toBe(false);
    expect(p.getDelta()).toBeNull();
  });

  test("after reset(), message_end re-extracts text even if streaming happened before", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeTextDelta("before reset"));
    p.getDelta();

    p.reset();

    // Now message_end should be able to extract (hasStreamedText reset)
    const result = p.processEvent(
      makeMessageEnd({ content: [{ type: "text", text: "after reset" }] })
    );
    expect(result).toBe(true);
    expect(p.getDelta()).toContain("after reset");
  });
});

// ---------------------------------------------------------------------------
// getDelta monotonicity and snapshot
// ---------------------------------------------------------------------------

describe("getDelta and getOutputSnapshot", () => {
  test("multiple incremental deltas return cumulative suffix each time", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeTextDelta("A"));
    expect(p.getDelta()).toBe("A");

    p.processEvent(makeTextDelta("B"));
    expect(p.getDelta()).toBe("B");

    p.processEvent(makeTextDelta("C"));
    expect(p.getDelta()).toBe("C");
  });

  test("getOutputSnapshot returns full accumulated output", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeTextDelta("part1"));
    p.getDelta(); // consume

    p.processEvent(makeTextDelta(" part2"));
    p.getDelta(); // consume

    // Snapshot reflects everything even after getDelta consumed it
    expect(p.getOutputSnapshot()).toBe("part1 part2");
  });

  test("getDelta returns full content when it diverges from lastSentContent", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent(makeTextDelta("original"));
    p.getDelta(); // lastSentContent = "original"

    // Simulate a reset + new content that doesn't start with old prefix
    p.reset();
    p.processEvent(makeTextDelta("completely different"));
    // Full content is returned since it doesn't start with lastSentContent (empty after reset)
    expect(p.getDelta()).toBe("completely different");
  });
});

// ---------------------------------------------------------------------------
// Thinking events (non-verbose mode)
// ---------------------------------------------------------------------------

describe("thinking events non-verbose", () => {
  test("thinking deltas do not append output in non-verbose mode", () => {
    const p = new OpenClawProgressProcessor();
    p.processEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "step one " },
    } as any);
    p.processEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "step two" },
    } as any);
    expect(p.getDelta()).toBeNull();
  });

  test("reset() does not carry over thinking into next session", () => {
    const p = new OpenClawProgressProcessor();
    p.setVerboseLogging(true);
    p.processEvent({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "thoughts" },
    } as any);
    p.reset();
    expect(p.getDelta()).toBeNull();
  });
});
