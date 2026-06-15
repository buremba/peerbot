import { describe, expect, test } from 'bun:test';
import { validateEntityMetrics } from '../metrics.js';

describe('validateEntityMetrics', () => {
  const valid = {
    eventSets: { charges: { by: 'alias', field: "metadata->>'d'" } },
    segments: { outflow: { description: 'out', where: "d='out'", on: 'event' } },
    measures: {
      spend: {
        eventSet: 'charges',
        agg: 'sum',
        expr: "(metadata->>'a')::numeric",
        segments: ['outflow'],
        description: 'Total spend.',
      },
      n: { eventSet: 'charges', agg: 'count', description: 'Count.' },
    },
    dimensions: { currency: { expr: "metadata->>'c'", description: 'Currency.' } },
  };

  test('a well-formed metric contract has no errors', () => {
    expect(validateEntityMetrics(valid)).toEqual([]);
  });

  test('null / undefined is valid (no metrics declared)', () => {
    expect(validateEntityMetrics(null)).toEqual([]);
    expect(validateEntityMetrics(undefined)).toEqual([]);
  });

  test('a measure referencing a missing eventSet is rejected', () => {
    const errs = validateEntityMetrics({
      measures: { spend: { eventSet: 'nope', agg: 'sum', expr: 'x', description: 'd' } },
    });
    expect(errs.some((e) => e.includes('eventSet "nope"'))).toBe(true);
  });

  test('a measure referencing a missing segment is rejected', () => {
    const errs = validateEntityMetrics({
      eventSets: { c: { by: 'alias' } },
      measures: {
        spend: { eventSet: 'c', agg: 'sum', expr: 'x', segments: ['ghost'], description: 'd' },
      },
    });
    expect(errs.some((e) => e.includes('segment "ghost"'))).toBe(true);
  });

  test('a non-count measure without expr is rejected; count without expr is fine', () => {
    const errs = validateEntityMetrics({
      eventSets: { c: { by: 'alias' } },
      measures: {
        bad: { eventSet: 'c', agg: 'sum', description: 'd' },
        ok: { eventSet: 'c', agg: 'count', description: 'd' },
      },
    });
    expect(errs.some((e) => e.includes('measure "bad"') && e.includes('expr is required'))).toBe(
      true,
    );
    expect(errs.some((e) => e.includes('measure "ok"'))).toBe(false);
  });

  test('a measure / dimension without a description is rejected', () => {
    const errs = validateEntityMetrics({
      eventSets: { c: { by: 'alias' } },
      measures: { spend: { eventSet: 'c', agg: 'count', description: '' } },
      dimensions: { cur: { expr: 'x', description: '   ' } },
    });
    expect(errs.some((e) => e.includes('measure "spend"') && e.includes('description'))).toBe(true);
    expect(errs.some((e) => e.includes('dimension "cur"') && e.includes('description'))).toBe(true);
  });

  test('a non-object is rejected defensively', () => {
    expect(validateEntityMetrics('nope')).toEqual(['metrics must be an object']);
  });
});
