/**
 * LLM-as-judge grader using the Lobu gateway.
 *
 * Borrows the Claude outcomes pattern: a separate evaluator context
 * grades agent output against a markdown rubric with per-criterion scoring.
 */

import { randomUUID } from "node:crypto";
import {
  createSession,
  deleteSession,
  sendAndCollect,
  type CollectedResponse,
} from "./client.js";
import type { RubricResult, TurnResult } from "./types.js";

const INLINE_JUDGE_PROMPT = `You are a strict evaluator. You will be given an AI agent's response and a criteria to judge it against.

You MUST respond with ONLY a JSON object, no other text:
{"passed": true, "score": 0.85, "reason": "one sentence explanation"}

Rules:
- "passed": true if the response meets the criteria, false otherwise
- "score": a number between 0.0 and 1.0
- "reason": a brief explanation (one sentence)
- Return ONLY the JSON object, nothing else

## Criteria
{{criteria}}

## Agent Response
{{response}}`;

const RUBRIC_JUDGE_PROMPT = `You are a strict evaluator. Grade the agent's conversation against each criterion in the rubric.

You MUST respond with ONLY a JSON object, no other text:
{"criteria": [{"name": "criterion name", "passed": true, "explanation": "why"}], "score": 0.85}

Rules:
- Score each criterion independently
- "score" is the overall score 0.0-1.0
- Return ONLY the JSON object, nothing else

## Rubric
{{rubric}}

## Conversation
{{transcript}}`;

export interface JudgeSessionOptions {
  agentId?: string;
  provider?: string;
  model?: string;
}

export async function gradeWithRubric(
  gatewayUrl: string,
  authToken: string,
  rubricContent: string,
  turns: TurnResult[],
  timeoutMs: number,
  judgeOptions?: JudgeSessionOptions
): Promise<RubricResult> {
  const transcript = turns
    .map((t) => `User: ${t.user}\nAgent: ${t.agent}`)
    .join("\n\n");

  const prompt = RUBRIC_JUDGE_PROMPT.replace(
    "{{rubric}}",
    rubricContent
  ).replace("{{transcript}}", transcript);

  const session = await createSession(gatewayUrl, authToken, {
    agentId: judgeOptions?.agentId,
    provider: judgeOptions?.provider,
    model: judgeOptions?.model,
    thread: `judge-${randomUUID()}`,
    forceNew: true,
    dryRun: true,
  });

  try {
    const response = await sendAndCollect(session, prompt, timeoutMs);
    return parseGraderResponse(response);
  } finally {
    await deleteSession(session);
  }
}

export async function gradeInline(
  gatewayUrl: string,
  authToken: string,
  criteria: string,
  agentResponse: string,
  timeoutMs: number,
  judgeOptions?: JudgeSessionOptions
): Promise<{ passed: boolean; score: number; reason: string }> {
  const prompt = INLINE_JUDGE_PROMPT.replace("{{criteria}}", criteria).replace(
    "{{response}}",
    agentResponse
  );

  const session = await createSession(gatewayUrl, authToken, {
    agentId: judgeOptions?.agentId,
    provider: judgeOptions?.provider,
    model: judgeOptions?.model,
    thread: `judge-${randomUUID()}`,
    forceNew: true,
    dryRun: true,
  });

  try {
    const response = await sendAndCollect(session, prompt, timeoutMs);
    return parseInlineResponse(response);
  } finally {
    await deleteSession(session);
  }
}

function parseGraderResponse(response: CollectedResponse): RubricResult {
  if (response.error) {
    return {
      score: 0,
      criteria: [{ name: "error", passed: false, explanation: response.error }],
    };
  }

  try {
    const json = extractJSON(response.text);
    const parsed = JSON.parse(json) as {
      criteria?: Array<{ name: string; passed: boolean; explanation: string }>;
      score?: number;
    };
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      criteria: Array.isArray(parsed.criteria)
        ? parsed.criteria.map((c) => ({
            name: String(c.name ?? ""),
            passed: Boolean(c.passed),
            explanation: String(c.explanation ?? ""),
          }))
        : [],
    };
  } catch {
    // Fallback: try to infer from prose response
    return inferRubricFromText(response.text);
  }
}

function parseInlineResponse(response: CollectedResponse): {
  passed: boolean;
  score: number;
  reason: string;
} {
  if (response.error) {
    return { passed: false, score: 0, reason: response.error };
  }

  try {
    const json = extractJSON(response.text);
    const parsed = JSON.parse(json) as {
      passed?: boolean;
      score?: number;
      reason?: string;
    };
    return {
      passed: Boolean(parsed.passed),
      score:
        typeof parsed.score === "number" ? parsed.score : parsed.passed ? 1 : 0,
      reason: String(parsed.reason ?? ""),
    };
  } catch {
    // Fallback: infer pass/fail from prose
    return inferInlineFromText(response.text);
  }
}

/** Extract JSON from text that may contain markdown fences or surrounding prose. */
function extractJSON(text: string): string {
  // Try to find JSON in markdown code block
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced?.[1]) return fenced[1].trim();

  // Try to find raw JSON object
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) return braceMatch[0];

  return text.trim();
}

/** Fallback: infer pass/fail from prose when JSON parsing fails. */
function inferInlineFromText(text: string): {
  passed: boolean;
  score: number;
  reason: string;
} {
  const lower = text.toLowerCase();
  const positiveSignals = [
    "yes",
    "pass",
    "meets",
    "satisfies",
    "correct",
    "appropriate",
    "good",
    "well",
  ];
  const negativeSignals = [
    "no",
    "fail",
    "does not",
    "doesn't",
    "incorrect",
    "missing",
    "lacks",
    "poor",
  ];

  const posCount = positiveSignals.filter((s) => lower.includes(s)).length;
  const negCount = negativeSignals.filter((s) => lower.includes(s)).length;

  const passed = posCount > negCount;
  return {
    passed,
    score: passed ? 0.7 : 0.3,
    reason: `Inferred from prose (pos=${posCount}, neg=${negCount}): ${text.slice(0, 100)}`,
  };
}

/** Fallback: infer rubric result from prose when JSON parsing fails. */
function inferRubricFromText(text: string): RubricResult {
  const lower = text.toLowerCase();
  const positiveSignals = ["pass", "meets", "satisfies", "good", "correct"];
  const negativeSignals = ["fail", "does not", "doesn't", "missing", "poor"];

  const posCount = positiveSignals.filter((s) => lower.includes(s)).length;
  const negCount = negativeSignals.filter((s) => lower.includes(s)).length;
  const passed = posCount > negCount;

  return {
    score: passed ? 0.7 : 0.3,
    criteria: [
      {
        name: "overall",
        passed,
        explanation: `Inferred from prose: ${text.slice(0, 200)}`,
      },
    ],
  };
}
