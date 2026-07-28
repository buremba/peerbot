/**
 * `suggest-followups` — output-stage **enrichment** guardrail.
 *
 * Not a safety trip: it never blocks a reply. When an agent enables it via
 * `guardrails: ["suggest-followups"]` and a turn ends without the agent calling
 * `suggest_actions`, the gateway derives 2–3 follow-up chips from the reply
 * and publishes them through the same persist + card path the tool uses.
 *
 * Ordering (critical): enrichment runs ONLY after blocking output guardrails
 * (`secret-scan`, `pii-scan`, …) have passed on the terminal text. The
 * output-scan path partitions enrichment names out of the blocking race so a
 * secret-bearing reply never reaches this LLM call. See
 * {@link isEnrichmentGuardrail}.
 *
 * Opt-in transport: process env `SUGGESTION_GENERATOR_API_KEY` +
 * `SUGGESTION_GENERATOR_BASE_URL` + `SUGGESTION_GENERATOR_MODEL` (OpenAI-
 * compatible chat/completions). Incomplete config or any failure fails open
 * (no chips) — same state as before this guardrail existed. Lives in the
 * gateway (not `@lobu/core`) so the generation pipeline stays a server
 * concern next to the other built-ins.
 */

import {
  createLogger,
  getErrorMessage,
  sanitizeSuggestionPrompts,
  type Guardrail,
  type SuggestedPrompt,
} from "@lobu/core";

const logger = createLogger("suggest-followups");

/** Guardrail name operators put in `settings.guardrails`. */
export const SUGGEST_FOLLOWUPS_NAME = "suggest-followups";

/**
 * Output-stage instances that enrich rather than block. Partitioned out of the
 * parallel blocking race so they never run (or see the reply) before safety
 * scans pass, and so enabling only enrichment does not withhold streaming.
 * Track identity rather than name so a malformed/out-of-band inline guardrail
 * that collides with a built-in name keeps its own blocking semantics.
 */
const ENRICHMENT_GUARDRAILS = new WeakSet<Guardrail>();

export function isEnrichmentGuardrail(guardrail: Guardrail): boolean {
  return ENRICHMENT_GUARDRAILS.has(guardrail);
}

/** The tail of a reply carries the "what now" better than its opening. */
const MAX_INPUT_CHARS = 6_000;
/**
 * Generation is dispatched fire-and-forget (see ChatResponseBridge), so nothing
 * waits on this — the timeout only bounds a leaked request, it does not protect
 * turn latency. Sized like the other provider calls in the gateway
 * (MCP_PROXY_FETCH_TIMEOUT_MS, TRANSCRIPTION_FETCH_TIMEOUT_MS) rather than like
 * the blocking judges, which fail fast because a turn is stalled behind them.
 *
 * Do not trim this without measuring the configured model: reasoning-tier
 * models are slow here (glm-4.7 measured 19-26s, glm-4.6 16.7s, glm-4.5-air
 * 21.9s on 2026-07-28), and a timeout below the model's real latency yields
 * zero chips on every turn while still paying for the call.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_REPLY_CHARS = 40;

const SYSTEM_PROMPT = [
  "You write follow-up action chips for a chat UI.",
  "Given an assistant's reply, return 2-3 things the USER would plausibly want next.",
  "",
  'Each item is {"title","message"}:',
  '- "title": a short tappable label, at most 20 characters.',
  '- "message": the full message sent verbatim AS THE USER if tapped.',
  "",
  "Write `message` in the user's voice, as a request to the assistant:",
  '  good: "Show me the diff"   bad: "I can show you the diff"',
  "Make them specific to THIS reply — reference what was actually discussed.",
  "Do not offer an action the assistant already completed in the reply.",
  'Return STRICT JSON {"prompts":[{"title":"...","message":"..."}]} only.',
].join("\n");

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null } | null;
  } | null> | null;
}

export interface SuggestFollowupsEnv {
  SUGGESTION_GENERATOR_API_KEY?: string;
  SUGGESTION_GENERATOR_BASE_URL?: string;
  SUGGESTION_GENERATOR_MODEL?: string;
}

/**
 * Built-in registration stub. The actual generation runs out-of-band after
 * blocking output scans pass ({@link generateSuggestFollowups}); including
 * this instance in the parallel race would either waste a model call on a
 * reply that is about to be blocked, or re-introduce the pre-scan egress
 * bug. `run` is therefore a pure no-op pass.
 */
export function createSuggestFollowupsGuardrail(): Guardrail<"output"> {
  const guardrail: Guardrail<"output"> = {
    name: SUGGEST_FOLLOWUPS_NAME,
    stage: "output",
    async run() {
      return { tripped: false };
    },
  };
  ENRICHMENT_GUARDRAILS.add(guardrail);
  return guardrail;
}

/** Per-guardrail overrides, from the agent's `suggest-followups` entry. */
export interface SuggestFollowupsOptions {
  /** `model` on the guardrail entry — wins over SUGGESTION_GENERATOR_MODEL. */
  model?: string;
  /** Abort budget; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Derive follow-up chips from the (already scanned) agent reply. Returns []
 * when unconfigured, on short replies, or on any failure.
 *
 * The credentials stay env-scoped (an operator secret, not agent-editable), but
 * `model` is per-agent: it is the one knob worth varying — a slow reasoning
 * model yields nothing under any sane timeout, and chip quality differs sharply
 * by tier. It mirrors how a judge guardrail's `model` field already works.
 */
export async function generateSuggestFollowups(
  replyText: string,
  env: SuggestFollowupsEnv = process.env as SuggestFollowupsEnv,
  options: SuggestFollowupsOptions = {}
): Promise<SuggestedPrompt[]> {
  const apiKey = env.SUGGESTION_GENERATOR_API_KEY?.trim();
  const configuredBaseUrl = env.SUGGESTION_GENERATOR_BASE_URL?.trim();
  const model =
    options.model?.trim() || env.SUGGESTION_GENERATOR_MODEL?.trim();
  // Keep provider selection explicit — no silent hardcoding of a base URL or
  // model outside the operator-configured env.
  if (!apiKey || !configuredBaseUrl || !model) return [];

  const trimmed = replyText.trim();
  // A one-word reply ("Done.") gives the model no material and yields filler.
  if (trimmed.length < MIN_REPLY_CHARS) return [];

  const baseUrl = configuredBaseUrl.replace(/\/+$/, "");
  const input =
    trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "suggest-followups completion failed; turn ends without chips"
      );
      return [];
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    return parsePrompts(content);
  } catch (error) {
    logger.warn(
      { error: getErrorMessage(error) },
      "suggest-followups generation failed; turn ends without chips"
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the model's `{"prompts":[...]}` JSON (tolerating markdown code fences).
 * Output is untrusted — the same sanitizer the tool path uses shapes/caps it.
 */
function parsePrompts(raw: string): SuggestedPrompt[] {
  const cleaned = stripCodeFence(raw.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return sanitizeSuggestionPrompts((parsed as { prompts?: unknown }).prompts);
}

function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.match(fence);
  return match?.[1] ?? text;
}
