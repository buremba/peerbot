import { describe, expect, it } from 'vitest';
import { EMBEDDING_MODEL_WINDOW_CHARS } from '@lobu/core';
import { chunkForEmbedding } from '../embeddings-text.js';

describe('chunkForEmbedding', () => {
  it('returns a single chunk for short text', () => {
    const text = 'short memory';
    expect(chunkForEmbedding(text)).toEqual([text]);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const text = `${'word '.repeat(600)}TAIL`;
    const chunks = chunkForEmbedding(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(EMBEDDING_MODEL_WINDOW_CHARS + 200);
    expect(chunks.join(' ')).toContain('TAIL');
  });
});