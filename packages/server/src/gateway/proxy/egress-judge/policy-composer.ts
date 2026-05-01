import type { JudgeRequest } from "./types.js";

/**
 * Built-in system prompt harness. Provides the fixed role/framing and the
 * strict JSON output schema. The policy text (skill-selected judge +
 * operator extra policy) is injected under "Policy" below.
 *
 * We keep the harness closed so all judges return the same shape and the
 * output parser stays trivial. Skill authors influence behavior via their
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
  const requestLines = [`hostname: ${request.hostname}`];
  if (request.method) requestLines.push(`method: ${request.method}`);
  if (request.path) requestLines.push(`path: ${request.path}`);
  if (!request.method && !request.path) {
    requestLines.push(
      "note: HTTPS CONNECT — method and path are opaque (TLS tunnel)."
    );
  }

  return `Agent: ${request.agentId}

Policy:
${policy.trim()}

Request:
${requestLines.join("\n")}`;
}
