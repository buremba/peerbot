import { describe, expect, test } from "bun:test";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  TurnController,
  wrapToolsWithTurnGuard,
} from "../openclaw/turn-controller";

/**
 * These tests exercise the REAL pi agent loop (the same `Agent`/`agent-loop`
 * the worker drives) with a scripted, deterministic `streamFn` — no live LLM.
 * They prove the two guarantees the prod incident needed:
 *
 *  1. After AskUser posts, the turn ends with NO further model iteration, even
 *     if the scripted model would have kept calling the tool forever.
 *  2. A runaway tool loop is cut off deterministically by the loop cap.
 *
 * The worker wraps every tool with `wrapToolsWithTurnGuard` (so the runaway
 * guard runs synchronously inside execute) and attaches `agent.abort()` to the
 * controller — we reproduce exactly that wiring here.
 */

const MODEL: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096,
};

/** Build a stream that yields a single assistant message then resolves it. */
function scriptedStream(message: AssistantMessage) {
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: message },
    // Jump straight to done — the loop reads `result()` on the done event.
    {
      type: "done",
      reason: message.stopReason,
      message,
    } as AssistantMessageEvent,
  ];
  let i = 0;
  const iterator: AsyncIterator<AssistantMessageEvent> = {
    next: async () => {
      if (i < events.length) {
        return { value: events[i++], done: false };
      }
      return { value: undefined as never, done: true };
    },
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
    result: async () => message,
  };
}

/**
 * A stream that, like the real pi-ai `streamSimple`, short-circuits when handed
 * an already-aborted signal: it emits no content and resolves to an
 * `aborted`-stop-reason message. The agent loop turns that into `agent_end`
 * with no further iteration — this is the mechanism `agent.abort()` relies on.
 */
function abortedStream(): {
  [Symbol.asyncIterator]: () => AsyncIterator<AssistantMessageEvent>;
  result: () => Promise<AssistantMessage>;
} {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp: Date.now(),
  };
  let done = false;
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (!done) {
          done = true;
          return {
            value: {
              type: "done",
              reason: "aborted",
              message,
            } as AssistantMessageEvent,
            done: false,
          };
        }
        return { value: undefined as never, done: true };
      },
    }),
    result: async () => message,
  };
}

function assistantWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
  id: string
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: toolName, arguments: args }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/** An assistant message that emits several tool calls in one turn (one batch). */
function assistantWithToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown>; id: string }>
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "toolCall",
      id: c.id,
      name: c.name,
      arguments: c.args,
    })),
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function plainAssistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * A tool the scripted model "calls". Records each execution. The AskUser
 * variant invokes the controller's terminate (mirroring the worker's
 * `onAskUserPosted`).
 */
function makeRecordingTool(
  name: string,
  onExecute: (count: number) => void
): AgentTool {
  let count = 0;
  return {
    name,
    label: name,
    description: `test tool ${name}`,
    parameters: Type.Object({
      question: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async () => {
      count += 1;
      onExecute(count);
      return {
        content: [{ type: "text", text: `${name} executed (#${count})` }],
        details: {},
      };
    },
  };
}

/**
 * Wire a TurnController to an Agent exactly like worker.ts does:
 *  - `agent.abort()` is the controller's abort
 *  - the runaway guard is applied via `wrapToolsWithTurnGuard` on the tools
 *    (synchronous, inside execute) — NOT via the lagged tool_execution_start
 *    event. This mirrors production.
 * Returns the names of tools whose body actually ran (guard-blocked calls
 * short-circuit before the body and are not counted).
 */
function wireGuardedTools(
  agent: Agent,
  controller: TurnController,
  tools: AgentTool[]
): { bodyRuns: string[] } {
  controller.attachAbort(() => agent.abort());
  const bodyRuns: string[] = [];
  const instrumented = tools.map((t) => ({
    ...t,
    execute: async (...args: Parameters<AgentTool["execute"]>) => {
      bodyRuns.push(t.name);
      return t.execute(...args);
    },
  }));
  agent.setTools(
    wrapToolsWithTurnGuard(instrumented as AgentTool[], controller)
  );
  return { bodyRuns };
}

describe("turn force-terminate via TurnController + real Agent loop", () => {
  test("AskUser posts once, then the turn ends with NO further model iteration", async () => {
    const controller = new TurnController();

    let askUserExecCount = 0;
    const askUser = makeRecordingTool("ask_user", () => {
      askUserExecCount += 1;
      // This is exactly what the worker's onAskUserPosted does after the
      // gateway POST succeeds.
      controller.terminate("ask-user", "posted");
    });

    // The scripted model is malicious: it ALWAYS asks again. Without the
    // force-terminate it would loop forever.
    let streamCalls = 0;
    const agent = new Agent({
      streamFn: ((
        _model: unknown,
        _ctx: unknown,
        options?: { signal?: AbortSignal }
      ) => {
        // Faithful to streamSimple: an aborted signal yields an aborted message.
        if (options?.signal?.aborted) {
          return abortedStream() as never;
        }
        streamCalls += 1;
        return scriptedStream(
          assistantWithToolCall(
            "ask_user",
            { question: "Which option?", options: ["a", "b"] },
            `call-${streamCalls}`
          )
        ) as never;
      }) as never,
    });
    agent.setModel(MODEL as never);
    wireGuardedTools(agent, controller, [askUser]);

    await agent.prompt("help me");

    // The model would have looped forever; the synchronous terminate cut it
    // off. AskUser's body ran exactly once, and the loop made no further LLM
    // iteration after the abort.
    expect(askUserExecCount).toBe(1);
    expect(controller.isTerminated).toBe(true);
    expect(controller.reason).toBe("ask-user");
    // One stream call produced the AskUser tool-call; the next stream
    // short-circuits on the aborted signal. The loop never ran unbounded.
    expect(streamCalls).toBeLessThanOrEqual(2);

    // The AskUser tool result is in the conversation, so a later resume sees it.
    const toolResults = agent.state.messages.filter(
      (m) => (m as { role: string }).role === "toolResult"
    );
    expect(toolResults.length).toBe(1);
  });

  test("sibling tool calls in the SAME assistant message after AskUser are short-circuited", async () => {
    // Regression: agent-loop has no signal check between tools in one batch, so
    // a single assistant message of [AskUser, otherTool] would otherwise run
    // `otherTool` after AskUser terminated the turn. The guard short-circuits
    // every tool once the turn is terminated.
    const controller = new TurnController();

    let askUserBody = 0;
    let siblingBody = 0;
    const askUser = makeRecordingTool("ask_user", () => {
      askUserBody += 1;
      controller.terminate("ask-user", "posted");
    });
    const sibling = makeRecordingTool("noop", () => {
      siblingBody += 1;
    });

    let streamCalls = 0;
    const agent = new Agent({
      streamFn: ((
        _model: unknown,
        _ctx: unknown,
        options?: { signal?: AbortSignal }
      ) => {
        if (options?.signal?.aborted) {
          return abortedStream() as never;
        }
        streamCalls += 1;
        // One message, TWO tool calls: AskUser first, then a sibling.
        return scriptedStream(
          assistantWithToolCalls([
            {
              name: "ask_user",
              args: { question: "Which?", options: ["a", "b"] },
              id: "call-ask",
            },
            { name: "noop", args: {}, id: "call-sib" },
          ])
        ) as never;
      }) as never,
    });
    agent.setModel(MODEL as never);
    wireGuardedTools(agent, controller, [askUser, sibling]);

    await agent.prompt("help me");

    // AskUser ran once; the sibling in the same batch did NOT run its body.
    expect(askUserBody).toBe(1);
    expect(siblingBody).toBe(0);
    expect(controller.isTerminated).toBe(true);
    expect(streamCalls).toBeLessThanOrEqual(2);
  });

  test("a runaway identical-tool loop is cut off TIGHTLY by the loop cap", async () => {
    const controller = new TurnController({ maxIdenticalToolCalls: 3 });

    const spam = makeRecordingTool("spam", () => {
      // no per-execution side-effect needed; the guard counts the calls
    });

    // Malicious model: forever returns the SAME tool call with the SAME args.
    let streamCalls = 0;
    const agent = new Agent({
      streamFn: ((
        _model: unknown,
        _ctx: unknown,
        options?: { signal?: AbortSignal }
      ) => {
        if (options?.signal?.aborted) {
          return abortedStream() as never;
        }
        streamCalls += 1;
        return scriptedStream(
          assistantWithToolCall(
            "spam",
            { fixed: "args" },
            `call-${streamCalls}`
          )
        ) as never;
      }) as never,
    });
    agent.setModel(MODEL as never);
    const { bodyRuns } = wireGuardedTools(agent, controller, [spam]);

    await agent.prompt("go");

    expect(controller.isTerminated).toBe(true);
    expect(controller.reason).toBe("identical-tool-loop");
    // Because the guard runs synchronously inside execute, the tool BODY runs
    // exactly cap times — the (cap+1)th call is short-circuited by the guard
    // (it never reaches the body) and aborts the turn. Tight bound.
    expect(bodyRuns).toEqual(["spam", "spam", "spam"]);
    // The model was driven at most cap+1 times before the abort landed.
    expect(streamCalls).toBeLessThanOrEqual(4);
  });

  test("a well-behaved turn (no AskUser, no loop) completes normally", async () => {
    const controller = new TurnController();

    let streamCalls = 0;
    const agent = new Agent({
      streamFn: ((
        _model: unknown,
        _ctx: unknown,
        options?: { signal?: AbortSignal }
      ) => {
        if (options?.signal?.aborted) {
          return abortedStream() as never;
        }
        streamCalls += 1;
        // First call: a single benign tool. Second call: finish.
        if (streamCalls === 1) {
          return scriptedStream(
            assistantWithToolCall("noop", {}, "call-1")
          ) as never;
        }
        return scriptedStream(plainAssistant("done")) as never;
      }) as never,
    });
    const noop = makeRecordingTool("noop", () => {
      // benign tool: no side-effect
    });
    agent.setModel(MODEL as never);
    const { bodyRuns } = wireGuardedTools(agent, controller, [noop]);

    await agent.prompt("do one thing");

    expect(controller.isTerminated).toBe(false);
    expect(bodyRuns).toEqual(["noop"]);
  });
});
