import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { validateEmbeddingDimensions } from './embedding-utils';
import {
  batchGenerateLocalEmbeddings,
  generateLocalEmbedding,
  getLocalModelInfo,
} from './embeddings';
import { generateOpenAIEmbeddings } from './openai';

interface EmbeddingRequest {
  texts?: unknown;
  model?: string;
}

const DEFAULT_PORT = 8790;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 32;

const app = new Hono();

function resolveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTexts(payload: EmbeddingRequest): { texts: string[] } | { error: string } {
  if (!Array.isArray(payload.texts)) {
    return { error: 'texts must be an array of strings' };
  }

  const texts: string[] = [];
  for (const value of payload.texts) {
    if (typeof value !== 'string') {
      return { error: 'texts must be an array of strings' };
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return { error: 'texts cannot contain empty strings' };
    }
    texts.push(trimmed);
  }

  if (texts.length === 0) {
    return { error: 'texts cannot be empty' };
  }

  return { texts };
}

function requireAuth(request: Request): string | null {
  const token = process.env.EMBEDDINGS_SERVICE_TOKEN;
  if (!token) {
    return null;
  }

  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== token) {
    return 'Unauthorized';
  }

  return null;
}

app.get('/health', (c) => {
  const backend = (process.env.EMBEDDINGS_BACKEND || 'local').toLowerCase();
  const model = backend === 'openai' ? process.env.EMBEDDINGS_MODEL : getLocalModelInfo().model;
  return c.json({ ok: true, backend, model });
});

app.post('/api/embeddings', async (c) => {
  const authError = requireAuth(c.req.raw);
  if (authError) {
    return c.json({ error: authError }, 401);
  }

  let payload: EmbeddingRequest;
  try {
    payload = (await c.req.json()) as EmbeddingRequest;
  } catch (_error) {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const parsed = parseTexts(payload);
  if ('error' in parsed) {
    return c.json({ error: parsed.error }, 400);
  }

  const backend = (process.env.EMBEDDINGS_BACKEND || 'local').toLowerCase();
  const expectedDimensions = resolveNumber(process.env.EMBEDDINGS_DIMENSIONS, DEFAULT_DIMENSIONS);
  const timeoutMs = resolveNumber(process.env.EMBEDDINGS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const normalize = process.env.EMBEDDINGS_NORMALIZE !== 'false';

  try {
    if (backend === 'openai') {
      const apiKey = process.env.EMBEDDINGS_API_KEY;
      if (!apiKey) {
        return c.json({ error: 'EMBEDDINGS_API_KEY is required for openai backend' }, 500);
      }

      const apiUrl = process.env.EMBEDDINGS_API_URL || 'https://api.openai.com/v1/embeddings';
      const model = payload.model || process.env.EMBEDDINGS_MODEL;
      if (!model) {
        return c.json({ error: 'EMBEDDINGS_MODEL is required for openai backend' }, 500);
      }

      const embeddings = await generateOpenAIEmbeddings({
        texts: parsed.texts,
        apiUrl,
        apiKey,
        model,
        expectedDimensions,
        normalize,
        timeoutMs,
      });

      return c.json({
        model,
        dimensions: expectedDimensions,
        embeddings,
      });
    }

    const batchSize = resolveNumber(process.env.EMBEDDINGS_BATCH_SIZE, DEFAULT_BATCH_SIZE);

    const embeddings =
      parsed.texts.length === 1
        ? [await generateLocalEmbedding(parsed.texts[0])]
        : await batchGenerateLocalEmbeddings(parsed.texts, batchSize);

    for (const embedding of embeddings) {
      validateEmbeddingDimensions(embedding, expectedDimensions, 'Local embeddings response');
    }

    const model = getLocalModelInfo().model;
    return c.json({
      model,
      dimensions: expectedDimensions,
      embeddings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Embedding generation failed';
    console.error('[EmbeddingsService] Error:', message);
    return c.json({ error: message }, 500);
  }
});

const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);

serve({
  fetch: app.fetch,
  port,
});

console.log(`[EmbeddingsService] Listening on port ${port}`);
