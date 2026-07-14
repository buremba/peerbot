import { createLogger } from "@lobu/core";

const logger = createLogger("turn-controller");

/**
 * Default ceiling on tool calls within a single agent turn. A turn that
 * legitimately needs more than this many tool calls is vanishingly rare; a
 * misbehaving model spamming one tool hits it long before it does damage.
 */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 50;

/**
 * Default ceiling on how many times the *same* tool may be called with the
 * *same* arguments inside one turn before the turn is force-terminated. This
 * is the tight bound that catches the AskUser-style loop where a weak model
 * re-posts an identical interactive question over and over.
 */
export const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 3;

/** Why a turn was force-terminated. */
type TurnTerminationReason =
  | "ask-user"
  | "identical-tool-loop"
  | "tool-call-cap";

interface TurnControllerOptions {
  /** Hard cap on total tool calls in a turn. */
  maxToolCallsPerTurn?: number;
  /** Cap on identical (same name + same args) tool calls in a turn. */
  maxIdenticalToolCalls?: number;
  /**
   * Called whenever the turn is terminated (by AskUser or a runaway guard).
   * Receives a human-readable reason and a machine code. Used by the worker to
   * emit a log/SSE notice. Never throws back into the controller.
   */
  onTerminate?: (info: {
    reason: TurnTerminationReason;
    message: string;
  }) => void;
}

/**
 * Owns the decision to force-end an agent turn so the behavior never depends on
 * the model voluntarily stopping (a weak model ignores "end your turn now"
 * instructions). Two independent triggers, both ending in `agent.abort()`:
 *
 *  1. ask_user — the moment the question is posted, the turn is
 *     terminal. The session resumes naturally later when the user's click
 *     arrives as a fresh inbound message (a new prompt → a new turn).
 *  2. Runaway guard — if any tool is called with identical args more than
 *     `maxIdenticalToolCalls` times, or total tool calls exceed
 *     `maxToolCallsPerTurn`, the turn is aborted deterministically. This is the
 *     defense-in-depth that bounds *any* tool, not just AskUser.
 *
 * The abort is delivered via the shared AbortController behind
 * `agent.abort()`: the in-flight/next LLM stream sees the aborted signal and
 * the agent loop emits `agent_end` with no further model iteration. Tool
 * results recorded before the abort are already persisted to the session, so
 * resume is unaffected.
 */
export class TurnController {
  private readonly maxToolCallsPerTurn: number;
  private readonly maxIdenticalToolCalls: number;
  private readonly onTerminate?: TurnControllerOptions["onTerminate"];

  /** Bound once the agent session exists (it is created after this object). */
  private abortTurn: (() => void) | null = null;

  /** Per-turn state, reset by `startTurn()`. */
  private totalToolCalls = 0;
  private readonly callCounts = new Map<string, number>();
  private terminated = false;
  private terminationReason: TurnTerminationReason | null = null;

  constructor(options: TurnControllerOptions = {}) {
    this.maxToolCallsPerTurn =
      options.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    this.maxIdenticalToolCalls =
      options.maxIdenticalToolCalls ?? DEFAULT_MAX_IDENTICAL_TOOL_CALLS;
    this.onTerminate = options.onTerminate;
  }

  /**
   * Wire the abort mechanism (the agent session is built after the controller,
   * so the worker attaches it once the session exists).
   */
  attachAbort(abortTurn: () => void): void {
    this.abortTurn = abortTurn;
  }

  /** Reset per-turn counters. Call at the start of every prompt turn. */
  startTurn(): void {
    this.totalToolCalls = 0;
    this.callCounts.clear();
    this.terminated = false;
    this.terminationReason = null;
  }

  /** Whether the current turn has already been force-terminated. */
  get isTerminated(): boolean {
    return this.terminated;
  }

  get reason(): TurnTerminationReason | null {
    return this.terminationReason;
  }

  /**
   * Force-terminate the turn. Idempotent within a turn. Safe to call before the
   * abort is attached (the flag is still set so the worker can surface it).
   */
  terminate(reason: TurnTerminationReason, message: string): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.terminationReason = reason;
    logger.info(`Force-ending agent turn (${reason}): ${message}`);
    try {
      this.onTerminate?.({ reason, message });
    } catch (err) {
      logger.error(
        `onTerminate hook threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (this.abortTurn) {
      this.abortTurn();
    } else {
      logger.warn(
        "TurnController.terminate called before abort was attached — turn will not be aborted"
      );
    }
  }

  /**
   * Record a tool call (called from the agent's `tool_execution_start` event)
   * and enforce the runaway guards. Returns true if this call tripped a guard
   * and the turn was terminated.
   */
  recordToolCall(toolName: string, args: unknown): boolean {
    if (this.terminated) {
      return false;
    }

    this.totalToolCalls += 1;
    if (this.totalToolCalls > this.maxToolCallsPerTurn) {
      this.terminate(
        "tool-call-cap",
        `Tool-call cap reached (${this.maxToolCallsPerTurn} calls in one turn). Aborting to prevent a runaway loop.`
      );
      return true;
    }

    const key = JSON.stringify([toolName, stableArgsKey(args)]);
    const next = (this.callCounts.get(key) ?? 0) + 1;
    this.callCounts.set(key, next);
    if (next > this.maxIdenticalToolCalls) {
      this.terminate(
        "identical-tool-loop",
        `Tool "${toolName}" was called ${next} times with identical arguments in one turn. Aborting to prevent a runaway loop.`
      );
      return true;
    }

    return false;
  }
}

/** Minimal structural shape this wrapper needs from a tool. */
interface GuardableTool {
  name: string;
  execute: (...args: never[]) => Promise<unknown>;
}

/** A tool result that ran no work — used when the guard short-circuits a call. */
function blockedResult(text: string): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
} {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * Wrap every tool so the runaway guard runs SYNCHRONOUSLY inside `execute`,
 * before the tool body — not via the agent's async event stream (whose
 * `tool_execution_start` delivery lags several turns behind real execution,
 * letting a fast loop run well past the cap before the abort lands). When the
 * guard trips, the turn is terminated (`agent.abort()`) and the offending call
 * returns a short refusal instead of running, so the bound is tight.
 *
 * Generic so it wraps both built-in `AgentTool`s and custom `ToolDefinition`s.
 * Returns tools unchanged when there is nothing to guard.
 */
export function wrapToolsWithTurnGuard<T extends GuardableTool>(
  tools: T[],
  controller: TurnController
): T[] {
  return tools.map((tool) => {
    const toolName = tool.name;
    const originalExecute = tool.execute.bind(tool) as (
      ...args: unknown[]
    ) => Promise<unknown>;

    const guardedExecute = async (...args: unknown[]): Promise<unknown> => {
      // Once the turn is terminated (by AskUser or a tripped guard), short-
      // circuit EVERY subsequent tool body — including siblings in the same
      // assistant message. `agent.abort()` only stops the NEXT LLM stream; the
      // agent loop has no signal check between tools in one batch, so without
      // this an `[AskUser, otherTool]` (or two AskUsers) message would still run
      // the later calls after the turn was supposed to end.
      if (controller.isTerminated) {
        return blockedResult(
          `⛔ Turn already ended; ${toolName} was not executed.`
        );
      }

      const params = args[1];
      const tripped = controller.recordToolCall(toolName, params);
      if (tripped) {
        return blockedResult(
          `⛔ Turn aborted: ${toolName} was invoked in a runaway loop. ${
            controller.reason === "tool-call-cap"
              ? "Too many tool calls in one turn."
              : "The same call was repeated too many times."
          }`
        );
      }
      return originalExecute(...args);
    };

    return {
      ...tool,
      execute: guardedExecute,
    } as unknown as T;
  });
}

/**
 * Deterministic string key for a tool's arguments. Object key order is
 * normalized so `{a:1,b:2}` and `{b:2,a:1}` collapse to the same key. Falls
 * back to a non-throwing stringify for values JSON can't represent.
 */
function stableArgsKey(args: unknown): string {
  try {
    return JSON.stringify(args, sortedReplacer(args)) ?? String(args);
  } catch {
    return String(args);
  }
}

function sortedReplacer(_root: unknown) {
  return (_key: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}
