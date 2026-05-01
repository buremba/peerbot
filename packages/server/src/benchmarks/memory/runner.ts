import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandBenchmarkAdapter } from './adapters/command';
import { OwlettoInprocessBenchmarkAdapter } from './adapters/owletto-inprocess';
import { OwlettoMcpBenchmarkAdapter } from './adapters/owletto-mcp';
import { buildContextText, createAnswerer, estimateApproxTokens } from './answerer';
import { loadBenchmarkConfig } from './config';
import { renderMarkdownReport } from './publish';
import { aggregateSystemResults, scoreQuestion, summarizeTrial } from './scoring';
import { loadBenchmarkSuite } from './suite';
import type {
  BenchmarkAdapter,
  BenchmarkReport,
  BenchmarkRunConfig,
  BenchSystemConfig,
  QuestionResult,
  TrialResult,
} from './types';

function createAdapter(system: BenchSystemConfig): BenchmarkAdapter {
  if (system.type === 'owletto-mcp') return new OwlettoMcpBenchmarkAdapter(system);
  if (system.type === 'owletto-inprocess') return new OwlettoInprocessBenchmarkAdapter(system);
  if (system.type === 'command') return new CommandBenchmarkAdapter(system);
  throw new Error(
    `Unsupported benchmark system '${(system as { type?: string }).type ?? 'unknown'}'`
  );
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function logProgress(message: string): void {
  console.log(`[bench ${new Date().toISOString()}] ${message}`);
}

export function printReport(report: BenchmarkReport): void {
  const rows = report.systems.map((system) => ({
    system: system.systemLabel,
    answer: formatPercent(system.summary.answerAccuracy),
    retrieval: formatPercent(system.summary.retrievalRecall),
    citation: formatPercent(system.summary.citationRecall),
    latency: formatMs(system.summary.averageLatencyMs),
    context: `${system.summary.averageContextTokensApprox.toFixed(0)} tok`,
    overall: formatPercent(system.summary.overallScore),
  }));

  console.table(rows);
}

export async function runBenchmark(config: BenchmarkRunConfig): Promise<BenchmarkReport> {
  const suite = loadBenchmarkSuite(config.suitePath);
  const answerer = createAnswerer(config.answerer);
  const topK = config.topK ?? 8;
  const adapters = config.systems.map(createAdapter);
  const trialCount = config.trials ?? 1;
  const totalScenarios = suite.scenarios.length;
  const totalQuestions = suite.scenarios.reduce(
    (sum, scenario) => sum + scenario.questions.length,
    0
  );
  const parallelSystems = config.parallelSystems !== false;

  logProgress(
    `suite=${suite.id} systems=${adapters.length} trials=${trialCount} scenarios=${totalScenarios} questions=${totalQuestions} topK=${topK} answerer=${answerer ? answerer.describe() : 'none'} parallel=${parallelSystems}`
  );

  const emptyTrialSummary = {
    questionCount: 0,
    answerAccuracy: null,
    retrievalRecall: 0,
    citationRecall: null,
    citationPrecision: null,
    averageLatencyMs: 0,
    p95LatencyMs: 0,
    averageContextTokensApprox: 0,
    averageAnswererPromptTokens: 0,
    averageAnswererCompletionTokens: 0,
    totalAnswererPromptTokens: 0,
    totalAnswererCompletionTokens: 0,
  };

  async function runSystem(
    adapter: BenchmarkAdapter,
    systemIndex: number
  ): Promise<{ systemId: string; systemLabel: string; trials: TrialResult[] }> {
    const trials: TrialResult[] = [];
    const systemTopK = config.systems.find((system) => system.id === adapter.id)?.topK ?? topK;

    try {
      logProgress(
        `system ${systemIndex + 1}/${adapters.length} start id=${adapter.id} label="${adapter.label}" topK=${systemTopK}`
      );

      for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) {
        const trialRunId = `${suite.id}-${adapter.id}-t${trialIndex + 1}-${Date.now()}`;
        const trialStartedAt = Date.now();
        const questions: QuestionResult[] = [];

        logProgress(
          `system=${adapter.id} trial ${trialIndex + 1}/${trialCount} start scenarios=${totalScenarios}`
        );

        for (const [scenarioIndex, scenario] of suite.scenarios.entries()) {
          const scenarioRunId = `${trialRunId}-s${scenarioIndex + 1}`;
          const scenarioStartedAt = Date.now();

          logProgress(
            `system=${adapter.id} trial=${trialIndex + 1}/${trialCount} scenario=${scenarioIndex + 1}/${totalScenarios} start id=${scenario.id} category=${scenario.category} questions=${scenario.questions.length}`
          );

          await adapter.reset({ runId: scenarioRunId, trialIndex, suite });
          await adapter.setup({ runId: scenarioRunId, trialIndex, suite });

          try {
            await adapter.ingestScenario({ runId: scenarioRunId, trialIndex, suite, scenario });

            for (const [questionIndex, question] of scenario.questions.entries()) {
              const retrieval = await adapter.retrieve({
                runId: scenarioRunId,
                trialIndex,
                scenarioId: scenario.id,
                questionId: question.id,
                prompt: question.prompt,
                topK: systemTopK,
              });

              const contextTokensApprox = estimateApproxTokens(
                buildContextText(retrieval.items, retrieval.contextPrefix)
              );

              const answerResult = answerer
                ? await answerer.answer(question.prompt, retrieval.items, retrieval.contextPrefix)
                : { answer: 'unknown', citedIds: [], usage: undefined };

              const score = scoreQuestion({
                expectedAnswers: question.expectedAnswers,
                expectedSourceStepIds: question.expectedSourceStepIds,
                answer: answerer ? answerResult.answer : null,
                citedIds: answerer ? answerResult.citedIds : [],
                retrievedIds: retrieval.items.map((item) => item.id),
              });

              const usage = answerResult.usage;
              questions.push({
                scenarioId: scenario.id,
                category: scenario.category,
                questionId: question.id,
                prompt: question.prompt,
                expectedAnswers: question.expectedAnswers,
                expectedSourceStepIds: question.expectedSourceStepIds,
                retrievedIds: retrieval.items.map((item) => item.id),
                answer: answerer ? answerResult.answer : null,
                citedIds: answerer ? answerResult.citedIds : [],
                latencyMs: retrieval.latencyMs,
                contextTokensApprox,
                answererPromptTokens: usage?.promptTokens ?? 0,
                answererCompletionTokens: usage?.completionTokens ?? 0,
                score,
              });

              logProgress(
                `system=${adapter.id} trial=${trialIndex + 1}/${trialCount} scenario=${scenarioIndex + 1}/${totalScenarios} question=${questionIndex + 1}/${scenario.questions.length} done retrieval=${formatMs(retrieval.latencyMs)} answer=${answerer ? (score.answerCorrect === 1 ? 'correct' : score.answerCorrect === 0 ? 'miss' : 'n/a') : 'n/a'} recall=${formatPercent(score.retrievalRecall)}`
              );
            }
          } finally {
            await adapter.reset({ runId: scenarioRunId, trialIndex, suite });
            logProgress(
              `system=${adapter.id} trial=${trialIndex + 1}/${trialCount} scenario=${scenarioIndex + 1}/${totalScenarios} done duration=${formatDuration(Date.now() - scenarioStartedAt)}`
            );
          }
        }

        const trial: TrialResult = {
          systemId: adapter.id,
          systemLabel: adapter.label,
          runId: trialRunId,
          trialIndex,
          questions,
          summary: summarizeTrial({
            systemId: adapter.id,
            systemLabel: adapter.label,
            runId: trialRunId,
            trialIndex,
            questions,
            summary: emptyTrialSummary,
          }),
        };

        trials.push(trial);
        logProgress(
          `system=${adapter.id} trial ${trialIndex + 1}/${trialCount} done duration=${formatDuration(Date.now() - trialStartedAt)} answer=${formatPercent(trial.summary.answerAccuracy)} retrieval=${formatPercent(trial.summary.retrievalRecall)} latency=${formatMs(trial.summary.averageLatencyMs)} tokens=${trial.summary.totalAnswererPromptTokens + trial.summary.totalAnswererCompletionTokens}`
        );
      }

      const latestSummary = trials[trials.length - 1]?.summary;
      logProgress(
        `system ${systemIndex + 1}/${adapters.length} done id=${adapter.id}${latestSummary ? ` last-trial-answer=${formatPercent(latestSummary.answerAccuracy)} last-trial-retrieval=${formatPercent(latestSummary.retrievalRecall)} last-trial-latency=${formatMs(latestSummary.averageLatencyMs)}` : ''}`
      );
      return { systemId: adapter.id, systemLabel: adapter.label, trials };
    } finally {
      await adapter.dispose?.();
    }
  }

  let systemResults: Array<{ systemId: string; systemLabel: string; trials: TrialResult[] }>;
  if (parallelSystems) {
    const settled = await Promise.allSettled(
      adapters.map((adapter, idx) => runSystem(adapter, idx))
    );
    systemResults = [];
    for (const [idx, outcome] of settled.entries()) {
      const adapter = adapters[idx]!;
      if (outcome.status === 'fulfilled') {
        systemResults.push(outcome.value);
      } else {
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        logProgress(`system=${adapter.id} FAILED: ${reason}`);
      }
    }
    if (systemResults.length === 0) {
      throw new Error('All systems failed — no results to aggregate');
    }
  } else {
    systemResults = [];
    for (const [idx, adapter] of adapters.entries()) {
      try {
        systemResults.push(await runSystem(adapter, idx));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logProgress(`system=${adapter.id} FAILED: ${reason}`);
      }
    }
    if (systemResults.length === 0) {
      throw new Error('All systems failed — no results to aggregate');
    }
  }

  return {
    suiteId: suite.id,
    suiteVersion: suite.version,
    generatedAt: new Date().toISOString(),
    config: {
      trials: trialCount,
      topK,
      answerer: answerer ? answerer.describe() : null,
      contextTokenEstimate: 'chars_div_4',
      scenarioIsolation: 'per-scenario',
      latencyMeasurement: 'retrieval-only',
    },
    systems: aggregateSystemResults(systemResults),
  };
}

export async function runBenchmarkFromConfigPath(configPath: string): Promise<{
  report: BenchmarkReport;
  reportPath: string;
  markdownPath: string;
}> {
  const config = loadBenchmarkConfig(configPath);
  const report = await runBenchmark(config);
  mkdirSync(config.outputDir ?? '.owletto/benchmarks/memory', { recursive: true });
  const basePath = join(
    config.outputDir ?? '.owletto/benchmarks/memory',
    `${report.suiteId}-${Date.now()}`
  );
  const reportPath = `${basePath}.json`;
  const markdownPath = `${basePath}.md`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  writeFileSync(markdownPath, renderMarkdownReport(report));
  return { report, reportPath, markdownPath };
}
