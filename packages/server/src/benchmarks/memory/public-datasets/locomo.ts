import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BenchmarkQuestion, BenchmarkScenario, BenchmarkStep, BenchmarkSuite } from '../types';

const LOCOMO_DATASET_URL =
  'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

interface LoCoMoMessage {
  speaker: string;
  dia_id: string;
  text: string;
}

interface LoCoMoQA {
  question: string;
  answer: string | number;
  evidence: string[];
  category: number;
}

interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: string | LoCoMoMessage[] | undefined;
}

interface LoCoMoItem {
  sample_id: string;
  qa: LoCoMoQA[];
  conversation: LoCoMoConversation;
  event_summary: Record<string, unknown>;
  observation: Record<string, unknown>;
  session_summary: Record<string, unknown>;
}

interface ConvertLoCoMoOptions {
  limit?: number;
  offset?: number;
  suiteId?: string;
  suiteVersion?: string;
}

const CATEGORY_TO_TYPE: Record<number, string> = {
  1: 'single-hop',
  2: 'multi-hop',
  3: 'temporal',
  4: 'world-knowledge',
  5: 'adversarial',
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function parseLoCoMoDate(dateStr: string): string | null {
  const match = dateStr.match(/(\d+):(\d+)\s*(am|pm)\s*on\s*(\d+)\s*(\w+),?\s*(\d+)/i);
  if (!match) return null;

  const [, hourStr, minuteStr, ampm, dayStr, monthName, yearStr] = match;
  let hour = Number.parseInt(hourStr ?? '0', 10);
  const minute = Number.parseInt(minuteStr ?? '0', 10);

  if (ampm?.toLowerCase() === 'pm' && hour !== 12) hour += 12;
  if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;

  const monthNames = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ];
  const monthIndex = monthNames.findIndex((name) =>
    name.startsWith((monthName ?? '').toLowerCase())
  );
  if (monthIndex < 0) return null;

  return new Date(
    Date.UTC(
      Number.parseInt(yearStr ?? '0', 10),
      monthIndex,
      Number.parseInt(dayStr ?? '1', 10),
      hour,
      minute
    )
  ).toISOString();
}

function renderSessionContent(sessionDate: string | undefined, messages: LoCoMoMessage[]): string {
  const parts: string[] = [];
  if (sessionDate) parts.push(`Session date: ${sessionDate}`);

  const renderedMessages = messages
    .map(
      (message, index) =>
        `Turn ${index + 1} (${message.speaker}) [dia_id=${message.dia_id}]: ${normalizeWhitespace(message.text)}`
    )
    .join('\n\n');

  if (renderedMessages) parts.push(renderedMessages);
  return parts.join('\n\n');
}

function extractSessionEntries(item: LoCoMoItem): Array<{
  step: BenchmarkStep;
  evidenceDiaIds: Set<string>;
}> {
  const entries: Array<{ step: BenchmarkStep; evidenceDiaIds: Set<string> }> = [];
  const conversation = item.conversation;

  for (let index = 1; index <= 100; index += 1) {
    const sessionKey = `session_${index}`;
    const rawMessages = conversation[sessionKey];
    if (rawMessages == null) break;
    if (!Array.isArray(rawMessages)) continue;

    const dateKey = `session_${index}_date_time`;
    const rawDate = conversation[dateKey];
    const sessionDate = typeof rawDate === 'string' ? rawDate : undefined;
    const parsedDate = sessionDate ? parseLoCoMoDate(sessionDate) : null;
    const stepId = sanitizeId(`${item.sample_id}-${sessionKey}`);
    const evidenceDiaIds = new Set(rawMessages.map((message) => sanitizeId(message.dia_id)));

    entries.push({
      step: {
        id: stepId,
        kind: 'memory',
        entityRefs: ['subject'],
        semanticType: 'conversation_session',
        title: `LoCoMo ${item.sample_id} ${sessionKey}`,
        content: renderSessionContent(sessionDate, rawMessages),
        metadata: {
          dataset: 'locomo',
          sample_id: item.sample_id,
          session_key: sessionKey,
          session_date: sessionDate,
          session_date_iso: parsedDate,
          speaker_a: conversation.speaker_a,
          speaker_b: conversation.speaker_b,
          dialogue_turn_count: rawMessages.length,
          dialogue_ids: rawMessages.map((message) => sanitizeId(message.dia_id)),
        },
      },
      evidenceDiaIds,
    });
  }

  return entries;
}

function mapCategory(category: number): string {
  return CATEGORY_TO_TYPE[category] ?? 'locomo';
}

function questionToScenario(
  item: LoCoMoItem,
  qa: LoCoMoQA,
  questionIndex: number,
  absoluteIndex: number
): BenchmarkScenario {
  const sessionEntries = extractSessionEntries(item);
  const evidenceIds = new Set((qa.evidence ?? []).map(sanitizeId));
  const expectedSourceStepIds = sessionEntries
    .filter(({ evidenceDiaIds }) => [...evidenceIds].some((id) => evidenceDiaIds.has(id)))
    .map(({ step }) => step.id);

  const questionId = sanitizeId(`${item.sample_id}-q${questionIndex + 1}`);
  const question: BenchmarkQuestion = {
    id: questionId,
    prompt: qa.question,
    expectedAnswers: [String(qa.answer)],
    expectedSourceStepIds,
    tags: [
      'public-benchmark',
      'locomo',
      `category:${mapCategory(qa.category)}`,
      `sample:${item.sample_id}`,
    ],
  };

  return {
    id: `locomo-${absoluteIndex + 1}-${questionId}`,
    category: mapCategory(qa.category),
    description: `LoCoMo ${mapCategory(qa.category)} question from ${item.sample_id}`,
    entities: [
      {
        ref: 'subject',
        entityType: 'bench_memory_subject',
        name: `LoCoMo Subject ${questionId}`,
        metadata: {
          dataset: 'locomo',
          sample_id: item.sample_id,
          question_id: questionId,
          speaker_a: item.conversation.speaker_a,
          speaker_b: item.conversation.speaker_b,
        },
      },
    ],
    steps: sessionEntries.map(({ step }) => step),
    questions: [question],
  };
}

async function downloadLoCoMoDataset(): Promise<LoCoMoItem[]> {
  const response = await fetch(LOCOMO_DATASET_URL);
  if (!response.ok) {
    throw new Error(`Failed to download LoCoMo: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as LoCoMoItem[];
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error('LoCoMo payload was empty or invalid');
  }
  return payload;
}

export function convertLoCoMoToBenchmarkSuite(
  records: LoCoMoItem[],
  options: ConvertLoCoMoOptions = {}
): BenchmarkSuite {
  const flattened = records.flatMap((item) =>
    item.qa.map((qa, questionIndex) => ({ item, qa, questionIndex }))
  );
  const offset = Math.max(options.offset ?? 0, 0);
  const sliced = flattened.slice(offset, options.limit ? offset + options.limit : undefined);
  if (sliced.length === 0) {
    throw new Error('No LoCoMo questions matched the requested limit/offset');
  }

  return {
    id: options.suiteId ?? `locomo-${options.limit ?? sliced.length}`,
    version: options.suiteVersion ?? '1.0.0',
    description: `Converted public benchmark suite from LoCoMo (${sliced.length} questions).`,
    entityTypes: [
      {
        slug: 'bench_memory_subject',
        name: 'Benchmark Memory Subject',
        eventKinds: {
          conversation_session: { description: 'Timestamped multi-session conversation history' },
        },
      },
    ],
    scenarios: sliced.map(({ item, qa, questionIndex }, index) =>
      questionToScenario(item, qa, questionIndex, offset + index)
    ),
  };
}

export async function prepareLoCoMoSuite(args: {
  limit?: number;
  offset?: number;
  outputPath: string;
  suiteId?: string;
  suiteVersion?: string;
}): Promise<{ outputPath: string; suite: BenchmarkSuite }> {
  const records = await downloadLoCoMoDataset();
  const suite = convertLoCoMoToBenchmarkSuite(records, {
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
