import { describe, expect, it } from 'bun:test';
import {
  BULK_PAYLOAD_TEXT_BYTES,
  clampRowPayloads,
  clampRows,
  exactSinglePayloadBudget,
  type ClampBudget,
} from '../../../../tools/get_content/byte-clamp';

describe('byte-clamp budgets', () => {
  it('bulk budget keeps 4KB head', () => {
    expect(BULK_PAYLOAD_TEXT_BYTES).toBe(4096);
  });

  it('exact single-id budget is the 200KB head', () => {
    expect(exactSinglePayloadBudget(1).bytes).toBe(200_000);
  });

  it('scales the exact budget down as the id count grows, never below the floor', () => {
    // 300KB total / 2 ids = 150KB/row, capped at 200KB.
    expect(exactSinglePayloadBudget(2).bytes).toBe(150_000);
    // 300KB / 25 ids = 12KB, floored up to 16KB.
    expect(exactSinglePayloadBudget(25).bytes).toBe(16_384);
    // A single id never exceeds 200KB even though 300KB/1 would be 300KB.
    expect(exactSinglePayloadBudget(1).bytes).toBe(200_000);
  });
});

describe('clampRowPayloads', () => {
  const budget: ClampBudget = { bytes: 100 };

  it('leaves a row that fits the budget untouched', () => {
    const row = { payload_text: 'short', payload_data: { a: 1 } };
    clampRowPayloads(row, budget);
    expect(row).toEqual({ payload_text: 'short', payload_data: { a: 1 } });
    expect(row.payload_truncated).toBeUndefined();
    expect(row.content_length).toBeUndefined();
  });

  it('clamps oversized payload_text and marks the row', () => {
    const text = 'x'.repeat(5000);
    const row = { payload_text: text, text_content: text };
    clampRowPayloads(row, budget);
    expect(row.payload_truncated).toBe(true);
    // content_length is the FULL original character count, not the head.
    expect(row.content_length).toBe(5000);
    expect(typeof row.payload_text).toBe('string');
    expect((row.payload_text as string).endsWith('\u2026 [truncated]')).toBe(true);
    expect((row.payload_text as string).length).toBeLessThan(200);
    expect(row.text_content).toBe(row.payload_text);
  });

  it('clamps to a byte budget without splitting multi-byte characters', () => {
    // A CJK character is 3 UTF-8 bytes; a budget of 100 must not cut one in half.
    const emoji = '😀'.repeat(400); // 4 bytes each = 1600 bytes
    const row = { payload_text: emoji };
    clampRowPayloads(row, budget);
    const head = row.payload_text as string;
    // Remove the suffix and confirm the remaining head is valid UTF-8 (no lone surrogates).
    const bare = head.replace(/\u2026 \[truncated\]$/, '');
    expect(() => Buffer.from(bare, 'utf8').toString('utf8')).not.toThrow();
    expect(Buffer.byteLength(bare, 'utf8')).toBeLessThanOrEqual(100);
	// content_length counts code points (Postgres-style chars), not UTF-16 units.
	expect(row.content_length).toBe([...emoji].length); // 400 code points
  });

  it('replaces oversized payload_data with a marker', () => {
    const bigData = { blobs: 'y'.repeat(10_000) };
    const row = { payload_text: 'small', payload_data: bigData };
    clampRowPayloads(row, budget);
    expect(row.payload_data).toEqual({ _truncated: true, bytes: expect.any(Number) });
    expect(row.payload_truncated).toBe(true);
    // A payload_text that fits is not clobbered just because payload_data grew.
    expect(row.payload_text).toBe('small');
  });

  it('clamps a bare text_content row (custom SQL projection) via the text_content fallback', () => {
    const row = { text_content: 'z'.repeat(5000) };
    clampRowPayloads(row, budget);
    expect(row.payload_truncated).toBe(true);
    expect(row.content_length).toBe(5000);
  });
});

describe('clampRows', () => {
  it('clamps object rows and skips non-object values', () => {
    const rows = [{ payload_text: 'x'.repeat(5000) }, 'scalar', 42];
    clampRows(rows, { bytes: 100 });
    expect((rows[0] as Record<string, unknown>).payload_truncated).toBe(true);
    expect(rows[1]).toBe('scalar');
    expect(rows[2]).toBe(42);
  });

  it('is a no-op for an empty list', () => {
    expect(() => clampRows([], { bytes: 100 })).not.toThrow();
  });
});
