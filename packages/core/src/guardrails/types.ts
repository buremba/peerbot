/**
 * Guardrail primitive — composable input/output/pre-tool checks that can halt
 * a run before it produces user-visible output or side effects. Modeled on
 * OpenAI Agents SDK's input_guardrails / output_guardrails pattern.
 *
 * A guardrail returns `{ tripped: true, reason, metadata }` to halt; the
 * runner cancels the remaining guardrails at the same stage on first trip.
 *
 * Guardrails are stage-scoped:
 *   - `input`    — user message before dispatch to worker
 *   - `output`   — worker-produced text/attachments before user rendering
 *   - `pre-tool` — tool call authorization (agent → gateway MCP proxy)
 *
 * Register guardrails in a {@link GuardrailRegistry} and enable them per-agent
 * via `[agents.<id>] guardrails = ["name-a", "name-b"]` in `lobu.toml`.
 */

export type GuardrailStage = "input" | "output" | "pre-tool";

/**
 * Context shape passed to each stage. Each stage has a distinct payload so
 * guardrails can be typed against what they'll actually inspect. Additional
 * fields can be added over time — guardrails should read only what they need.
 */
export interface InputGuardrailContext {
  agentId: string;
  userId: string;
  message: string;
  platform: string;
  conversationId?: string;
}

export interface OutputGuardrailContext {
  agentId: string;
  userId: string;
  /** Full response text or streamed delta being inspected. */
  text: string;
  platform: string;
  conversationId?: string;
}

export interface PreToolGuardrailContext {
  agentId: string;
  userId: string;
  toolName: string;
  /** Raw JSON-RPC params the worker is about to invoke the tool with. */
  arguments: unknown;
  conversationId?: string;
}

export type GuardrailContext = {
  input: InputGuardrailContext;
  output: OutputGuardrailContext;
  "pre-tool": PreToolGuardrailContext;
};

/**
 * Result of a single guardrail invocation. `tripped: true` halts the run at
 * this stage; `reason` surfaces in logs/user messages, `metadata` is
 * opaque structured data for downstream handlers (e.g. which pattern matched).
 */
export interface GuardrailResult {
  tripped: boolean;
  reason?: string;
  metadata?: unknown;
}

/**
 * A single guardrail. The `name` must be unique within a stage — the registry
 * uses it as the lookup key when agents enable guardrails by name in config.
 */
export interface Guardrail<S extends GuardrailStage = GuardrailStage> {
  name: string;
  stage: S;
  run(ctx: GuardrailContext[S]): Promise<GuardrailResult>;
}

/**
 * Outcome of running all enabled guardrails at a stage. `tripped` is the
 * first guardrail that halted (others were cancelled); `ran` lists every
 * guardrail that actually produced a result (useful for audit logs).
 */
export interface GuardrailRunOutcome {
  tripped: {
    guardrail: string;
    reason?: string;
    metadata?: unknown;
  } | null;
  ran: string[];
}
