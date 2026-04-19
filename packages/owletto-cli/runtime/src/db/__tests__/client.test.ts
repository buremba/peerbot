import { describe, expect, it } from 'vitest';
import { pgBigintArray, pgTextArray } from '../client';

describe('database array helpers', () => {
  it('formats bigint arrays as PostgreSQL literals', () => {
    expect(pgBigintArray([55, 212, 999])).toBe('{55,212,999}');
    expect(pgBigintArray([])).toBe('{}');
  });

  it('formats text arrays as PostgreSQL literals', () => {
    expect(pgTextArray(['alpha', 'beta'])).toBe('{"alpha","beta"}');
  });
});
