import { describe, expect, it } from 'vitest';
import { validateAndFormatIds, validateNumericId } from '../sql-validation';

describe('validateNumericId', () => {
  it('accepts non-negative integers', () => {
    expect(validateNumericId(0, 'id')).toBe(0);
    expect(validateNumericId(42, 'id')).toBe(42);
    expect(validateNumericId(2 ** 31 - 1, 'id')).toBe(2 ** 31 - 1);
  });

  it('rejects negative integers', () => {
    expect(() => validateNumericId(-1, 'id')).toThrow(/Invalid id/);
  });

  it('rejects non-integer numbers', () => {
    expect(() => validateNumericId(1.5, 'id')).toThrow(/Invalid id/);
    expect(() => validateNumericId(Number.NaN, 'id')).toThrow(/Invalid id/);
    expect(() => validateNumericId(Number.POSITIVE_INFINITY, 'id')).toThrow(/Invalid id/);
  });

  it('rejects SQL injection payloads masquerading as numbers', () => {
    // This is the shape a TypeScript type coercion bypass would look like at
    // runtime: an untyped JSON body smuggling a string through a number-typed
    // field. The validator must refuse it so the value never reaches an SQL
    // string builder.
    const malicious = "1) OR 1=1; DROP TABLE watchers; --" as unknown as number;
    expect(() => validateNumericId(malicious, 'exclude_watcher_id')).toThrow(
      /Invalid exclude_watcher_id/
    );
  });
});

describe('validateAndFormatIds', () => {
  it('joins valid integer ids as a comma-separated string', () => {
    expect(validateAndFormatIds([1, 2, 3], 'connection_ids')).toBe('1,2,3');
  });

  it('rejects empty or nullish arrays', () => {
    expect(() => validateAndFormatIds([], 'connection_ids')).toThrow(/non-empty array/);
    expect(() => validateAndFormatIds(null as unknown as number[], 'connection_ids')).toThrow(
      /non-empty array/
    );
  });

  it('rejects arrays containing non-integers or negatives', () => {
    expect(() => validateAndFormatIds([1, -2, 3], 'connection_ids')).toThrow(
      /Invalid connection_ids/
    );
    expect(() => validateAndFormatIds([1, 1.5, 3], 'connection_ids')).toThrow(
      /Invalid connection_ids/
    );
  });

  it('rejects arrays with injected strings', () => {
    const malicious = [1, "2); DROP TABLE connections; --" as unknown as number];
    expect(() => validateAndFormatIds(malicious, 'connection_ids')).toThrow(
      /Invalid connection_ids/
    );
  });
});
