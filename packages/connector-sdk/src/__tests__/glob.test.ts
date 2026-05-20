import { describe, expect, test } from 'bun:test';
import { matchesGlob } from '../sources/glob.js';

describe('matchesGlob', () => {
  test('literal match', () => {
    expect(matchesGlob('foo.txt', 'foo.txt')).toBe(true);
    expect(matchesGlob('foo.txt', 'bar.txt')).toBe(false);
  });

  test('* matches a single segment, not /', () => {
    expect(matchesGlob('foo.md', '*.md')).toBe(true);
    expect(matchesGlob('docs/foo.md', '*.md')).toBe(false);
  });

  test('**/ matches zero or more directories (root-level included)', () => {
    expect(matchesGlob('docs/foo.md', '**/*.md')).toBe(true);
    expect(matchesGlob('docs/sub/foo.md', '**/*.md')).toBe(true);
    expect(matchesGlob('foo.md', '**/*.md')).toBe(true); // root-level — must match
  });

  test('docs/**/*.md matches docs/foo.md AND docs/a/b/foo.md', () => {
    expect(matchesGlob('docs/foo.md', 'docs/**/*.md')).toBe(true);
    expect(matchesGlob('docs/a/b/foo.md', 'docs/**/*.md')).toBe(true);
    expect(matchesGlob('foo.md', 'docs/**/*.md')).toBe(false);
  });

  test('**/* matches root-level files too', () => {
    expect(matchesGlob('foo.md', '**/*')).toBe(true);
    expect(matchesGlob('a/b/c.txt', '**/*')).toBe(true);
  });

  test('** alone matches anything', () => {
    expect(matchesGlob('a/b/c.txt', '**')).toBe(true);
    expect(matchesGlob('foo.md', '**')).toBe(true);
  });

  test('? matches one non-slash char', () => {
    expect(matchesGlob('a.md', '?.md')).toBe(true);
    expect(matchesGlob('ab.md', '?.md')).toBe(false);
    expect(matchesGlob('a/md', '?.md')).toBe(false);
  });

  test('escapes regex metacharacters in literal segments', () => {
    expect(matchesGlob('a.b+c', 'a.b+c')).toBe(true);
    expect(matchesGlob('aXb+c', 'a.b+c')).toBe(false); // `.` is literal in glob
  });
});
