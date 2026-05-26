import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  TurnController,
} from "../openclaw/turn-controller";

describe("TurnController", () => {
  test("terminate() aborts the turn and is idempotent within a turn", () => {
    let aborts = 0;
    const reasons: string[] = [];
    const controller = new TurnController({
      onTerminate: ({ reason }) => reasons.push(reason),
    });
    controller.attachAbort(() => {
      aborts += 1;
    });
    controller.startTurn();

    expect(controller.isTerminated).toBe(false);
    controller.terminate("ask-user", "posted");
    expect(controller.isTerminated).toBe(true);
    expect(controller.reason).toBe("ask-user");

    // Second call within the same turn is a no-op: no double-abort.
    controller.terminate("ask-user", "posted again");
    expect(aborts).toBe(1);
    expect(reasons).toEqual(["ask-user"]);
  });

  test("startTurn() resets termination so a new turn can run", () => {
    let aborts = 0;
    const controller = new TurnController();
    controller.attachAbort(() => {
      aborts += 1;
    });

    controller.startTurn();
    controller.terminate("ask-user", "first turn");
    expect(controller.isTerminated).toBe(true);
    expect(aborts).toBe(1);

    controller.startTurn();
    expect(controller.isTerminated).toBe(false);
    expect(controller.reason).toBeNull();
    controller.terminate("ask-user", "second turn");
    expect(aborts).toBe(2);
  });

  test("identical tool+args calls beyond the cap force-terminate the turn", () => {
    let aborts = 0;
    const controller = new TurnController({
      maxIdenticalToolCalls: 3,
    });
    controller.attachAbort(() => {
      aborts += 1;
    });
    controller.startTurn();

    const args = { question: "Which one?", options: ["a", "b"] };
    expect(controller.recordToolCall("AskUserQuestion", args)).toBe(false);
    expect(controller.recordToolCall("AskUserQuestion", args)).toBe(false);
    expect(controller.recordToolCall("AskUserQuestion", args)).toBe(false);
    // 4th identical call trips the guard.
    expect(controller.recordToolCall("AskUserQuestion", args)).toBe(true);
    expect(controller.isTerminated).toBe(true);
    expect(controller.reason).toBe("identical-tool-loop");
    expect(aborts).toBe(1);
  });

  test("argument order does not change the identical-call key", () => {
    const controller = new TurnController({ maxIdenticalToolCalls: 2 });
    controller.attachAbort(() => {
      // abort side-effect not asserted in this case
    });
    controller.startTurn();

    controller.recordToolCall("T", { a: 1, b: 2 });
    controller.recordToolCall("T", { b: 2, a: 1 });
    // Third (still semantically identical) trips the cap of 2.
    expect(controller.recordToolCall("T", { a: 1, b: 2 })).toBe(true);
    expect(controller.reason).toBe("identical-tool-loop");
  });

  test("distinct args do not trip the identical-call guard", () => {
    const controller = new TurnController({ maxIdenticalToolCalls: 2 });
    controller.attachAbort(() => {
      // abort side-effect not asserted in this case
    });
    controller.startTurn();

    expect(controller.recordToolCall("search", { q: "one" })).toBe(false);
    expect(controller.recordToolCall("search", { q: "two" })).toBe(false);
    expect(controller.recordToolCall("search", { q: "three" })).toBe(false);
    expect(controller.isTerminated).toBe(false);
  });

  test("total tool-call cap force-terminates even with all-distinct args", () => {
    const controller = new TurnController({
      maxToolCallsPerTurn: 5,
      // Make the identical guard irrelevant so the total cap is the trigger.
      maxIdenticalToolCalls: 1000,
    });
    controller.attachAbort(() => {
      // abort side-effect not asserted in this case
    });
    controller.startTurn();

    for (let i = 0; i < 5; i++) {
      expect(controller.recordToolCall("search", { q: `q${i}` })).toBe(false);
    }
    // 6th call exceeds the cap of 5.
    expect(controller.recordToolCall("search", { q: "q5" })).toBe(true);
    expect(controller.reason).toBe("tool-call-cap");
  });

  test("recordToolCall after termination is inert", () => {
    let aborts = 0;
    const controller = new TurnController({ maxIdenticalToolCalls: 1 });
    controller.attachAbort(() => {
      aborts += 1;
    });
    controller.startTurn();

    controller.recordToolCall("T", {});
    expect(controller.recordToolCall("T", {})).toBe(true);
    // Already terminated: further calls do nothing and don't re-abort.
    expect(controller.recordToolCall("T", {})).toBe(false);
    expect(aborts).toBe(1);
  });

  test("terminate before abort is attached still marks termination", () => {
    const controller = new TurnController();
    controller.startTurn();
    // No attachAbort() — should not throw, just records the intent.
    expect(() => controller.terminate("ask-user", "early")).not.toThrow();
    expect(controller.isTerminated).toBe(true);
  });

  test("exposes the documented defaults", () => {
    expect(DEFAULT_MAX_TOOL_CALLS_PER_TURN).toBe(50);
    expect(DEFAULT_MAX_IDENTICAL_TOOL_CALLS).toBe(3);
  });
});
