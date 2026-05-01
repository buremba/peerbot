import type { AggregateSystemResult, BenchmarkReport, QuestionResult } from './types';

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function pctDelta(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}pp`;
}

function ms(value: number): string {
  return `${value.toFixed(0)}ms`;
}

function tok(value: number): string {
  return `${value.toFixed(0)} tok`;
}

function flattenQuestions(system: AggregateSystemResult): QuestionResult[] {
  return system.trials.flatMap((trial) => trial.questions);
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function summarizeIssue(question: QuestionResult): string {
  if (question.score.retrievalRecall < 1) return 'retrieval miss';
  if (question.score.answerCorrect === 0) return 'answer miss';
  if (
    (question.score.citationRecall !== null && question.score.citationRecall < 1) ||
    (question.score.citationPrecision !== null && question.score.citationPrecision < 1)
  ) {
    return 'citation miss';
  }
  return 'partial miss';
}

function renderMisses(system: AggregateSystemResult): string {
  const misses = flattenQuestions(system).filter(
    (question) =>
      question.score.retrievalRecall < 1 ||
      question.score.answerCorrect === 0 ||
      (question.score.citationRecall !== null && question.score.citationRecall < 1) ||
      (question.score.citationPrecision !== null && question.score.citationPrecision < 1)
  );

  if (misses.length === 0) {
    return ['### Misses', '', '_None — all questions were answered and cited correctly._'].join(
      '\n'
    );
  }

  const rows = misses
    .map(
      (question) =>
        `| ${question.category} | ${escapeMarkdownCell(question.prompt)} | ${summarizeIssue(question)} | ${question.expectedSourceStepIds.join(', ')} | ${question.retrievedIds.join(', ') || '—'} | ${escapeMarkdownCell(question.answer ?? 'unknown')} | ${escapeMarkdownCell(question.citedIds.join(', ') || '—')} |`
    )
    .join('\n');

  return [
    '### Misses',
    '',
    '| Category | Prompt | Issue | Expected source(s) | Retrieved | Answer | Cited |',
    '|---|---|---|---|---|---|---|',
    rows,
  ].join('\n');
}

interface RetrievalDiagnostics {
  questionCount: number;
  distinctRetrievedIds: number;
  totalRetrievals: number;
  zeroRecallCount: number;
  topRetrievedIds: Array<{ id: string; count: number; share: number }>;
  concentrationWarning: boolean;
  dominanceWarning: boolean;
}

export function computeRetrievalDiagnostics(
  questions: Pick<QuestionResult, 'expectedSourceStepIds' | 'retrievedIds'>[]
): RetrievalDiagnostics {
  const retrievalFrequency = new Map<string, number>();
  let zeroRecallCount = 0;
  let totalRetrievals = 0;

  for (const question of questions) {
    const expectedSet = new Set(question.expectedSourceStepIds);
    const retrievedSet = new Set(question.retrievedIds);
    for (const id of retrievedSet) {
      retrievalFrequency.set(id, (retrievalFrequency.get(id) ?? 0) + 1);
      totalRetrievals += 1;
    }
    const overlap = [...retrievedSet].some((id) => expectedSet.has(id));
    if (!overlap && expectedSet.size > 0) zeroRecallCount += 1;
  }

  const distinctRetrievedIds = retrievalFrequency.size;
  const denominator = questions.length || 1;
  const topRetrievedIds = [...retrievalFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([id, count]) => ({ id, count, share: count / denominator }));

  const dominatingShare = topRetrievedIds.length > 0 ? topRetrievedIds[0].share : 0;

  return {
    questionCount: questions.length,
    distinctRetrievedIds,
    totalRetrievals,
    zeroRecallCount,
    topRetrievedIds,
    concentrationWarning: distinctRetrievedIds > 0 && distinctRetrievedIds <= questions.length / 3,
    dominanceWarning: dominatingShare >= 0.5,
  };
}

function renderRetrievalDiagnostics(system: AggregateSystemResult): string {
  const questions = flattenQuestions(system);
  if (questions.length === 0) {
    return ['### Retrieval diagnostics', '', '_No questions in this run._'].join('\n');
  }

  const diag = computeRetrievalDiagnostics(questions);

  const topRows =
    diag.topRetrievedIds.length > 0
      ? diag.topRetrievedIds
          .map(({ id, count, share }) => `| \`${id}\` | ${count} | ${(share * 100).toFixed(1)}% |`)
          .join('\n')
      : '| (none) | 0 | 0.0% |';

  const concentrationWarning = diag.concentrationWarning
    ? `\n> ⚠️ Only **${diag.distinctRetrievedIds}** distinct step IDs retrieved across **${diag.questionCount}** questions — retrieval is collapsing on a narrow cluster.`
    : '';

  const dominanceWarning =
    diag.dominanceWarning && diag.topRetrievedIds[0]
      ? `\n> ⚠️ Top ID \`${diag.topRetrievedIds[0].id}\` appears in **${(diag.topRetrievedIds[0].share * 100).toFixed(1)}%** of questions — likely a tiebreaker/scoring bug, not a semantic match.`
      : '';

  return [
    '### Retrieval diagnostics',
    '',
    `- Questions: **${diag.questionCount}**`,
    `- Distinct retrieved step IDs: **${diag.distinctRetrievedIds}**`,
    `- Total retrievals across questions: **${diag.totalRetrievals}**`,
    `- Zero-recall questions (no retrieved ID matched any expected source): **${diag.zeroRecallCount}**`,
    concentrationWarning,
    dominanceWarning,
    '',
    '**Top retrieved step IDs**',
    '',
    '| Step ID | Hit count | Share of questions |',
    '|---|---:|---:|',
    topRows,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function renderHighlights(system: AggregateSystemResult): string {
  const strongest = [...system.byCategory]
    .sort(
      (a, b) => b.retrievalRecall - a.retrievalRecall || a.averageLatencyMs - b.averageLatencyMs
    )
    .slice(0, 2)
    .map(
      (category) =>
        `- **${category.category}** — answer ${pct(category.answerAccuracy)}, retrieval ${pct(category.retrievalRecall)}`
    );

  const weakest = [...system.byCategory]
    .sort(
      (a, b) => a.retrievalRecall - b.retrievalRecall || b.averageLatencyMs - a.averageLatencyMs
    )
    .slice(0, 2)
    .map(
      (category) =>
        `- **${category.category}** — answer ${pct(category.answerAccuracy)}, retrieval ${pct(category.retrievalRecall)}`
    );

  return [
    '### Highlights',
    '',
    '**Strongest categories**',
    ...(strongest.length > 0 ? strongest : ['- n/a']),
    '',
    '**Weakest categories**',
    ...(weakest.length > 0 ? weakest : ['- n/a']),
  ].join('\n');
}

function renderTrialVariability(system: AggregateSystemResult): string {
  const confidence = system.summary.confidence95;
  if (!confidence) return '';

  const lines = [
    confidence.answerAccuracy !== undefined
      ? `- Answer accuracy 95% CI: **± ${pctDelta(confidence.answerAccuracy)}**`
      : null,
    confidence.retrievalRecall !== undefined
      ? `- Retrieval recall 95% CI: **± ${pctDelta(confidence.retrievalRecall)}**`
      : null,
    confidence.citationRecall !== undefined
      ? `- Citation recall 95% CI: **± ${pctDelta(confidence.citationRecall)}**`
      : null,
    confidence.overallScore !== undefined
      ? `- Overall house score 95% CI: **± ${pctDelta(confidence.overallScore)}**`
      : null,
  ].filter((line): line is string => Boolean(line));

  if (lines.length === 0) return '';

  return ['### Trial variability', '', ...lines].join('\n');
}

function renderSystem(system: AggregateSystemResult): string {
  const categories = system.byCategory
    .map(
      (category) =>
        `| ${category.category} | ${pct(category.answerAccuracy)} | ${pct(category.retrievalRecall)} | ${pct(category.citationRecall)} | ${ms(category.averageLatencyMs)} | ${tok(category.averageContextTokensApprox)} |`
    )
    .join('\n');

  const questionCount = flattenQuestions(system).length;
  const variability = renderTrialVariability(system);

  return [
    `## ${system.systemLabel}`,
    '',
    `> **Answer:** ${pct(system.summary.answerAccuracy)} · **Retrieval:** ${pct(system.summary.retrievalRecall)} · **Citation recall:** ${pct(system.summary.citationRecall)} · **Avg latency:** ${ms(system.summary.averageLatencyMs)} · **Overall (secondary house score):** ${pct(system.summary.overallScore)}`,
    '',
    `- Trials: **${system.trials.length}**`,
    `- Questions: **${questionCount}**`,
    `- Citation precision: **${pct(system.summary.citationPrecision)}**`,
    `- P95 latency: **${ms(system.summary.p95LatencyMs)}**`,
    `- Avg context: **${tok(system.summary.averageContextTokensApprox)}** (approx)`,
    '',
    '| Category | Answer | Retrieval | Citation | Avg latency | Avg context |',
    '|---|---:|---:|---:|---:|---:|',
    categories || '| (none) | n/a | n/a | n/a | n/a | n/a |',
    ...(variability ? ['', variability] : []),
    '',
    renderHighlights(system),
    '',
    renderRetrievalDiagnostics(system),
    '',
    renderMisses(system),
  ].join('\n');
}

function pickBestSystem(
  report: BenchmarkReport,
  selector: (system: AggregateSystemResult) => number | null,
  prefersLower = false
): AggregateSystemResult | null {
  const candidates = report.systems.filter((system) => selector(system) !== null);
  if (candidates.length === 0) return null;

  return candidates.reduce((best, current) => {
    const bestValue = selector(best)!;
    const currentValue = selector(current)!;
    if (prefersLower ? currentValue < bestValue : currentValue > bestValue) return current;
    return best;
  });
}

export function renderMarkdownReport(report: BenchmarkReport): string {
  const isRetrievalOnly = report.config.answerer === null;
  const bestAnswer = pickBestSystem(report, (system) => system.summary.answerAccuracy);
  const bestRetrieval = pickBestSystem(report, (system) => system.summary.retrievalRecall);
  const fastest = pickBestSystem(report, (system) => system.summary.averageLatencyMs, true);

  const anyTokens = report.systems.some(
    (system) =>
      (system.summary.totalAnswererPromptTokens ?? 0) +
        (system.summary.totalAnswererCompletionTokens ?? 0) >
      0
  );

  const leaderboard = report.systems
    .map((system) => {
      const base = `| ${system.systemLabel} | ${pct(system.summary.answerAccuracy)} | ${pct(system.summary.retrievalRecall)} | ${pct(system.summary.citationRecall)} | ${ms(system.summary.averageLatencyMs)} | ${tok(system.summary.averageContextTokensApprox)}`;
      if (!anyTokens) {
        return `${base} | ${pct(system.summary.overallScore)} |`;
      }
      const prompt = system.summary.totalAnswererPromptTokens ?? 0;
      const completion = system.summary.totalAnswererCompletionTokens ?? 0;
      return `${base} | ${prompt.toFixed(0)} | ${completion.toFixed(0)} | ${pct(system.summary.overallScore)} |`;
    })
    .join('\n');

  const leaderboardHeader = anyTokens
    ? [
        '| System | Answer | Retrieval | Citation | Avg latency | Avg context | Answerer prompt tok | Answerer completion tok | Overall* |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      ]
    : [
        '| System | Answer | Retrieval | Citation | Avg latency | Avg context | Overall* |',
        '|---|---:|---:|---:|---:|---:|---:|',
      ];

  const details = report.systems.map(renderSystem).join('\n\n');

  return [
    '# Memory Benchmark Report',
    '',
    `> Suite **${report.suiteId}** v${report.suiteVersion} · Generated **${report.generatedAt}**`,
    '',
    '## Run configuration',
    '',
    `- Trials: **${report.config.trials}**`,
    `- Top-K: **${report.config.topK}**`,
    `- Answerer: **${report.config.answerer ?? 'none'}**`,
    `- Evaluation mode: **${isRetrievalOnly ? 'retrieval-only' : 'full QA'}**`,
    `- Scenario isolation: **${report.config.scenarioIsolation}**`,
    `- Latency measurement: **${report.config.latencyMeasurement}**`,
    `- Context token estimate: **${report.config.contextTokenEstimate}**`,
    '',
    '## Methodology notes',
    '',
    '- Each benchmark scenario is evaluated in a fresh isolated system state. Systems do **not** search over previously ingested scenarios within the same run.',
    '- Primary comparison metrics are **answer accuracy**, **retrieval recall**, and **citation quality**. The reported **overall** value is a secondary house score, not an official benchmark metric.',
    '- Latency is **retrieval-only latency**. If one system is local/in-process and another is a hosted API, latency is informative but not fully apples-to-apples.',
    isRetrievalOnly
      ? '- This run is **retrieval-only**; answer and citation metrics are intentionally reported as n/a.'
      : '- Multi-trial runs report 95% confidence intervals when enough trials are available.',
    '',
    '## Executive summary',
    '',
    bestAnswer
      ? `- Highest answer accuracy: **${bestAnswer.systemLabel}** at **${pct(bestAnswer.summary.answerAccuracy)}**`
      : '- Answer accuracy: **n/a** (retrieval-only run)',
    bestRetrieval
      ? `- Highest retrieval recall: **${bestRetrieval.systemLabel}** at **${pct(bestRetrieval.summary.retrievalRecall)}**`
      : '- Retrieval recall: **n/a**',
    fastest
      ? `- Fastest average retrieval latency: **${fastest.systemLabel}** at **${ms(fastest.summary.averageLatencyMs)}**`
      : '- Avg latency: **n/a**',
    '',
    '## Leaderboard (raw metrics first)',
    '',
    ...leaderboardHeader,
    leaderboard ||
      (anyTokens
        ? '| (none) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'
        : '| (none) | n/a | n/a | n/a | n/a | n/a | n/a |'),
    '',
    '> * `Overall` is a secondary house score that blends answer/retrieval/citation/latency. Use the raw metrics above as the primary comparison.',
    '',
    details,
  ].join('\n');
}
