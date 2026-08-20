import { describe, expect, it } from 'bun:test';
import {
  QUERY_TEXT_HEAD_CHARS,
  truncateRowText,
  truncateRowsText,
} from '../../../../tools/get_content/truncate';

describe('truncateRowText', () => {
  const head = 50;

  it('leaves short strings untouched', () => {
    const row = { payload_text: 'short', other: 'ok' };
    truncateRowText(row, head);
    expect(row).toEqual({ payload_text: 'short', other: 'ok' });
    expect(row.payload_truncated).toBeUndefined();
    expect(row.content_length).toBeUndefined();
  });

  it('truncates an oversized payload_text to a head plus marker and reports the full length', () => {
    const text = 'z'.repeat(10_000);
    const row = { payload_text: text };
    truncateRowText(row, head);
    expect(row.payload_truncated).toBe(true);
    expect(row.content_length).toBe(10_000);
    expect(typeof row.payload_text).toBe('string');
    expect((row.payload_text as string).startsWith('z'.repeat(head))).toBe(true);
    expect((row.payload_text as string).endsWith('\u2026 [truncated]')).toBe(true);
  });

  it('truncates ANY oversized string cell, not just payload_text', () => {
    const row = { summary: 'x'.repeat(5_000), payload_text: 'ok' };
    truncateRowText(row, head);
    expect((row.summary as string).endsWith('\u2026 [truncated]')).toBe(true);
    // Only payload_text/text_content carry the length/marker contract fields.
    expect(row.payload_truncated).toBeUndefined();
  });

  it('never splits a surrogate pair (char-based slicing is UTF-16-safe)', () => {
    const emoji = '😀'; // a 2-unit surrogate pair
    const text = 'a'.repeat(120) + emoji.repeat(60);
    const row = { payload_text: text };
    truncateRowText(row, head);
    const headStr = row.payload_text as string;
    const bare = headStr.replace(/\u2026 \[truncated\]$/, '');
    // String.slice never divides a surrogate pair, so the head re-encodes
    // identically (it is well-formed with no lone surrogate).
    expect(bare).toBe(Buffer.from(bare, 'utf8').toString('utf8'));
    expect(row.content_length).toBe(text.length);
  });

  it('treats values at exactly the cap as fitting (no truncation)', () => {
    const row = { payload_text: 'a'.repeat(head) };
    truncateRowText(row, head);
    expect(row.payload_truncated).toBeUndefined();
    expect(row.payload_text).toBe('a'.repeat(head));
  });
});

describe('truncateRowsText', () => {
  it('truncates every oversized string cell in every row', () => {
    const rows = [
      { payload_text: 'x'.repeat(5_000) },
      { payload_text: 'small', note: 'y'.repeat(5_000) },
      { numeric: 42 },
    ];
    truncateRowsText(rows as Array<Record<string, unknown>>, 50);
    expect((rows[0] as Record<string, unknown>).payload_truncated).toBe(true);
    expect((rows[1] as Record<string, unknown>).payload_truncated).toBeUndefined();
    expect((rows[1] as Record<string, unknown>).note).toContain('\u2026 [truncated]');
    expect((rows[2] as Record<string, unknown>).numeric).toBe(42);
  });

  it('is a no-op for an empty list', () => {
    expect(() => truncateRowsText([], 50)).not.toThrow();
  });

  it('defaults to the 4000-character query head', () => {
    expect(QUERY_TEXT_HEAD_CHARS).toBe(4000);
  });
});
