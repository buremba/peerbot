export interface BenchmarkEntityType {
  slug: string;
  name: string;
  description?: string;
  metadataSchema?: Record<string, unknown>;
  eventKinds?: Record<string, { description?: string; metadataSchema?: Record<string, unknown> }>;
}

export interface BenchmarkRelationshipRule {
  sourceEntityTypeSlug: string;
  targetEntityTypeSlug: string;
}

export interface BenchmarkRelationshipType {
  slug: string;
  name: string;
  description?: string;
  isSymmetric?: boolean;
  inverseTypeSlug?: string;
  rules?: BenchmarkRelationshipRule[];
}

export interface BenchmarkEntity {
  ref: string;
  entityType: string;
  name: string;
  metadata?: Record<string, unknown>;
}

interface BenchmarkStepBase {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface BenchmarkMemoryStep extends BenchmarkStepBase {
  kind: 'memory';
  entityRefs: string[];
  semanticType: string;
  supersedes?: string;
}

export interface BenchmarkRelationshipStep extends BenchmarkStepBase {
  kind: 'relationship';
  fromRef: string;
  toRef: string;
  relationshipType: string;
  confidence?: number;
}

export type BenchmarkStep = BenchmarkMemoryStep | BenchmarkRelationshipStep;

export interface BenchmarkQuestion {
  id: string;
  prompt: string;
  expectedAnswers: string[];
  expectedSourceStepIds: string[];
  tags?: string[];
}

export interface BenchmarkScenario {
  id: string;
  category: string;
  description?: string;
  entities: BenchmarkEntity[];
  steps: BenchmarkStep[];
  questions: BenchmarkQuestion[];
}

export interface BenchmarkSuite {
  id: string;
  version: string;
  description?: string;
  entityTypes: BenchmarkEntityType[];
  relationshipTypes?: BenchmarkRelationshipType[];
  scenarios: BenchmarkScenario[];
}

export interface RetrievedMemory {
  id: string;
  text: string;
  score?: number;
  sourceType?: 'memory' | 'relationship' | 'unknown';
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  items: RetrievedMemory[];
  latencyMs: number;
  contextPrefix?: string;
  raw?: unknown;
}

export interface AnswererUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AnswerResult {
  answer: string;
  citedIds: string[];
  usage?: AnswererUsage;
  raw?: unknown;
}

interface TrialRunContext {
  runId: string;
  trialIndex: number;
}

export interface TrialContext extends TrialRunContext {
  suite: BenchmarkSuite;
}

export interface ScenarioContext extends TrialContext {
  scenario: BenchmarkScenario;
}

interface ScenarioRunContext extends TrialRunContext {
  scenarioId: string;
}

export interface RetrieveContext extends ScenarioRunContext {
  questionId: string;
  prompt: string;
  topK: number;
}

export interface BenchmarkAdapter {
  readonly id: string;
  readonly label: string;
  reset(ctx: TrialContext): Promise<void>;
  setup(ctx: TrialContext): Promise<void>;
  ingestScenario(ctx: ScenarioContext): Promise<void>;
  retrieve(ctx: RetrieveContext): Promise<RetrievalResult>;
  dispose?(): Promise<void>;
}

export interface OpenAiCompatibleAnswererConfig {
  type: 'openai-compatible';
  model: string;
  baseUrl?: string;
  apiKeyEnv: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ExtractiveAnswererConfig {
  type: 'extractive';
}

export interface NoneAnswererConfig {
  type: 'none';
}

export type AnswererConfig =
  | OpenAiCompatibleAnswererConfig
  | ExtractiveAnswererConfig
  | NoneAnswererConfig;

interface BenchSystemConfigBase {
  id: string;
  label: string;
  type: string;
  enabled?: boolean;
  topK?: number;
  searchLimit?: number;
  readLimit?: number;
  linkLimit?: number;
}

export interface OwlettoMcpSystemConfig extends BenchSystemConfigBase {
  type: 'owletto-mcp';
  mcpUrl: string;
  tokenEnv?: string;
  searchLimit?: number;
  readLimit?: number;
  linkLimit?: number;
}

export interface CommandSystemConfig extends BenchSystemConfigBase {
  type: 'command';
  argv: string[];
  env?: Record<string, string>;
}

interface OwlettoInprocessSystemConfig extends BenchSystemConfigBase {
  type: 'owletto-inprocess';
  embedWrites?: boolean;
}

export type BenchSystemConfig =
  | OwlettoMcpSystemConfig
  | OwlettoInprocessSystemConfig
  | CommandSystemConfig;

export interface BenchmarkRunConfig {
  suitePath: string;
  outputDir?: string;
  trials?: number;
  topK?: number;
  answerer?: AnswererConfig;
  systems: BenchSystemConfig[];
  parallelSystems?: boolean;
}

export interface QuestionScore {
  answerCorrect: number | null;
  retrievalRecall: number;
  citationRecall: number | null;
  citationPrecision: number | null;
}

export interface QuestionResult {
  scenarioId: string;
  category: string;
  questionId: string;
  prompt: string;
  expectedAnswers: string[];
  expectedSourceStepIds: string[];
  retrievedIds: string[];
  answer: string | null;
  citedIds: string[];
  latencyMs: number;
  contextTokensApprox: number;
  answererPromptTokens: number;
  answererCompletionTokens: number;
  score: QuestionScore;
}

export interface TrialResult {
  systemId: string;
  systemLabel: string;
  runId: string;
  trialIndex: number;
  questions: QuestionResult[];
  summary: TrialSummary;
}

export interface TrialSummary {
  questionCount: number;
  answerAccuracy: number | null;
  retrievalRecall: number;
  citationRecall: number | null;
  citationPrecision: number | null;
  averageLatencyMs: number;
  p95LatencyMs: number;
  averageContextTokensApprox: number;
  averageAnswererPromptTokens: number;
  averageAnswererCompletionTokens: number;
  totalAnswererPromptTokens: number;
  totalAnswererCompletionTokens: number;
}

export interface CategorySummary extends TrialSummary {
  category: string;
}

export interface AggregateSummary extends TrialSummary {
  overallScore: number;
  latencyScore: number;
  confidence95?: {
    answerAccuracy?: number;
    retrievalRecall?: number;
    citationRecall?: number;
    overallScore?: number;
  };
}

export interface AggregateSystemResult {
  systemId: string;
  systemLabel: string;
  trials: TrialResult[];
  summary: AggregateSummary;
  byCategory: CategorySummary[];
}

export interface BenchmarkReport {
  suiteId: string;
  suiteVersion: string;
  generatedAt: string;
  config: {
    trials: number;
    topK: number;
    answerer: string | null;
    contextTokenEstimate: 'chars_div_4';
    scenarioIsolation: 'per-scenario';
    latencyMeasurement: 'retrieval-only';
  };
  systems: AggregateSystemResult[];
}
