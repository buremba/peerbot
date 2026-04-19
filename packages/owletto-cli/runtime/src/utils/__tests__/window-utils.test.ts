/**
 * Window Utils Tests
 */

import { describe, expect, it } from 'vitest';
import { ensureNumber, parseBigintArray } from '../window-utils';

describe('ensureNumber', () => {
  it('should convert bigint to number', () => {
    expect(ensureNumber(BigInt(42))).toBe(42);
  });

  it('should return number as-is', () => {
    expect(ensureNumber(42)).toBe(42);
  });

  it('should parse string to number', () => {
    expect(ensureNumber('42')).toBe(42);
  });

  it('should return 0 for null', () => {
    expect(ensureNumber(null)).toBe(0);
  });

  it('should return 0 for undefined', () => {
    expect(ensureNumber(undefined)).toBe(0);
  });

  it('should return 0 for NaN string', () => {
    expect(ensureNumber('not-a-number')).toBe(0);
  });

  it('should handle large bigint', () => {
    expect(ensureNumber(BigInt(9007199254740991))).toBe(9007199254740991);
  });

  it('should handle zero', () => {
    expect(ensureNumber(0)).toBe(0);
    expect(ensureNumber(BigInt(0))).toBe(0);
    expect(ensureNumber('0')).toBe(0);
  });
});

describe('parseBigintArray', () => {
  it('should parse JavaScript array', () => {
    expect(parseBigintArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('should parse PostgreSQL array string', () => {
    expect(parseBigintArray('{1,2,3}')).toEqual([1, 2, 3]);
  });

  it('should parse single element array string', () => {
    expect(parseBigintArray('{9}')).toEqual([9]);
  });

  it('should handle empty array', () => {
    expect(parseBigintArray([])).toEqual([]);
  });

  it('should handle empty string', () => {
    expect(parseBigintArray('{}')).toEqual([]);
  });

  it('should return empty for null/undefined', () => {
    expect(parseBigintArray(null)).toEqual([]);
    expect(parseBigintArray(undefined)).toEqual([]);
  });

  it('should convert bigint array elements to numbers', () => {
    const result = parseBigintArray([BigInt(1), BigInt(2)]);
    expect(result).toEqual([1, 2]);
  });
});
