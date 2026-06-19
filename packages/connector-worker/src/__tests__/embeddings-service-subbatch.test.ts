/**
 * Service-request sub-batching (multi-vector regression).
 *
 * The embeddings service rejects a request with more than 256 texts. Under
 * multi-vector chunking one backfill batch fans out to N chunk texts per event,
 * so a 100-event batch can carry ~300 texts — which 400-failed the whole run
 * before this fix. `fetchEmbeddingsFromService` must split into ≤256-entry
 * requests and concatenate results in order.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchGenerateEmbeddings } from '../embeddings.js';

const MODEL = 'Xenova/bge-base-en-v1.5';
const DIM = 768;

function vec(seed: number): number[] {
  // Distinct, valid 768-dim vector whose first slot encodes the input index,
  // so we can assert the concatenated output preserves request order.
  const v = new Array(DIM).fill(0);
  v[0] = seed;
  return v;
}

describe('fetchEmbeddingsFromService sub-batching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EMBEDDINGS_SERVICE_URL;
  });

  it('splits >256 texts into ≤256-entry requests, preserving order', async () => {
    process.env.EMBEDDINGS_SERVICE_URL = 'http://embeddings.local';
    const requestSizes: number[] = [];
    let offset = 0;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const texts: string[] = JSON.parse(init.body).texts;
      requestSizes.push(texts.length);
      const embeddings = texts.map(() => vec(offset++));
      return {
        ok: true,
        json: async () => ({ embeddings, dimensions: DIM, model: MODEL }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const texts = Array.from({ length: 300 }, (_, i) => `text ${i}`);
    const { embeddings, model } = await batchGenerateEmbeddings(texts);

    expect(requestSizes).toEqual([256, 44]); // two slices, not one 300-entry request
    expect(embeddings).toHaveLength(300);
    expect(model).toBe(MODEL);
    // Order preserved across the slice boundary.
    expect(embeddings[0]![0]).toBe(0);
    expect(embeddings[255]![0]).toBe(255);
    expect(embeddings[256]![0]).toBe(256);
    expect(embeddings[299]![0]).toBe(299);
  });

  it('keeps the common path (≤256 texts) a single request', async () => {
    process.env.EMBEDDINGS_SERVICE_URL = 'http://embeddings.local';
    const requestSizes: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const texts: string[] = JSON.parse(init.body).texts;
      requestSizes.push(texts.length);
      return {
        ok: true,
        json: async () => ({ embeddings: texts.map((_, i) => vec(i)), dimensions: DIM, model: MODEL }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const { embeddings } = await batchGenerateEmbeddings(Array.from({ length: 100 }, (_, i) => `t${i}`));
    expect(requestSizes).toEqual([100]);
    expect(embeddings).toHaveLength(100);
  });
});
