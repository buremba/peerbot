import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_METADATA_LIMITS,
  exceedsValidationLimits,
} from '../../utils/metadata-limits';

describe('exceedsValidationLimits', () => {
  it('accepts normal nested metadata', () => {
    const metadata = {
      name: 'Acme Corp',
      stage: 'qualified',
      contact: { email: 'a@b.com', phones: ['+1', '+2'] },
      tags: ['lead', 'priority'],
      score: 42,
    };
    expect(exceedsValidationLimits(metadata)).toBe(false);
  });

  it('accepts empty and primitive-light objects', () => {
    expect(exceedsValidationLimits({})).toBe(false);
    expect(exceedsValidationLimits({ a: 1, b: 'x', c: null })).toBe(false);
  });

  it('rejects pathologically deep nesting fast', () => {
    // Build a chain deeper than maxDepth: {a:{a:{a:...}}}.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < DEFAULT_METADATA_LIMITS.maxDepth + 5; i++) {
      deep = { a: deep };
    }
    const start = performance.now();
    expect(exceedsValidationLimits(deep)).toBe(true);
    // The guard bails early; it must not itself be slow.
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('rejects too many nodes (wide fan-out)', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < DEFAULT_METADATA_LIMITS.maxNodes + 1; i++) {
      wide[`k${i}`] = i;
    }
    expect(exceedsValidationLimits(wide)).toBe(true);
  });

  it('rejects oversized payloads via the byte gate', () => {
    const huge = { blob: 'x'.repeat(DEFAULT_METADATA_LIMITS.maxBytes + 1) };
    const start = performance.now();
    expect(exceedsValidationLimits(huge)).toBe(true);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('rejects unserializable input (circular references)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(exceedsValidationLimits(circular)).toBe(true);
  });

  it('accepts a payload sitting just under every limit', () => {
    const justUnder: Record<string, number> = {};
    // Comfortably under maxNodes and maxBytes; shallow depth.
    for (let i = 0; i < 100; i++) {
      justUnder[`k${i}`] = i;
    }
    expect(exceedsValidationLimits(justUnder)).toBe(false);
  });

  it('counts array elements toward the node budget', () => {
    const arrayHeavy = { items: Array.from({ length: 100 }, (_, i) => i) };
    expect(exceedsValidationLimits(arrayHeavy)).toBe(false);

    const overBudget = {
      items: Array.from(
        { length: DEFAULT_METADATA_LIMITS.maxNodes + 1 },
        (_, i) => i
      ),
    };
    expect(exceedsValidationLimits(overBudget)).toBe(true);
  });

  it('honors custom limits', () => {
    const metadata = { a: { b: { c: 1 } } };
    expect(
      exceedsValidationLimits(metadata, {
        maxDepth: 1,
        maxNodes: 1000,
        maxBytes: 1000,
      })
    ).toBe(true);
    expect(
      exceedsValidationLimits(metadata, {
        maxDepth: 32,
        maxNodes: 1000,
        maxBytes: 1000,
      })
    ).toBe(false);
  });
});
