import { describe, expect, it } from 'bun:test';
import { computeRunUsage } from '../../cost/run-usage';

function jsonl(...lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function assistant(provider: string, model: string, usage: object) {
  return {
    type: 'message',
    id: 'a',
    message: { role: 'assistant', provider, model, usage },
  };
}

describe('computeRunUsage', () => {
  it('prices a single >200k model run via the catalog tier and keeps pi cost', () => {
    const snap = jsonl(
      { type: 'session', id: 's1' },
      assistant('anthropic', 'claude-sonnet-4-5', {
        input: 250_000,
        output: 50_000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 1.5 },
      })
    );
    const r = computeRunUsage({ snapshotJsonl: snap });
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-sonnet-4-5');
    expect(r.inputTokens).toBe(250_000);
    expect(r.usd).toBeCloseTo(2.625, 4); // tiered, vs pi's flat 1.5
    expect(r.piCostUsd).toBeCloseTo(1.5, 6);
    expect(r.unpriced).toBe(false);
    expect(r.breakdown).toHaveLength(1);
  });

  it('sums usage across multiple messages of the same model', () => {
    const snap = jsonl(
      { type: 'session', id: 's1' },
      assistant('anthropic', 'claude-sonnet-4-5', {
        input: 1000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.01 },
      }),
      assistant('anthropic', 'claude-sonnet-4-5', {
        input: 2000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 0,
        cost: { total: 0.02 },
      })
    );
    const r = computeRunUsage({ snapshotJsonl: snap });
    expect(r.inputTokens).toBe(3000);
    expect(r.outputTokens).toBe(300);
    expect(r.cacheReadTokens).toBe(500);
    expect(r.breakdown).toHaveLength(1);
    expect(r.piCostUsd).toBeCloseTo(0.03, 6);
    expect(r.unpriced).toBe(false);
  });

  it('marks the run unpriced (usd null) when any segment is unknown; primary = larger', () => {
    const snap = jsonl(
      { type: 'session', id: 's1' },
      assistant('anthropic', 'claude-sonnet-4-5', {
        input: 100_000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0.3 },
      }),
      assistant('whoprovider', 'no-such-model-xyz', {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { total: 0 },
      })
    );
    const r = computeRunUsage({ snapshotJsonl: snap });
    expect(r.breakdown).toHaveLength(2);
    expect(r.provider).toBe('anthropic'); // larger-token segment wins
    expect(r.model).toBe('claude-sonnet-4-5');
    expect(r.usd).toBeNull();
    expect(r.unpriced).toBe(true);
  });

  it('returns zeros for a snapshot with no assistant usage', () => {
    const snap = jsonl(
      { type: 'session', id: 's1' },
      { type: 'message', id: 'u1', message: { role: 'user', content: 'hi' } }
    );
    const r = computeRunUsage({ snapshotJsonl: snap });
    expect(r.inputTokens).toBe(0);
    expect(r.usd).toBe(0);
    expect(r.unpriced).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.breakdown).toHaveLength(0);
  });
});
