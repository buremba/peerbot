import { describe, expect, it } from 'bun:test';
import { priceUsage } from '../../cost/price-usage';

const noUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe('priceUsage', () => {
  it('prices a >200k Anthropic run via the catalog tier (not the flat rate)', () => {
    const r = priceUsage({
      usage: { ...noUsage, input: 250_000, output: 50_000 },
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(r.source).toBe('catalog');
    expect(r.unpriced).toBe(false);
    // Tiered: input 250k @ $6/M + output 50k @ $22.5/M = 1.5 + 1.125. The flat
    // pi-ai formula would have returned $1.50 — this is the 43% we recover.
    expect(r.usd).toBeCloseTo(2.625, 4);
  });

  it('matches the flat rate below the 200k tier (no divergence on small runs)', () => {
    const r = priceUsage({
      usage: { ...noUsage, input: 50_000, output: 10_000 },
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    // 50k @ $3/M + 10k @ $15/M = 0.15 + 0.15
    expect(r.usd).toBeCloseTo(0.3, 6);
  });

  it('handles a cache-heavy run without throwing (token-semantics bridge)', () => {
    // cacheRead far exceeds uncached input; the naive shape throws
    // "Uncached … cannot be negative". The grand-total reconstruction fixes it.
    const r = priceUsage({
      usage: { input: 5_000, output: 5_000, cacheRead: 250_000, cacheWrite: 0 },
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(r.unpriced).toBe(false);
    expect(typeof r.usd).toBe('number');
    expect(r.usd as number).toBeGreaterThan(0);
  });

  it('applies an org override and reports source=override', () => {
    const r = priceUsage({
      usage: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      provider: 'selfhosted',
      model: 'my-local-llm',
      override: { inputMtok: 2, outputMtok: 4, cacheReadMtok: 0.5, cacheWriteMtok: 1 },
    });
    expect(r.source).toBe('override');
    expect(r.usd).toBeCloseTo(6, 6); // 1M*2/1M + 1M*4/1M
  });

  it('returns unpriced (null, never $0) for an unknown model', () => {
    const r = priceUsage({
      usage: { ...noUsage, input: 1000, output: 100 },
      provider: 'definitely-not-a-provider',
      model: 'no-such-model-xyz',
    });
    expect(r.unpriced).toBe(true);
    expect(r.usd).toBeNull();
    expect(r.source).toBe('unpriced');
  });

  it('aliases z-ai -> zai so it prices identically to the canonical id', () => {
    const usage = { ...noUsage, input: 8809, output: 140 };
    const aliased = priceUsage({ usage, provider: 'z-ai', model: 'glm-4.6' });
    const canonical = priceUsage({ usage, provider: 'zai', model: 'glm-4.6' });
    expect(aliased).toEqual(canonical);
  });
});
