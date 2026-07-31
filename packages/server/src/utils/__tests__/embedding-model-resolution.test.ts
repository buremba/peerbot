import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../index';
import {
  DEFAULT_EMBEDDING_MODEL,
  embeddingModelSqlLiteral,
  generateEmbeddings,
  getConfiguredEmbeddingModel,
  needsEmbeddingSql,
  resolveEmbeddingModel,
} from '../embeddings';

const OTHER_MODEL = 'Xenova/multilingual-e5-base';

describe('resolveEmbeddingModel', () => {
  const original = process.env.EMBEDDINGS_MODEL;
  afterEach(() => {
    if (original === undefined) delete process.env.EMBEDDINGS_MODEL;
    else process.env.EMBEDDINGS_MODEL = original;
  });

  it('falls back to the configured model when nothing is requested', () => {
    delete process.env.EMBEDDINGS_MODEL;
    expect(resolveEmbeddingModel()).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(resolveEmbeddingModel(undefined)).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(resolveEmbeddingModel(null)).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  // A caller threading an optional field through can easily hand us '' — that is
  // "not specified", not a model named empty string, which would otherwise
  // produce `embedding_model = ''` and match no rows at all.
  it('treats blank and whitespace-only as unspecified', () => {
    delete process.env.EMBEDDINGS_MODEL;
    expect(resolveEmbeddingModel('')).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(resolveEmbeddingModel('   ')).toBe(DEFAULT_EMBEDDING_MODEL);
  });

  it('honours an explicit override', () => {
    expect(resolveEmbeddingModel(OTHER_MODEL)).toBe(OTHER_MODEL);
  });

  it('an override wins over the configured model', () => {
    process.env.EMBEDDINGS_MODEL = 'Xenova/some-other-thing';
    expect(resolveEmbeddingModel(OTHER_MODEL)).toBe(OTHER_MODEL);
  });

  // The resolved value is inlined into SQL as a literal, so validation is not
  // cosmetic — it is the only thing between a caller-supplied string and the
  // query text.
  it.each([
    ["x' OR '1'='1", 'quote break-out'],
    ['model; DROP TABLE events', 'statement separator'],
    ['-- comment', 'leading dash'],
    ['a'.repeat(200), 'over length'],
  ])('rejects %s (%s)', (bad) => {
    expect(() => resolveEmbeddingModel(bad)).toThrow(/not a valid model identifier/);
  });
});

describe('embeddingModelSqlLiteral', () => {
  it('quotes a valid model', () => {
    expect(embeddingModelSqlLiteral(OTHER_MODEL)).toBe(`'${OTHER_MODEL}'`);
  });

  // Re-validates rather than trusting its caller: this is the last point before
  // the value becomes query text.
  it('rejects an unsafe model even when handed one directly', () => {
    expect(() => embeddingModelSqlLiteral("x' OR '1'='1")).toThrow(/not a valid model identifier/);
  });
});

describe('needsEmbeddingSql', () => {
  it('scopes the staleness predicate to the model it is given', () => {
    const sql = needsEmbeddingSql('e', OTHER_MODEL);
    expect(sql).toContain(`emb.embedding_model = '${OTHER_MODEL}'`);
    expect(sql).toContain('emb.event_id = e.id');
    expect(sql).toContain('emb.chunk_index = 0');
  });

  // Discovery and the worker fetch must fill the SAME space. Different models
  // produce different predicates — if they ever passed different values, the
  // backfill would hand the worker events it considers already done, forever.
  it('produces a different predicate per model', () => {
    expect(needsEmbeddingSql('e', OTHER_MODEL)).not.toBe(
      needsEmbeddingSql('e', getConfiguredEmbeddingModel())
    );
  });
});

/**
 * Stand-in for the embeddings service that reports whichever model it is told to
 * report, so the guard can be exercised in both directions.
 */
async function withService<T>(
  reportModel: (requested: string | undefined) => string,
  run: (env: Env) => Promise<T>
): Promise<T> {
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}') as { texts?: string[]; model?: string };
      seen.push(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          embeddings: (payload.texts ?? []).map(() => new Array<number>(768).fill(0.1)),
          dimensions: 768,
          model: reportModel(payload.model),
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run({
      EMBEDDINGS_SERVICE_URL: `http://127.0.0.1:${port}`,
      __seen: seen,
    } as unknown as Env);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('generateEmbeddings model negotiation', () => {
  it('sends the requested model to the service', async () => {
    await withService(
      (requested) => requested ?? DEFAULT_EMBEDDING_MODEL,
      async (env) => {
        await generateEmbeddings(['hello'], env, OTHER_MODEL);
        const seen = (env as unknown as { __seen: Array<{ model?: string }> }).__seen;
        expect(seen).toHaveLength(1);
        expect(seen[0].model).toBe(OTHER_MODEL);
      }
    );
  });

  it('sends the configured model when none is requested', async () => {
    await withService(
      (requested) => requested ?? DEFAULT_EMBEDDING_MODEL,
      async (env) => {
        await generateEmbeddings(['hello'], env);
        const seen = (env as unknown as { __seen: Array<{ model?: string }> }).__seen;
        expect(seen[0].model).toBe(getConfiguredEmbeddingModel());
      }
    );
  });

  /**
   * The case this guard exists for. The LOCAL backend pins one model per process
   * and ignores `payload.model` entirely, so asking it for a model it does not
   * serve gets you default-model vectors with a 200. Without this check the
   * caller would stamp those vectors as the requested model and poison the very
   * table the stamp exists to keep honest — a silent write, not a failed read.
   */
  it('throws when the service serves a model other than the one requested', async () => {
    await withService(
      () => DEFAULT_EMBEDDING_MODEL,
      async (env) => {
        await expect(generateEmbeddings(['hello'], env, OTHER_MODEL)).rejects.toThrow(
          /returned model .* but .* was requested/
        );
      }
    );
  });

  it('accepts a matching non-default model', async () => {
    await withService(
      () => OTHER_MODEL,
      async (env) => {
        const out = await generateEmbeddings(['hello'], env, OTHER_MODEL);
        expect(out).toHaveLength(1);
        expect(out[0]).toHaveLength(768);
      }
    );
  });

  it('rejects an invalid model before contacting the service', async () => {
    await withService(
      () => DEFAULT_EMBEDDING_MODEL,
      async (env) => {
        await expect(generateEmbeddings(['hello'], env, "x' OR '1'='1")).rejects.toThrow(
          /not a valid model identifier/
        );
        expect((env as unknown as { __seen: unknown[] }).__seen).toHaveLength(0);
      }
    );
  });
});
