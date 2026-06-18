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
import {
  EMBEDDING_CHUNK_CHARS,
  EMBEDDING_CHUNK_OVERLAP_CHARS,
  EMBEDDING_MAX_CHUNKS_PER_EVENT,
  EMBEDDING_MODEL_WINDOW_CHARS,
} from '@lobu/core';

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
  return buf.toString('utf8').replace(/\uFFFD+$/, '');
}

/**
 * Split text into overlapping windows for multi-vector embedding. Returns a
 * single chunk (the whole text) when it fits the model window.
 */
export function chunkForEmbedding(text: string): string[] {
  if (text.length <= EMBEDDING_MODEL_WINDOW_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const atCap = chunks.length === EMBEDDING_MAX_CHUNKS_PER_EVENT - 1;
    let end = atCap ? text.length : Math.min(start + EMBEDDING_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end);
      if (ws > start + EMBEDDING_CHUNK_CHARS / 2) end = ws;
    }
    const piece = text.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(end - EMBEDDING_CHUNK_OVERLAP_CHARS, start + 1);
  }
  return chunks;
}