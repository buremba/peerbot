/**
 * Verdict parsing for both judges.
 *
 * A judge reply is `{ verdict, reason }` JSON. Parsing it is a property of the
 * PROMPT contract, not of the transport that carried the reply, so it lives
 * here rather than in any one provider client, so a change of transport cannot
 * change how a verdict is read.
 */

import { getErrorMessage } from "@lobu/core";
import type { JudgeVerdict } from "./types.js";

/**
 * Parse a `{ verdict, reason }` JSON response. Accepts:
 *   - strict JSON,
 *   - JSON inside ```json``` code fences,
 *   - JSON embedded in prose (falls back to extracting the first `{…}`
 *     balanced object — small models sometimes wrap the verdict in a sentence
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
    `Judge response was not valid verdict JSON: ${getErrorMessage(lastErr)}`
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
