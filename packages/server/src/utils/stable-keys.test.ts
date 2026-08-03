import { describe, expect, it } from 'vitest';
import { computeStableKey, formatBehaviorEntityIdentity } from './stable-keys';

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

  it('scopes the same tuple to its declared entity type', () => {
    const stableKey = computeStableKey({ id: 'ACME-1' }, ['id']);
    expect(formatBehaviorEntityIdentity(42, 'records', 'company', stableKey)).not.toBe(
      formatBehaviorEntityIdentity(42, 'records', 'contact', stableKey)
    );
  });

  it('keeps a maximal multibyte tuple inside the indexed identity budget', () => {
    const keyFields = Array.from(
      { length: 4 },
      (_, index) => `${index}${'界'.repeat(127)}`
    );
    const row = Object.fromEntries(
      keyFields.map((field) => [field, '😀'.repeat(64)])
    );
    const stableKey = computeStableKey(row, keyFields);
    const identifier = formatBehaviorEntityIdentity(
      42,
      'records',
      'company',
      stableKey
    );

    expect(identifier).toMatch(/^v2::[0-9a-f]{64}$/);
    expect(Buffer.byteLength(identifier, 'utf8')).toBeLessThanOrEqual(68);

    const changedRow = { ...row, [keyFields[3]]: 'different' };
    expect(
      formatBehaviorEntityIdentity(
        42,
        'records',
        'company',
        computeStableKey(changedRow, keyFields)
      )
    ).not.toBe(identifier);
  });
});
