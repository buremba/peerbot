import Anthropic from "@anthropic-ai/sdk";
import type { JudgeClient, JudgeVerdict } from "./types.js";

/**
 * Anthropic-backed judge transport. Calls the Messages API and parses the
 * strict JSON verdict. Any parse failure becomes a thrown error so the
 * caller can record it as a circuit-breaker failure.
 *
 * API key comes from `ANTHROPIC_API_KEY`. The judge is a gateway-level
 * dependency — it does NOT use any agent's own API key, to avoid leaking
 * agent context into audit logs or bills.
 */
export class AnthropicJudgeClient implements JudgeClient {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(options?: { apiKey?: string; timeoutMs?: number }) {
    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Egress judge requires ANTHROPIC_API_KEY — set it in the gateway environment or pass apiKey explicitly"
      );
    }
    this.client = new Anthropic({ apiKey });
    this.timeoutMs = options?.timeoutMs ?? 5000;
  }

  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    const response = await this.client.messages.create(
      {
        model: args.model,
        max_tokens: 256,
        system: args.systemPrompt,
        messages: [{ role: "user", content: args.userPrompt }],
      },
      { timeout: this.timeoutMs }
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
      throw new Error("Judge response contained no text");
    }
    return parseVerdict(textBlock.text);
  }
}

/**
 * Parse a `{ verdict, reason }` JSON response. Accepts:
 *   - strict JSON,
 *   - JSON inside ```json``` code fences,
 *   - JSON embedded in prose (falls back to extracting the first `{…}`
 *     balanced object — Haiku sometimes wraps the verdict in a sentence
 *     despite instructions).
 * Invalid verdict values or missing `verdict` still throw.
 */
export function parseVerdict(raw: string): JudgeVerdict {
  const cleaned = stripCodeFence(raw.trim());
  const candidates = [cleaned, extractFirstJsonObject(cleaned)].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return validateVerdict(JSON.parse(candidate));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Judge response was not valid verdict JSON: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

function validateVerdict(parsed: unknown): JudgeVerdict {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Judge response was not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.verdict !== "allow" && obj.verdict !== "deny") {
    throw new Error(
      `Judge verdict must be "allow" or "deny", got: ${JSON.stringify(obj.verdict)}`
    );
  }
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  return { verdict: obj.verdict, reason: reason || "(no reason given)" };
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ? fenced[1].trim() : text;
}

/**
 * Find the first balanced `{...}` substring. Used as a fallback when the
 * judge wraps JSON in prose. Returns undefined if no balanced object is
 * found. Does not handle braces inside strings — acceptable since our
 * verdicts are small and flat.
 */
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
