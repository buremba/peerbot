/**
 * Reproducer: the embeddings service rejects any single text > 32 KiB
 * (`MAX_TEXT_BYTES` in @lobu/embeddings's server.ts) with HTTP 400, which
 * fails the WHOLE batch. The executor swallowed that error and still marked
 * the run completed, so batches containing a long post body (common on
 * reddit/forum sources — lobu-crm had reddit posts up to ~75 KB) never got
 * embedded and re-failed forever.
 *
 * `batchGenerateEmbeddings` now clamps every text to the service's byte budget
 * before sending (via `truncateToBytes`), so an oversized item can never 400
 * the batch. The model truncates to its max sequence length anyway, so the
 * resulting vector is unchanged.
 *
 * Tested against the pure `truncateToBytes` helper in its own module so the
 * assertions are immune to the process-global `mock.module('../embeddings.js')`
 * used by the sibling executor tests.
 */

import { describe, expect, test } from 'bun:test';
import { MAX_EMBEDDING_TEXT_BYTES, truncateToBytes } from '../embeddings-text.js';

const SERVICE_LIMIT = 32 * 1024;

describe('truncateToBytes (embed oversized-text clamp)', () => {
  test('clamps a ~75KB text under the service byte budget', () => {
    const huge = 'x'.repeat(75_000); // mirrors a long reddit post body
    const out = truncateToBytes(huge, MAX_EMBEDDING_TEXT_BYTES);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_EMBEDDING_TEXT_BYTES);
    // and stays under the real service limit it was failing on
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(SERVICE_LIMIT);
  });

  test('leaves an already-small text untouched', () => {
    expect(truncateToBytes('hello world', MAX_EMBEDDING_TEXT_BYTES)).toBe('hello world');
  });

  test('never splits a multi-byte code point (no U+FFFD)', () => {
    // 'é' is 2 bytes in UTF-8; force a cut on an odd boundary.
    const multi = 'é'.repeat(1000);
    const out = truncateToBytes(multi, 9); // 9 bytes = 4.5 chars → must round down
    expect(out).not.toContain('�');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(9);
    expect(out).toBe('éééé'); // 8 bytes
  });

  test('the configured budget stays under the service limit', () => {
    expect(MAX_EMBEDDING_TEXT_BYTES).toBeLessThan(SERVICE_LIMIT);
  });
});
