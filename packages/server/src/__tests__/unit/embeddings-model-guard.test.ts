/**
 * Finding #3 (server-side guard): the query embedding the search path compares
 * against stored rows MUST come from the configured model. If the embeddings
 * service reports a different model, generateEmbeddings must FAIL LOUD rather
 * than returning vectors that would be compared across incompatible spaces.
 *
 * Also covers configuredEmbeddingModelSqlLiteral's validation (it is inlined
 * into SQL, so an unsafe value must be rejected).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  configuredEmbeddingModelSqlLiteral,
  generateEmbeddings,
  getConfiguredEmbeddingModel,
} from '../../utils/embeddings';

// biome-ignore lint/suspicious/noExplicitAny: minimal Env stub for the util
const ENV = { EMBEDDINGS_SERVICE_URL: 'http://embeddings.test' } as any;

let originalFetch: typeof globalThis.fetch;
let originalModel: string | undefined;

function stubFetch(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;
}

function vec768(): number[] {
  const v = new Array(768).fill(0);
  v[0] = 1;
  return v;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalModel = process.env.EMBEDDINGS_MODEL;
  process.env.EMBEDDINGS_MODEL = 'Xenova/bge-base-en-v1.5';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalModel === undefined) delete process.env.EMBEDDINGS_MODEL;
  else process.env.EMBEDDINGS_MODEL = originalModel;
});

describe('server generateEmbeddings model guard (Finding #3)', () => {
  it('rejects a service model that differs from the configured model', async () => {
    stubFetch({ model: 'some-other-model-v2', dimensions: 768, embeddings: [vec768()] });
    await expect(generateEmbeddings(['hi'], ENV)).rejects.toThrow(
      /returned model 'some-other-model-v2' but this deployment is configured/
    );
  });

  it('accepts a matching service model', async () => {
    stubFetch({ model: getConfiguredEmbeddingModel(), dimensions: 768, embeddings: [vec768()] });
    const out = await generateEmbeddings(['hi'], ENV);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(768);
  });

  it('accepts a response that omits the model (backward compatible)', async () => {
    stubFetch({ dimensions: 768, embeddings: [vec768()] });
    const out = await generateEmbeddings(['hi'], ENV);
    expect(out).toHaveLength(1);
  });
});

describe('configuredEmbeddingModelSqlLiteral', () => {
  it('quotes a valid model name', () => {
    process.env.EMBEDDINGS_MODEL = 'Xenova/bge-base-en-v1.5';
    expect(configuredEmbeddingModelSqlLiteral()).toBe("'Xenova/bge-base-en-v1.5'");
  });

  it('rejects an unsafe model identifier (SQL-injection / whitespace)', () => {
    process.env.EMBEDDINGS_MODEL = "x'; DROP TABLE event_embeddings; --";
    expect(() => configuredEmbeddingModelSqlLiteral()).toThrow(/not a valid model identifier/);
  });
});
