import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSession, deleteSession, sendAndCollect } from "./client.js";
import { gradeInline, gradeWithRubric } from "./grader.js";
import type {
  Assertion,
  AssertionResult,
  EvalDefinition,
  EvalResult,
  RubricResult,
  TokenUsage,
  TrialResult,
  TurnResult,
} from "./types.js";

export interface RunOptions {
  gatewayUrl: string;
  authToken: string;
  agentId?: string;
  provider?: string;
  model?: string;
  trialsOverride?: number;
}

export async function runEval(
  definition: EvalDefinition,
  evalFilePath: string,
  options: RunOptions
): Promise<EvalResult> {
  const trials = options.trialsOverride ?? definition.trials;
  const results: TrialResult[] = [];

  // Load rubric file if specified
  let rubricContent: string | undefined;
  if (definition.rubric) {
    const rubricPath = join(dirname(evalFilePath), definition.rubric);
    rubricContent = await readFile(rubricPath, "utf-8");
  }

  for (let i = 0; i < trials; i++) {
    const result = await runTrial(i + 1, definition, rubricContent, options);
    results.push(result);
  }

  const passedTrials = results.filter((t) => t.passed).length;
  const latencies = results.flatMap((t) =>
    t.turns.map((turn) => turn.latencyMs)
  );
  latencies.sort((a, b) => a - b);

  // Aggregate token usage across all trials
  const totalTokens = aggregateTokens(results);

  return {
    name: definition.name,
    passRate: trials > 0 ? passedTrials / trials : 0,
    avgScore:
      trials > 0 ? results.reduce((sum, t) => sum + t.score, 0) / trials : 0,
    p50LatencyMs:
      latencies.length > 0
        ? (latencies[Math.floor(latencies.length / 2)] ?? 0)
        : 0,
    totalTokens,
    trials: results,
  };
}

async function runTrial(
  trialNum: number,
  definition: EvalDefinition,
  rubricContent: string | undefined,
  options: RunOptions
): Promise<TrialResult> {
  const start = Date.now();
  const timeoutMs = definition.timeout * 1000;

  // Use a unique thread per trial so each trial gets a fresh conversationId,
  // SSE backlog, and worker workspace. Without this, every trial reuses
  // `${agentId}_${userId}` and inherits chat history + stale SSE events
  // from previous trials.
  const session = await createSession(options.gatewayUrl, options.authToken, {
    agentId: options.agentId,
    thread: `eval-${randomUUID()}`,
    forceNew: true,
    dryRun: true,
  });

  const turnResults: TurnResult[] = [];

  try {
    for (const turn of definition.turns) {
      const response = await sendAndCollect(session, turn.content, timeoutMs);

      if (response.error) {
        turnResults.push({
          user: turn.content,
          agent: response.text || `[Error: ${response.error}]`,
          latencyMs: response.latencyMs,
          assertions: [
            { type: "error", passed: false, score: 0, reason: response.error },
          ],
          tokens: response.tokens,
          traceId: response.traceId,
        });
        continue;
      }

      // Run assertions for this turn
      const assertions = turn.assert
        ? await runAssertions(
            turn.assert,
            response.text,
            options.gatewayUrl,
            options.authToken,
            timeoutMs
          )
        : [];

      turnResults.push({
        user: turn.content,
        agent: response.text,
        latencyMs: response.latencyMs,
        assertions,
        tokens: response.tokens,
        traceId: response.traceId,
      });
    }

    // Run rubric grading on full transcript if rubric is specified
    let rubric: RubricResult | undefined;
    if (rubricContent) {
      rubric = await gradeWithRubric(
        options.gatewayUrl,
        options.authToken,
        rubricContent,
        turnResults,
        timeoutMs
      );
    }

    // Calculate trial score
    const score = calculateTrialScore(turnResults, rubric);
    const passed = score >= definition.scoring.pass_threshold;

    return {
      trial: trialNum,
      passed,
      score,
      turns: turnResults,
      rubric,
      durationMs: Date.now() - start,
    };
  } finally {
    await deleteSession(session);
  }
}

async function runAssertions(
  assertions: Assertion[],
  agentResponse: string,
  gatewayUrl: string,
  authToken: string,
  timeoutMs: number
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "contains": {
        const target = assertion.value;
        const response = assertion.options?.case_insensitive
          ? agentResponse.toLowerCase()
          : agentResponse;
        const search = assertion.options?.case_insensitive
          ? target.toLowerCase()
          : target;
        const passed = response.includes(search);
        results.push({ type: "contains", passed, score: passed ? 1 : 0 });
        break;
      }

      case "regex": {
        const regex = new RegExp(assertion.value, "i");
        const passed = regex.test(agentResponse);
        results.push({ type: "regex", passed, score: passed ? 1 : 0 });
        break;
      }

      case "llm-rubric": {
        const result = await gradeInline(
          gatewayUrl,
          authToken,
          assertion.value,
          agentResponse,
          timeoutMs
        );
        results.push({
          type: "llm-rubric",
          passed: result.passed,
          score: result.score,
          reason: result.reason,
        });
        break;
      }
    }
  }

  return results;
}

function calculateTrialScore(
  turns: TurnResult[],
  rubric?: RubricResult
): number {
  // Collect all weighted scores
  const scores: Array<{ score: number; weight: number }> = [];

  for (const turn of turns) {
    if (turn.assertions.length === 0) continue;

    // If assertions have no explicit weights, weight them equally
    const totalWeight = turn.assertions.reduce(
      (sum, _a, _i) => sum + 1, // Default weight 1 per assertion
      0
    );

    for (const assertion of turn.assertions) {
      scores.push({ score: assertion.score, weight: 1 / totalWeight });
    }
  }

  // Add rubric score if present (weighted equally to all assertion scores combined)
  if (rubric) {
    const assertionWeight = scores.length > 0 ? 0.5 : 1;
    const rubricWeight = scores.length > 0 ? 0.5 : 1;

    const assertionAvg =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s.score * s.weight, 0)
        : 0;

    return assertionAvg * assertionWeight + rubric.score * rubricWeight;
  }

  if (scores.length === 0) return 1; // No assertions = pass

  return scores.reduce((sum, s) => sum + s.score * s.weight, 0);
}

function aggregateTokens(trials: TrialResult[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const trial of trials) {
    for (const turn of trial.turns) {
      if (turn.tokens) {
        inputTokens += turn.tokens.inputTokens ?? 0;
        outputTokens += turn.tokens.outputTokens ?? 0;
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}
