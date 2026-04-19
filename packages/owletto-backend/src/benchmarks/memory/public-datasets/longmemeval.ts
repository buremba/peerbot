import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BenchmarkQuestion, BenchmarkScenario, BenchmarkStep, BenchmarkSuite } from '../types';

const LONGMEMEVAL_URLS = {
  oracle:
    'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json',
  s: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
  m: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json',
} as const;

export type LongMemEvalVariant = keyof typeof LONGMEMEVAL_URLS;

export interface LongMemEvalRecord {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
  answer_session_ids: string[];
}

export interface ConvertLongMemEvalOptions {
  variant: LongMemEvalVariant;
  limit?: number;
  offset?: number;
  suiteId?: string;
  suiteVersion?: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeStepId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function renderSessionContent(
  sessionDate: string,
  turns: LongMemEvalRecord['haystack_sessions'][number]
): string {
  const renderedTurns = turns
    .map((turn, index) => {
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      const answerMarker = turn.has_answer ? ' [evidence]' : '';
      return `Turn ${index + 1} (${role}${answerMarker}): ${normalizeWhitespace(turn.content)}`;
    })
    .join('\n\n');

  return [`Session date: ${sessionDate}`, '', renderedTurns].join('\n');
}

function mapCategory(record: LongMemEvalRecord): string {
  if (record.question_id.endsWith('_abs')) return 'abstention';
  return slugify(record.question_type || 'longmemeval');
}

function toScenario(record: LongMemEvalRecord, index: number): BenchmarkScenario {
  const zipped = record.haystack_session_ids.map((sessionId, sessionIndex) => ({
    sessionId,
    sessionDate: record.haystack_dates[sessionIndex] ?? `unknown-${sessionIndex + 1}`,
    sessionTurns: record.haystack_sessions[sessionIndex] ?? [],
  }));

  const steps: BenchmarkStep[] = zipped.map(({ sessionId, sessionDate, sessionTurns }) => ({
    id: sanitizeStepId(sessionId),
    kind: 'memory',
    entityRefs: ['subject'],
    semanticType: 'conversation_session',
    title: `LongMemEval session ${sessionId}`,
    content: renderSessionContent(sessionDate, sessionTurns),
    metadata: {
      dataset: 'longmemeval',
      session_id: sessionId,
      session_date: sessionDate,
      question_id: record.question_id,
      question_type: record.question_type,
      evidence_turns: sessionTurns.filter((turn) => turn.has_answer).length,
    },
  }));

  const question: BenchmarkQuestion = {
    id: sanitizeStepId(record.question_id),
    prompt: record.question,
    expectedAnswers: [normalizeWhitespace(record.answer)],
    expectedSourceStepIds: record.answer_session_ids.map(sanitizeStepId),
    tags: [
      'public-benchmark',
      'longmemeval',
      `variant:${record.question_id.endsWith('_abs') ? 'abstention' : record.question_type}`,
      `question-date:${record.question_date}`,
    ],
  };

  return {
    id: `longmemeval-${index + 1}-${sanitizeStepId(record.question_id)}`,
    category: mapCategory(record),
    description: `LongMemEval ${record.question_id.endsWith('_abs') ? 'abstention' : record.question_type}`,
    entities: [
      {
        ref: 'subject',
        entityType: 'bench_memory_subject',
        name: `LongMemEval Subject ${record.question_id}`,
        metadata: {
          dataset: 'longmemeval',
          question_id: record.question_id,
          question_type: record.question_type,
          question_date: record.question_date,
        },
      },
    ],
    steps,
    questions: [question],
  };
}

export async function downloadLongMemEvalDataset(
  variant: LongMemEvalVariant
): Promise<LongMemEvalRecord[]> {
  const response = await fetch(LONGMEMEVAL_URLS[variant]);
  if (!response.ok) {
    throw new Error(
      `Failed to download LongMemEval ${variant}: ${response.status} ${response.statusText}`
    );
  }

  const payload = (await response.json()) as LongMemEvalRecord[];
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error(`LongMemEval ${variant} payload was empty or invalid`);
  }
  return payload;
}

export function convertLongMemEvalToBenchmarkSuite(
  records: LongMemEvalRecord[],
  options: ConvertLongMemEvalOptions
): BenchmarkSuite {
  const offset = Math.max(options.offset ?? 0, 0);
  const sliced = records.slice(offset, options.limit ? offset + options.limit : undefined);
  if (sliced.length === 0) {
    throw new Error('No LongMemEval records matched the requested limit/offset');
  }

  return {
    id: options.suiteId ?? `longmemeval-${options.variant}-${options.limit ?? sliced.length}`,
    version: options.suiteVersion ?? '1.0.0',
    description: `Converted public benchmark suite from LongMemEval (${options.variant}, ${sliced.length} instances).`,
    entityTypes: [
      {
        slug: 'bench_memory_subject',
        name: 'Benchmark Memory Subject',
        eventKinds: {
          conversation_session: { description: 'Timestamped conversation history session' },
        },
      },
    ],
    scenarios: sliced.map((record, index) => toScenario(record, offset + index)),
  };
}

export async function prepareLongMemEvalSuite(args: {
  variant: LongMemEvalVariant;
  limit?: number;
  offset?: number;
  outputPath: string;
  suiteId?: string;
  suiteVersion?: string;
}): Promise<{ outputPath: string; suite: BenchmarkSuite }> {
  const records = await downloadLongMemEvalDataset(args.variant);
  const suite = convertLongMemEvalToBenchmarkSuite(records, {
    variant: args.variant,
    limit: args.limit,
    offset: args.offset,
    suiteId: args.suiteId,
    suiteVersion: args.suiteVersion,
  });

  const absoluteOutputPath = resolve(process.cwd(), args.outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  writeFileSync(absoluteOutputPath, JSON.stringify(suite, null, 2));

  return { outputPath: absoluteOutputPath, suite };
}
