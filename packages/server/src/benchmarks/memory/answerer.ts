import type {
  AnswererConfig,
  AnswerResult,
  OpenAiCompatibleAnswererConfig,
  RetrievedMemory,
} from './types';

interface BenchmarkAnswerer {
  describe(): string;
  answer(question: string, items: RetrievedMemory[], contextPrefix?: string): Promise<AnswerResult>;
}

function stripCodeFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function buildContextText(items: RetrievedMemory[], contextPrefix?: string): string {
  const sections: string[] = [];

  if (contextPrefix?.trim()) {
    sections.push(`Supplemental context (non-citable background):\n${contextPrefix.trim()}`);
  }

  const itemContexts = items
    .map(
      (item, index) =>
        `[${index + 1}] benchmark_id=${item.id}\n${item.text}${item.metadata ? `\nmetadata=${JSON.stringify(item.metadata)}` : ''}`
    )
    .join('\n\n');

  if (itemContexts) sections.push(itemContexts);
  return sections.join('\n\n');
}

export function estimateApproxTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

function buildPrompt(question: string, items: RetrievedMemory[], contextPrefix?: string): string {
  const contexts = buildContextText(items, contextPrefix);

  return [
    'You answer benchmark questions using only the provided contexts.',
    'Many questions require temporal reasoning over session dates, relative time expressions, event ordering, and simple arithmetic.',
    'Use the session dates/times and evidence text to infer chronology when needed.',
    'If the question asks which of several options happened first, last, earlier, later, or most recently, answer with exactly one option text from the question.',
    'If the question asks for a time, date, duration, or count and it can be inferred from the contexts, infer it and answer concisely.',
    'For "when" questions, your answer MUST be an absolute date written in day-month-year form as it appears in the evidence (e.g. "20 May 2023", "June 2023", "2022"). Never return relative phrases like "last year", "last week", "this month", "next month", "a while ago", or "last Friday" — always resolve them against the Session date index first.',
    'Do not answer "unknown" if the answer can be directly inferred from the contexts.',
    'Supplemental context may appear before the itemized benchmark entries. Use it as background only; only cite benchmark_id entries.',
    'Return strict JSON with keys: answer (string), cited_ids (array of benchmark_id strings).',
    'Only cite the minimum benchmark_ids that directly support the answer.',
    'If the answer is unknown from the contexts, return {"answer":"unknown","cited_ids":[]}.',
    '',
    `Question: ${question}`,
    '',
    'Contexts:',
    contexts || '(none)',
  ].join('\n');
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAnswer(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s+\./g, '.').trim();
}

function findProperNouns(value: string): string[] {
  return value.match(/\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,3}\b/g) ?? [];
}

function findMentionedPhrase(question: string, phrases: string[]): string | null {
  const normalizedQuestion = normalize(question);
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    if (normalizedQuestion.includes(normalize(phrase))) return phrase;
  }
  return null;
}

function sentenceResult(item: RetrievedMemory): AnswerResult {
  return { answer: item.text, citedIds: [item.id] };
}

function pickByRegex(
  items: RetrievedMemory[],
  regex: RegExp,
  transform?: (match: RegExpMatchArray) => string
): AnswerResult | null {
  for (const item of items) {
    const match = item.text.match(regex);
    if (!match) continue;
    return {
      answer: normalizeAnswer(transform ? transform(match) : (match[1] ?? 'unknown')),
      citedIds: [item.id],
    };
  }
  return null;
}

function pickSentenceForQuestion(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const phrases = findProperNouns(question);
  const mentioned = findMentionedPhrase(question, phrases);
  if (mentioned) {
    const matchingItem = items.find((item) => normalize(item.text).includes(normalize(mentioned)));
    if (matchingItem) return sentenceResult(matchingItem);
  }
  return items[0] ? sentenceResult(items[0]) : null;
}

function answerPreference(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  const asksForPerson = q.startsWith('who') || q.startsWith('which person');
  if (asksForPerson) {
    return pickByRegex(items, /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+prefers\s+/i, (m) =>
      m[1]!.trim()
    );
  }

  return pickByRegex(items, /prefers\s+([A-Za-z][A-Za-z\s-]+)\.?$/i, (m) => m[1]!.trim());
}

function answerEmployment(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  const employmentFacts = items
    .map((item) => {
      const match = item.text.match(/^(.*?)\s+(?:now\s+)?works?\s+at\s+(.*?)\.?$/i);
      return match
        ? {
            item,
            person: normalizeAnswer(match[1]!.trim()),
            company: normalizeAnswer(match[2]!.trim()),
          }
        : null;
    })
    .filter(
      (value): value is { item: RetrievedMemory; person: string; company: string } => value !== null
    );

  const mentionedCompany = findMentionedPhrase(
    question,
    employmentFacts.map((fact) => fact.company)
  );

  if (q.startsWith('who')) {
    const fact = mentionedCompany
      ? employmentFacts.find((entry) => normalize(entry.company) === normalize(mentionedCompany))
      : employmentFacts[0];
    return fact ? { answer: fact.person, citedIds: [fact.item.id] } : null;
  }

  const mentionedPerson = findMentionedPhrase(
    question,
    employmentFacts.map((fact) => fact.person)
  );

  if (mentionedPerson) {
    const fact = employmentFacts.find(
      (entry) => normalize(entry.person) === normalize(mentionedPerson)
    );
    return fact ? { answer: fact.company, citedIds: [fact.item.id] } : null;
  }

  const firstFact = employmentFacts[0];
  return firstFact ? { answer: firstFact.company, citedIds: [firstFact.item.id] } : null;
}

function answerBudget(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  const wantsOriginal = q.includes('original') || q.includes('initial') || q.includes('before');
  const wantsLatest =
    q.includes('latest') || q.includes('current') || q.includes('after') || q.includes('revision');
  const mentionedEntity = findMentionedPhrase(question, findProperNouns(question));

  const entityScopedItems = mentionedEntity
    ? items.filter((item) => normalize(item.text).includes(normalize(mentionedEntity)))
    : items;

  const preferredItems = entityScopedItems.filter((item) => {
    const text = normalize(item.text);
    if (wantsOriginal) return !text.includes('revised') && !text.includes('later');
    if (wantsLatest) return text.includes('revised') || text.includes('later');
    return true;
  });

  const candidateItems =
    preferredItems.length > 0
      ? preferredItems
      : entityScopedItems.length > 0
        ? entityScopedItems
        : items;

  return pickByRegex(candidateItems, /(\$?\d[\d,]*)/i, (m) => m[1]!.replace(/,/g, ''));
}

function answerBudgetChange(items: RetrievedMemory[]): AnswerResult | null {
  return (
    pickByRegex(items, /(launch\s+was\s+[^.]+)\.?$/i, (m) => m[1]!.trim()) ??
    pickByRegex(items, /([^.]*(?:delayed|changed)[^.]+)\.?$/i, (m) => m[1]!.trim())
  );
}

function answerDecision(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  if (q.startsWith('which project') || q.startsWith('what project') || q.startsWith('who')) {
    return pickByRegex(items, /(Project\s+[A-Z][A-Za-z0-9]+).*decided\s+to\s+/i, (m) =>
      m[1]!.trim()
    );
  }

  return pickByRegex(items, /decided\s+to\s+([^.]*)\.?$/i, (m) => m[1]!.trim());
}

function answerLead(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  const role = q.includes('support lead')
    ? 'support lead'
    : q.includes('product lead')
      ? 'product lead'
      : null;
  const asksForPerson = q.startsWith('who') || q.startsWith('which');

  if (asksForPerson && role) {
    return pickByRegex(
      items,
      new RegExp(
        `^([A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*)\\s+is\\s+(?:now\\s+)?the\\s+${escapeRegex(role)}\\.?$`,
        'i'
      ),
      (m) => m[1]!.trim()
    );
  }

  const mentionedPerson = findMentionedPhrase(question, findProperNouns(question));
  if (mentionedPerson) {
    return pickByRegex(
      items,
      new RegExp(`^${escapeRegex(mentionedPerson)}\\s+is\\s+(?:now\\s+)?the\\s+([^.]*)\\.?$`, 'i'),
      (m) => m[1]!.trim()
    );
  }

  return null;
}

function answerBased(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  const asksForPerson = q.startsWith('who') || q.startsWith('which');

  if (asksForPerson) {
    const mentionedLocation = findMentionedPhrase(
      question,
      items
        .map((item) => item.text.match(/based\s+in\s+([A-Z][A-Za-z0-9\s.-]+)\.?$/i)?.[1])
        .filter((value): value is string => Boolean(value))
    );

    if (mentionedLocation) {
      return pickByRegex(
        items,
        new RegExp(
          `^([A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)*)\\s+is\\s+based\\s+in\\s+${escapeRegex(mentionedLocation)}\\.?$`,
          'i'
        ),
        (m) => m[1]!.trim()
      );
    }
  }

  const mentionedPerson = findMentionedPhrase(question, findProperNouns(question));
  if (mentionedPerson) {
    return pickByRegex(
      items,
      new RegExp(
        `^${escapeRegex(mentionedPerson)}\\s+is\\s+based\\s+in\\s+([A-Z][A-Za-z0-9\\s.-]+)\\.?$`,
        'i'
      ),
      (m) => m[1]!.trim()
    );
  }

  return null;
}

function answerManages(items: RetrievedMemory[]): AnswerResult | null {
  return pickByRegex(items, /^([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+manages\s+/i, (m) =>
    m[1]!.trim()
  );
}

function answerOwnership(question: string, items: RetrievedMemory[]): AnswerResult | null {
  const q = normalize(question);
  if (!q.includes('team')) return null;

  const partRelations = items
    .map((item) => {
      const match = item.text.match(/^(.*?)\s+is\s+part\s+of\s+(.*?)\.?$/i);
      return match
        ? {
            item,
            feature: normalizeAnswer(match[1]!.trim()),
            product: normalizeAnswer(match[2]!.trim()),
          }
        : null;
    })
    .filter(
      (value): value is { item: RetrievedMemory; feature: string; product: string } =>
        value !== null
    );

  const ownerRelations = items
    .map((item) => {
      const match = item.text.match(/^(.*?)\s+owns\s+(.*?)\.?$/i);
      return match
        ? {
            item,
            team: normalizeAnswer(match[1]!.trim()),
            product: normalizeAnswer(match[2]!.trim()),
          }
        : null;
    })
    .filter(
      (value): value is { item: RetrievedMemory; team: string; product: string } => value !== null
    );

  const part = partRelations.find((relation) =>
    normalize(question).includes(normalize(relation.feature))
  );
  if (!part) return null;

  const owner = ownerRelations.find(
    (relation) => normalize(relation.product) === normalize(part.product)
  );
  if (!owner) return null;

  return {
    answer: owner.team,
    citedIds: [...new Set([part.item.id, owner.item.id])],
  };
}

class ExtractiveAnswerer implements BenchmarkAnswerer {
  describe(): string {
    return 'deterministic-extractive';
  }

  async answer(
    question: string,
    items: RetrievedMemory[],
    _contextPrefix?: string
  ): Promise<AnswerResult> {
    const q = normalize(question);
    if (items.length === 0) return { answer: 'unknown', citedIds: [] };

    if (q.includes('prefer') || q.includes('drink') || q.includes('beverage')) {
      return (
        answerPreference(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('work') || q.includes('employ')) {
      return (
        answerEmployment(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if ((q.includes('team') && q.includes('own')) || q.includes('owned by which team')) {
      return (
        answerOwnership(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (
      q.includes('budget') &&
      (q.includes('change') || q.includes('changed') || q.includes('happened'))
    ) {
      return (
        answerBudgetChange(items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('budget')) {
      return (
        answerBudget(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('decid')) {
      return (
        answerDecision(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('lead')) {
      return (
        answerLead(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('based')) {
      return (
        answerBased(question, items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    if (q.includes('manages') || q.includes('manage')) {
      return (
        answerManages(items) ??
        pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] }
      );
    }

    return pickSentenceForQuestion(question, items) ?? { answer: 'unknown', citedIds: [] };
  }
}

class OpenAiCompatibleAnswerer implements BenchmarkAnswerer {
  // Public-safe fields are stored separately from the apiKeyEnv name so
  // CodeQL doesn't taint the description via class-wide field access on
  // an object that also exposes the secret env name.
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly description: string;
  // Both the env var name and value are read through closures so they
  // never appear as class fields, which CodeQL otherwise flags as
  // sensitive even when only the name (not the value) is stored.
  private readonly readApiKey: () => string | undefined;
  private readonly missingKeyError: () => Error;

  constructor(config: OpenAiCompatibleAnswererConfig) {
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.temperature = config.temperature ?? 0;
    this.maxTokens = config.maxTokens ?? 300;
    this.description = `${this.model} via ${this.baseUrl}`;
    const envVar = config.apiKeyEnv;
    this.readApiKey = () => process.env[envVar];
    this.missingKeyError = () => new Error(`Missing answerer API key env '${envVar}'`);
  }

  describe(): string {
    return this.description;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shouldRetryStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }

  private async requestCompletion(args: {
    apiKey: string;
    question: string;
    items: RetrievedMemory[];
    contextPrefix?: string;
    maxTokens: number;
  }): Promise<{
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  }> {
    const isZai = /api\.z\.ai/i.test(this.baseUrl);
    const maxAttempts = 4;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            temperature: this.temperature,
            max_tokens: args.maxTokens,
            response_format: { type: 'json_object' },
            ...(isZai ? { thinking: { type: 'disabled' } } : {}),
            messages: [
              { role: 'system', content: 'Return only valid JSON.' },
              { role: 'user', content: buildPrompt(args.question, args.items, args.contextPrefix) },
            ],
          }),
        });

        if (!response.ok) {
          const text = await response.text();
          if (attempt < maxAttempts && this.shouldRetryStatus(response.status)) {
            await this.sleep(500 * 2 ** (attempt - 1));
            continue;
          }
          throw new Error(
            `Answerer request failed: ${response.status} ${response.statusText} ${text}`
          );
        }

        return (await response.json()) as {
          choices?: Array<{
            finish_reason?: string;
            message?: { content?: string; reasoning_content?: string };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
        };
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }

    throw new Error('Answerer request failed after retries');
  }

  async answer(
    question: string,
    items: RetrievedMemory[],
    contextPrefix?: string
  ): Promise<AnswerResult> {
    if (items.length === 0) {
      return { answer: 'unknown', citedIds: [] };
    }

    const apiKey = this.readApiKey();
    if (!apiKey) {
      throw this.missingKeyError();
    }

    const initialMaxTokens = this.maxTokens;
    let json = await this.requestCompletion({
      apiKey,
      question,
      items,
      contextPrefix,
      maxTokens: initialMaxTokens,
    });

    let content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
      json = await this.requestCompletion({
        apiKey,
        question,
        items,
        contextPrefix,
        maxTokens: Math.max(initialMaxTokens, 800),
      });
      content = json.choices?.[0]?.message?.content?.trim();
    }

    if (!content) {
      throw new Error('Answerer did not return message content');
    }

    const parsed = JSON.parse(stripCodeFences(content)) as {
      answer?: string;
      cited_ids?: string[];
    };

    const usage = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          totalTokens:
            json.usage.total_tokens ??
            (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0),
        }
      : undefined;

    return {
      answer: typeof parsed.answer === 'string' ? parsed.answer : 'unknown',
      citedIds: Array.isArray(parsed.cited_ids)
        ? parsed.cited_ids.filter((value): value is string => typeof value === 'string')
        : [],
      usage,
      raw: json,
    };
  }
}

export function createAnswerer(config: AnswererConfig | undefined): BenchmarkAnswerer | null {
  if (!config) return new ExtractiveAnswerer();
  if (config.type === 'none') return null;
  if (config.type === 'extractive') return new ExtractiveAnswerer();
  return new OpenAiCompatibleAnswerer(config);
}
