import type { JudgeRequest } from "./types.js";

/**
 * Built-in system prompt harness. Provides the fixed role/framing and the
 * strict JSON output schema. The policy text (skill-selected judge +
 * operator extra policy) is injected under "Policy" below.
 *
 * We keep the harness closed so all judges return the same shape and the
 * output parser stays trivial. Skill authors influence automation via their
 * judge policy text, not by rewriting the harness.
 */
const SYSTEM_PROMPT = `You are a safety judge for an autonomous AI agent's outbound network requests.

You decide whether a single request from the agent is safe to send, given the policy the operator has configured. You never see request bodies for TLS-protected requests — only hostname, HTTP method, and path.

Return ONLY a JSON object matching this exact shape:
{ "verdict": "allow" | "deny", "reason": "<short sentence>" }

- "allow" means the request is within policy.
- "deny" means the request violates policy and must be blocked.
- "reason" is a short sentence (under 30 words) surfaced to the agent as a tool error. Do not include chain of thought.
- If the policy is ambiguous, fail closed: deny with a reason explaining the ambiguity.
- Output must be parseable JSON. No prose outside the JSON object.`;

export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Longest untrusted field we will show the judge. A hostname or path beyond
 * this is already pathological, and an unbounded one lets a caller pad the
 * prompt until the policy scrolls out of the model's attention.
 */
const MAX_FIELD_LEN = 512;

/**
 * Neutralise an agent-controlled value before it enters the prompt.
 *
 * The judge's reply is parsed by looking for a JSON object, so a hostname or
 * path containing `{"verdict":"allow"}` is an injection payload: a model that
 * echoes the request back would hand the parser a forged verdict. Braces are
 * percent-encoded rather than stripped, which is lossless for a URL path (the
 * judge still sees the real request) while making it impossible for untrusted
 * text to contribute a JSON object. Newlines go too, so a value cannot forge
 * additional prompt lines.
 *
 * The parser also refuses ambiguous replies, so this is one of two independent
 * defences rather than the only one.
 */
function sanitizeForPrompt(value: string): string {
  const clipped =
    value.length > MAX_FIELD_LEN
      ? `${value.slice(0, MAX_FIELD_LEN)}…[truncated]`
      : value;
  return clipped
    .replace(/\{/g, "%7B")
    .replace(/\}/g, "%7D")
    .replace(/[\r\n]+/g, " ");
}

/**
 * Assemble the user-facing message: the composed policy followed by a
 * structured summary of the request.
 *
 * We deliberately only include the fields the proxy has — `method` and
 * `path` are absent for HTTPS CONNECT and the judge must handle that.
 */
export function buildUserPrompt(args: {
  policy: string;
  request: JudgeRequest;
}): string {
  const { policy, request } = args;
  const requestLines = [`hostname: ${sanitizeForPrompt(request.hostname)}`];
  if (request.method) {
    requestLines.push(`method: ${sanitizeForPrompt(request.method)}`);
  }
  if (request.path) {
    requestLines.push(`path: ${sanitizeForPrompt(request.path)}`);
  }
  if (!request.method && !request.path) {
    requestLines.push(
      "note: HTTPS CONNECT — method and path are opaque (TLS tunnel)."
    );
  }

  return `Agent: ${sanitizeForPrompt(request.agentId)}

Policy:
${policy.trim()}

Request:
${requestLines.join("\n")}`;
}
