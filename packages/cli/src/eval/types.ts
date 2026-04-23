import { z } from "zod";

const assertionSchema = z.object({
  type: z.enum(["contains", "regex", "llm-rubric"]),
  value: z.string(),
  weight: z.number().default(1),
  options: z
    .object({
      case_insensitive: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

const turnSchema = z.object({
  content: z.string(),
  assert: z.array(assertionSchema).optional(),
});

export const CURRENT_EVAL_VERSION = 1;

export const evalDefinitionSchema = z.object({
  version: z.number().default(CURRENT_EVAL_VERSION),
  name: z.string(),
  description: z.string().optional(),
  trials: z.number().default(3),
  timeout: z.number().default(120), // seconds per turn
  tags: z.array(z.string()).optional(),
  rubric: z.string().optional(), // relative path to rubric.md
  scoring: z
    .object({
      pass_threshold: z.number().default(0.8),
    })
    .default(() => ({ pass_threshold: 0.8 })),
  turns: z.array(turnSchema).min(1),
});

export type EvalDefinition = z.infer<typeof evalDefinitionSchema>;
export type Assertion = z.infer<typeof assertionSchema>;

// ─── Results ────────────────────────────────────────────────────────────

export interface AssertionResult {
  type: string;
  passed: boolean;
  score: number;
  reason?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TurnResult {
  user: string;
  agent: string;
  latencyMs: number;
  assertions: AssertionResult[];
  tokens?: TokenUsage;
  traceId?: string;
}

export interface RubricCriterion {
  name: string;
  passed: boolean;
  explanation: string;
}

export interface RubricResult {
  score: number;
  criteria: RubricCriterion[];
}

export interface TrialResult {
  trial: number;
  passed: boolean;
  score: number;
  turns: TurnResult[];
  rubric?: RubricResult;
  durationMs: number;
}

export interface EvalResult {
  name: string;
  passRate: number;
  avgScore: number;
  p50LatencyMs: number;
  totalTokens: TokenUsage;
  trials: TrialResult[];
}

export interface EvalReport {
  agent: string;
  model: string;
  provider: string;
  timestamp: string;
  summary: { total: number; passed: number; failed: number };
  evals: EvalResult[];
}
