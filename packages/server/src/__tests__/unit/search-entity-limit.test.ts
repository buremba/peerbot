import { describe, expect, it } from 'bun:test';
import { resolveEntityLimit } from '../../tools/search';

describe('resolveEntityLimit', () => {
  it.each([
    ['exact default', { fuzzy: false }, 1],
    ['fuzzy default', {}, 5],
    ['explicit fuzzy default', { fuzzy: true }, 5],
    ['embedding default', { query_embedding: [0.25] }, 20],
    ['explicit limit', { limit: 12 }, 12],
    ['defensive cap', { limit: 150 }, 100],
  ] as const)('%s', (_name, args, expected) => {
    expect(resolveEntityLimit(args)).toBe(expected);
  });
});
