import { describe, expect, it } from 'vitest';
import { computeStableKey } from './stable-keys';

describe('computeStableKey', () => {
  it('encodes an exact, typed composite tuple deterministically', () => {
    expect(
      computeStableKey(
        { category: 'Stability', name: 'App Crashes' },
        ['category', 'name']
      )
    ).toBe(
      'v1~Y2F0ZWdvcnk.s.U3RhYmlsaXR5~bmFtZQ.s.QXBwIENyYXNoZXM'
    );
  });

  it('keeps opaque ids distinct instead of slug-collapsing punctuation', () => {
    const slash = computeStableKey({ external_id: 'ACME/1' }, ['external_id']);
    const plain = computeStableKey({ external_id: 'ACME1' }, ['external_id']);
    expect(slash).not.toBe(plain);
  });

  it('preserves case, whitespace, and scalar type', () => {
    expect(computeStableKey({ id: 'ABC' }, ['id'])).not.toBe(
      computeStableKey({ id: 'abc' }, ['id'])
    );
    expect(computeStableKey({ id: '1' }, ['id'])).not.toBe(
      computeStableKey({ id: 1 }, ['id'])
    );
  });

  it('rejects partial, blank, non-scalar, unsafe, and oversized keys', () => {
    expect(() =>
      computeStableKey({ category: 'Stability', name: null }, ['category', 'name'])
    ).toThrow(/name.*non-null/i);
    expect(() => computeStableKey({ id: '   ' }, ['id'])).toThrow(/id.*non-blank/i);
    expect(() => computeStableKey({ id: ['nested'] }, ['id'])).toThrow(/id.*scalar/i);
    expect(() => computeStableKey({ id: 1.5 }, ['id'])).toThrow(/safe integer/i);
    expect(() => computeStableKey({ id: 'x'.repeat(257) }, ['id'])).toThrow(/256 bytes/i);
    expect(() => computeStableKey({ ['x'.repeat(129)]: 'value' }, ['x'.repeat(129)])).toThrow(
      /128 characters/i
    );
  });

  it('does not mutate the model output', () => {
    const row = { name: 'Performance Issues' };
    expect(computeStableKey(row, ['name'])).toMatch(/^v1~/);
    expect(row).toEqual({ name: 'Performance Issues' });
  });
});
