import { describe, expect, it } from 'vitest';
import {
  buildContextText,
  createAnswerer,
  estimateApproxTokens,
} from '../../../benchmarks/memory/answerer';
import { convertLoCoMoToBenchmarkSuite } from '../../../benchmarks/memory/public-datasets/locomo';
import { computeRetrievalDiagnostics } from '../../../benchmarks/memory/publish';
import { scoreQuestion, summarizeQuestions } from '../../../benchmarks/memory/scoring';
import { validateBenchmarkSuite } from '../../../benchmarks/memory/suite';
import type { BenchmarkSuite, QuestionResult } from '../../../benchmarks/memory/types';

describe('memory benchmark suite validation', () => {
  it('validates a minimal suite', () => {
    const suite: BenchmarkSuite = {
      id: 'test-suite',
      version: '1.0.0',
      entityTypes: [{ slug: 'person', name: 'Person' }],
      relationshipTypes: [
        {
          slug: 'knows',
          name: 'knows',
          rules: [{ sourceEntityTypeSlug: 'person', targetEntityTypeSlug: 'person' }],
        },
      ],
      scenarios: [
        {
          id: 'scenario-1',
          category: 'facts',
          entities: [{ ref: 'alice', entityType: 'person', name: 'Alice' }],
          steps: [
            {
              id: 's1',
              kind: 'memory',
              entityRefs: ['alice'],
              semanticType: 'preference',
              content: 'Alice prefers tea.',
            },
          ],
          questions: [
            {
              id: 'q1',
              prompt: 'What does Alice prefer?',
              expectedAnswers: ['tea'],
              expectedSourceStepIds: ['s1'],
            },
          ],
        },
      ],
    };

    expect(validateBenchmarkSuite(suite)).toEqual(suite);
  });

  it('rejects unknown relationship types', () => {
    const suite: BenchmarkSuite = {
      id: 'test-suite',
      version: '1.0.0',
      entityTypes: [{ slug: 'person', name: 'Person' }],
      scenarios: [
        {
          id: 'scenario-1',
          category: 'facts',
          entities: [{ ref: 'alice', entityType: 'person', name: 'Alice' }],
          steps: [
            {
              id: 's1',
              kind: 'relationship',
              fromRef: 'alice',
              toRef: 'alice',
              relationshipType: 'unknown',
              content: 'Alice knows Alice.',
            },
          ],
          questions: [
            {
              id: 'q1',
              prompt: 'Who does Alice know?',
              expectedAnswers: ['Alice'],
              expectedSourceStepIds: ['s1'],
            },
          ],
        },
      ],
    };

    expect(() => validateBenchmarkSuite(suite)).toThrow("unknown relationship type 'unknown'");
  });

  it('converts LoCoMo questions into benchmark scenarios with evidence sessions', () => {
    const suite = convertLoCoMoToBenchmarkSuite(
      [
        {
          sample_id: 'conv-1',
          qa: [
            {
              question: 'When did Alice join the support group?',
              answer: '7 May 2023',
              evidence: ['D1:2'],
              category: 2,
            },
          ],
          conversation: {
            speaker_a: 'Alice',
            speaker_b: 'Bob',
            session_1_date_time: '4:30 pm on 7 May, 2023',
            session_1: [
              { speaker: 'Alice', dia_id: 'D1:1', text: 'Hi Bob.' },
              { speaker: 'Bob', dia_id: 'D1:2', text: 'You joined the support group today.' },
            ],
          },
          event_summary: {},
          observation: {},
          session_summary: {},
        },
      ],
      { suiteId: 'locomo-test' }
    );

    expect(suite.scenarios).toHaveLength(1);
    expect(suite.scenarios[0]?.category).toBe('multi-hop');
    expect(suite.scenarios[0]?.questions[0]?.expectedSourceStepIds).toEqual(['conv-1-session_1']);
  });

  it('allows benchmark questions without expected source steps for abstention-style cases', () => {
    const suite: BenchmarkSuite = {
      id: 'test-suite-no-sources',
      version: '1.0.0',
      entityTypes: [{ slug: 'person', name: 'Person' }],
      scenarios: [
        {
          id: 'scenario-1',
          category: 'adversarial',
          entities: [{ ref: 'alice', entityType: 'person', name: 'Alice' }],
          steps: [
            {
              id: 's1',
              kind: 'memory',
              entityRefs: ['alice'],
              semanticType: 'conversation_session',
              content: 'Alice talked about tea.',
            },
          ],
          questions: [
            {
              id: 'q1',
              prompt: 'Is Alice a pilot?',
              expectedAnswers: ['unknown'],
              expectedSourceStepIds: [],
            },
          ],
        },
      ],
    };

    expect(validateBenchmarkSuite(suite)).toEqual(suite);
  });
});

describe('memory benchmark answerer', () => {
  it('answers generic multi-hop ownership questions with both citations', async () => {
    const answerer = createAnswerer({ type: 'extractive' });
    const result = await answerer!.answer('Which team owns the Risk Dashboard feature?', [
      { id: 'r4', text: 'Risk Dashboard is part of Atlas.' },
      { id: 'r3', text: 'Team Vega owns Atlas.' },
    ]);

    expect(result.answer).toBe('Team Vega');
    expect(result.citedIds).toEqual(['r4', 'r3']);
  });

  it('answers original budget questions without preferring the revised fact', async () => {
    const answerer = createAnswerer({ type: 'extractive' });
    const result = await answerer!.answer(
      'What was the original approved budget for Project Sparrow?',
      [
        { id: 'b2', text: 'Project Sparrow budget was later revised to $150000.' },
        { id: 'b4', text: 'Project Falcon budget was approved at $180000.' },
        { id: 'b1', text: 'Project Sparrow budget was approved at $120000.' },
      ]
    );

    expect(result.answer).toBe('$120000');
    expect(result.citedIds).toEqual(['b1']);
  });

  it('answers reverse employment lookup by matching the company in the question', async () => {
    const answerer = createAnswerer({ type: 'extractive' });
    const result = await answerer!.answer('Who currently works at Stripe?', [
      { id: 'e2', text: 'Jordan Lee now works at Figma.' },
      { id: 'e3', text: 'Jordan Lin works at Stripe.' },
    ]);

    expect(result.answer).toBe('Jordan Lin');
    expect(result.citedIds).toEqual(['e3']);
  });

  it('supports retrieval-only runs with no answerer', () => {
    expect(createAnswerer({ type: 'none' })).toBeNull();
  });
});

describe('memory benchmark scoring', () => {
  it('scores answer, retrieval, and citations independently', () => {
    const score = scoreQuestion({
      expectedAnswers: ['Figma'],
      expectedSourceStepIds: ['e2'],
      answer: 'Jordan Lee now works at Figma.',
      citedIds: ['e2'],
      retrievedIds: ['e2', 'e1'],
    });

    expect(score.answerCorrect).toBe(1);
    expect(score.retrievalRecall).toBe(1);
    expect(score.citationRecall).toBe(1);
    expect(score.citationPrecision).toBe(1);
  });

  it('accepts shortened answers when expected text includes acceptable alternatives', () => {
    const score = scoreQuestion({
      expectedAnswers: ['7 days. 8 days (including the last day) is also acceptable.'],
      expectedSourceStepIds: ['s1', 's2'],
      answer: '7 days',
      citedIds: ['s1', 's2'],
      retrievedIds: ['s1', 's2'],
    });

    expect(score.answerCorrect).toBe(1);
  });

  it('treats number words and digits as equivalent for answer scoring', () => {
    const score = scoreQuestion({
      expectedAnswers: ['Four weeks'],
      expectedSourceStepIds: ['s1'],
      answer: '4 weeks',
      citedIds: ['s1'],
      retrievedIds: ['s1'],
    });

    expect(score.answerCorrect).toBe(1);
  });

  it('accepts small phrasing differences for semantically equivalent answers', () => {
    const score = scoreQuestion({
      expectedAnswers: ['Receiving the new phone case'],
      expectedSourceStepIds: ['s1'],
      answer: 'the narrator receiving their new phone case',
      citedIds: ['s1'],
      retrievedIds: ['s1'],
    });

    expect(score.answerCorrect).toBe(1);
  });

  it('summarizes question results', () => {
    const questions: QuestionResult[] = [
      {
        scenarioId: 'latest',
        category: 'latest_wins',
        questionId: 'q1',
        prompt: 'Where does Jordan Lee work now?',
        expectedAnswers: ['Figma'],
        expectedSourceStepIds: ['e2'],
        retrievedIds: ['e2'],
        answer: 'Figma',
        citedIds: ['e2'],
        latencyMs: 100,
        contextTokensApprox: 25,
        answererPromptTokens: 0,
        answererCompletionTokens: 0,
        score: {
          answerCorrect: 1,
          retrievalRecall: 1,
          citationRecall: 1,
          citationPrecision: 1,
        },
      },
      {
        scenarioId: 'latest',
        category: 'latest_wins',
        questionId: 'q2',
        prompt: 'Who is the support lead?',
        expectedAnswers: ['Maya Santos'],
        expectedSourceStepIds: ['m2'],
        retrievedIds: ['m2'],
        answer: 'Maya Santos',
        citedIds: ['m2'],
        latencyMs: 300,
        contextTokensApprox: 75,
        answererPromptTokens: 0,
        answererCompletionTokens: 0,
        score: {
          answerCorrect: 1,
          retrievalRecall: 1,
          citationRecall: 1,
          citationPrecision: 1,
        },
      },
    ];

    const summary = summarizeQuestions(questions);
    expect(summary.questionCount).toBe(2);
    expect(summary.averageLatencyMs).toBe(200);
    expect(summary.p95LatencyMs).toBe(300);
    expect(summary.averageContextTokensApprox).toBe(50);
    expect(summary.answerAccuracy).toBe(1);
  });

  it('flags the LoCoMo 3.7%-style failure: same 8 IDs retrieved for all 50 questions', () => {
    // Reproduces the pattern seen in artifact 6434390347 before embeddings were enabled.
    const lateSessionIds = [
      'conv-26-session_12',
      'conv-26-session_13',
      'conv-26-session_14',
      'conv-26-session_15',
      'conv-26-session_16',
      'conv-26-session_17',
      'conv-26-session_18',
      'conv-26-session_19',
    ];
    const questions = Array.from({ length: 50 }, (_, index) => ({
      expectedSourceStepIds: [`conv-26-session_${(index % 20) + 1}`],
      retrievedIds: lateSessionIds,
    }));

    const diag = computeRetrievalDiagnostics(questions);

    expect(diag.questionCount).toBe(50);
    expect(diag.distinctRetrievedIds).toBe(8);
    expect(diag.concentrationWarning).toBe(true);
    // Top IDs each appear in every question → 100% share, well above the 50% threshold.
    expect(diag.dominanceWarning).toBe(true);
    expect(diag.topRetrievedIds[0]?.share).toBe(1);
    // Most questions' expected step is NOT in the late cluster, so zero-recall is high.
    expect(diag.zeroRecallCount).toBeGreaterThan(30);
  });

  it('does not warn on healthy retrieval distributions', () => {
    const questions = Array.from({ length: 30 }, (_, index) => ({
      expectedSourceStepIds: [`step_${index}`],
      retrievedIds: [`step_${index}`, `step_${(index + 1) % 30}`, `step_${(index + 2) % 30}`],
    }));

    const diag = computeRetrievalDiagnostics(questions);

    expect(diag.distinctRetrievedIds).toBe(30);
    expect(diag.concentrationWarning).toBe(false);
    expect(diag.dominanceWarning).toBe(false);
    expect(diag.zeroRecallCount).toBe(0);
  });

  it('counts zero-recall questions correctly when retrieval misses gold entirely', () => {
    const questions = [
      { expectedSourceStepIds: ['gold-a'], retrievedIds: ['noise-1', 'noise-2'] },
      { expectedSourceStepIds: ['gold-b'], retrievedIds: ['gold-b'] },
      { expectedSourceStepIds: ['gold-c'], retrievedIds: [] },
      { expectedSourceStepIds: [], retrievedIds: ['noise-1'] }, // abstention-style
    ];

    const diag = computeRetrievalDiagnostics(questions);

    expect(diag.zeroRecallCount).toBe(2); // gold-a miss + gold-c miss; abstention is skipped
    expect(diag.questionCount).toBe(4);
  });

  it('builds context text with optional supplemental context and estimates tokens', () => {
    const context = buildContextText(
      [{ id: 's1', text: 'Alice prefers tea.' }],
      'Profile (static):\n- Alice likes warm drinks'
    );

    expect(context).toContain('Supplemental context (non-citable background):');
    expect(context).toContain('benchmark_id=s1');
    expect(estimateApproxTokens(context)).toBeGreaterThan(0);
  });
});
