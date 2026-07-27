/**
 * Server-side fallback generator for suggested follow-up actions.
 *
 * `suggest_actions` is an optional tool, and models treat it as optional: across
 * measured runs the agent called it on roughly one turn in three, so most
 * replies ended with no chips at all. Prompt tuning did not move this — an
 * instruction reading "ALWAYS call this" produced the same rate as one ending
 * "skip it when there is no clear next step". A feature whose whole value is
 * "there is always an obvious next step to tap" cannot be gated on the model
 * remembering to call a tool.
 *
 * So the terminal boundary asks a configured OpenAI-compatible endpoint to
 * derive chips from the reply the agent just gave, then persists them for the
 * terminal payload. The agent's own call still wins when it makes one: this
 * only runs for a turn that published nothing, so an explicit
 * `suggest_actions` is never overwritten by a generated set.
 *
 * Statelessness: a pure per-turn helper holding no shared state, so it is
 * trivially correct under N>1 replicas — whichever pod processes the terminal
 * row generates independently, and the persist path's advisory lock serializes
 * the write.
 *
 * Opt-in: generation only runs when SUGGESTION_GENERATOR_API_KEY,
 * SUGGESTION_GENERATOR_BASE_URL, and SUGGESTION_GENERATOR_MODEL are configured.
 * With incomplete configuration (or on any failure) it returns [] and the turn
 * ends with no chips — exactly the behavior before this file existed.
 */

import { getErrorMessage, sanitizeSuggestionPrompts } from "@lobu/core";
import type { Env } from "../../index";
import logger from "../../utils/logger";

/** The tail of a reply carries the "what now" better than its opening. */
const MAX_INPUT_CHARS = 6_000;
const TIMEOUT_MS = 15_000;

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

/**
 * Derive 2-3 follow-up chips from the agent's reply text. Returns [] on any
 * failure or when unconfigured — the caller leaves the turn without chips.
 */
export async function generateSuggestions(
  replyText: string,
  env: Env
): Promise<Array<{ title: string; message: string }>> {
  const apiKey = env.SUGGESTION_GENERATOR_API_KEY;
  const configuredBaseUrl = env.SUGGESTION_GENERATOR_BASE_URL;
  const model = env.SUGGESTION_GENERATOR_MODEL;
  // Keep provider selection explicit. The gateway must not silently hardcode a
  // provider URL or model outside the provider/configuration system.
  if (!apiKey || !configuredBaseUrl || !model) return [];

  const trimmed = replyText.trim();
  // Nothing to derive follow-ups FROM. A one-word reply ("Done.") gives the
  // model no material and reliably yields generic filler chips.
  if (trimmed.length < 40) return [];

  const baseUrl = configuredBaseUrl.replace(/\/+$/, "");
  // Keep the END of a long reply: the conclusion is what a follow-up responds
  // to, whereas the opening is usually restated context.
  const input =
    trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(-MAX_INPUT_CHARS) : trimmed;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
        "[suggestion-generator] completion failed; turn ends without chips"
      );
      return [];
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return [];

    return parsePrompts(content);
  } catch (error) {
    // Fail open: any error (timeout/abort, network, parse) leaves the turn
    // without chips rather than breaking terminal delivery.
    logger.warn(
      { error: getErrorMessage(error) },
      "[suggestion-generator] generation failed; turn ends without chips"
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the model's `{"prompts":[...]}` JSON (tolerating markdown code fences).
 * The output is UNTRUSTED — a reply can contain attacker-controlled connector
 * content that steers what this model writes — so the same sanitizer the tool
 * path uses does the shaping/capping here rather than a bespoke loop.
 */
function parsePrompts(raw: string): Array<{ title: string; message: string }> {
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

/** Strip a ```json … ``` fence the model may wrap its JSON in. */
function stripCodeFence(text: string): string {
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.match(fence);
  return match?.[1] ?? text;
}
