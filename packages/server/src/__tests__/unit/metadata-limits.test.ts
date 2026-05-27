import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_METADATA_LIMITS,
  exceedsValidationLimits,
  isEmptyObject,
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
    // The guard bails early; it must not itself be slow. The budget is generous
    // (CI runners are noisy) but still far below the ~480ms a full-serialize
    // regression would cost — see the 100k-deep test below.
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('bails at maxDepth without traversing/serializing a hugely deep chain', () => {
    // Regression for the bounded-guard contract: a 100k-deep object must NOT be
    // fully walked or serialized — the guard must bail the instant it passes
    // maxDepth. (An earlier version JSON.stringify'd the whole value first and
    // took ~480ms on this input.) 250ms is well below that while tolerating
    // noisy CI runners.
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100_000; i++) {
      deep = { a: deep };
    }
    const start = performance.now();
    expect(exceedsValidationLimits(deep)).toBe(true);
    expect(performance.now() - start).toBeLessThan(250);
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
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('rejects circular references without hanging (bails at maxDepth)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const start = performance.now();
    // A cycle re-descends the same node forever in principle, but the depth
    // guard caps it: it bails at maxDepth rather than looping.
    expect(exceedsValidationLimits(circular)).toBe(true);
    expect(performance.now() - start).toBeLessThan(250);
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

  it('bails on wide object fan-out without materializing all keys', () => {
    // for...in iteration must increment/check the node budget incrementally;
    // a wildly wide object should bail fast at maxNodes.
    const wide: Record<string, number> = {};
    for (let i = 0; i < DEFAULT_METADATA_LIMITS.maxNodes + 5000; i++) {
      wide[`k${i}`] = i;
    }
    const start = performance.now();
    expect(exceedsValidationLimits(wide)).toBe(true);
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('rejects a single oversized string fast via the length short-circuit', () => {
    // The string is > maxBytes; we must reject without a full Buffer.byteLength
    // scan being the dominant cost.
    const huge = { blob: 'y'.repeat(8 * 1024 * 1024) }; // 8 MiB
    const start = performance.now();
    expect(exceedsValidationLimits(huge)).toBe(true);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('isEmptyObject', () => {
  it('detects empty objects', () => {
    expect(isEmptyObject({})).toBe(true);
  });

  it('detects non-empty objects without scanning all keys', () => {
    expect(isEmptyObject({ a: 1 })).toBe(false);
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100_000; i++) {
      wide[`k${i}`] = i;
    }
    const start = performance.now();
    expect(isEmptyObject(wide)).toBe(false);
    // Short-circuits on the first key regardless of object size.
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('ignores inherited enumerable properties', () => {
    const proto = { inherited: true };
    const obj = Object.create(proto) as Record<string, unknown>;
    expect(isEmptyObject(obj)).toBe(true);
  });
});
