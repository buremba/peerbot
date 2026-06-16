/**
 * Pure text-budget helpers for embedding generation.
 *
 * Kept in its own module (separate from `embeddings.ts`) so it can be unit
 * tested in isolation — `embeddings.ts` is module-mocked by the executor tests,
 * and bun's `mock.module` is process-global, so this logic would otherwise be
 * unreachable in those test runs.
 */

/**
 * The embeddings service rejects any single text larger than 32 KiB
 * (`MAX_TEXT_BYTES` in @lobu/embeddings's `server.ts`) with HTTP 400. A batch
 * containing even one oversized text fails wholesale, and because the executor
 * swallowed that error and still marked the run completed, the offending batch
 * never got embedded and re-failed forever (re-queued oldest-first). Long
 * reddit/forum post bodies routinely exceed this.
 *
 * The embedding model has a fixed max sequence length (~512 tokens), so content
 * past the first few KB contributes nothing to the vector anyway — the local
 * backend silently truncates. Clamping to this budget is therefore lossless for
 * the vector while keeping the service path from tripping the size guard. Kept
 * a hair under 32 KiB to leave headroom for the server-side `.trim()`.
 */
export const MAX_EMBEDDING_TEXT_BYTES = 32 * 1024 - 256;

/**
 * Truncate `text` so its UTF-8 byte length is at most `maxBytes`, without
 * splitting a multi-byte code point. Returns the original string when it
 * already fits.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // toString('utf8') replaces a trailing partial code point with U+FFFD;
  // strip it so we never emit a replacement char.
  return buf.toString('utf8').replace(/�+$/, '');
}
