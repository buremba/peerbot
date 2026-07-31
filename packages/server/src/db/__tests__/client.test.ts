import { describe, expect, it } from 'vitest';
import { parsePgTextArray, pgBigintArray, pgTextArray } from '../client';

describe('database array helpers', () => {
  it('formats bigint arrays as PostgreSQL literals', () => {
    expect(pgBigintArray([55, 212, 999])).toBe('{55,212,999}');
    expect(pgBigintArray([])).toBe('{}');
  });

  it('formats text arrays as PostgreSQL literals', () => {
    expect(pgTextArray(['alpha', 'beta'])).toBe('{"alpha","beta"}');
  });

  it('parses PostgreSQL text array literals', () => {
    expect(parsePgTextArray('{a,b}')).toEqual(['a', 'b']);
    expect(parsePgTextArray('{}')).toEqual([]);
    expect(parsePgTextArray(null)).toEqual([]);
    expect(parsePgTextArray(['already', 'array'])).toEqual([
      'already',
      'array',
    ]);
    expect(parsePgTextArray('{"c d"}')).toEqual(['c d']);
    expect(parsePgTextArray('{"say \\"hi\\"","back\\\\slash"}')).toEqual([
      'say "hi"',
      'back\\slash',
    ]);
  });

  it('keeps commas inside quoted elements', () => {
    // PostgreSQL quotes any element containing a comma, so this is ONE
    // element; splitting on every comma shredded it into two invalid ones.
    expect(
      parsePgTextArray(
        '{"https://app.example.com/callback?tags=a,b",https://alt.example.com/cb}'
      )
    ).toEqual([
      'https://app.example.com/callback?tags=a,b',
      'https://alt.example.com/cb',
    ]);
  });

  it('round-trips pgTextArray output', () => {
    const values = ['https://x/cb?tags=a,b', 'say "hi"', 'plain'];
    expect(parsePgTextArray(pgTextArray(values))).toEqual(values);
  });
});
