import { timingSafeEqual } from 'node:crypto';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { validateEmbeddingDimensions } from './embedding-utils.js';
import {
  batchGenerateLocalEmbeddings,
  generateLocalEmbedding,
  getLocalModelInfo,
} from './embeddings.js';
import { generateOpenAIEmbeddings } from './openai.js';

interface EmbeddingRequest {
  texts?: unknown;
  model?: string;
}

const DEFAULT_PORT = 8790;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 32;
// Hard DoS limits. The local backend pads the batch to the longest input and
// runs a single ONNX forward pass — one giant string can blow up memory; many
// strings drive proportional wall-clock + cost (OpenAI backend).
const MAX_TEXTS_PER_REQUEST = 256;
const MAX_TEXT_BYTES = 32 * 1024;
// Conservative allowlist for model identifiers we accept from a client.
// Matches the shape of every real OpenAI / Anthropic / together / cohere
// embedding model name, and rejects anything with whitespace, slashes that
// look like paths, or shell metacharacters that have no business in a model
// id even though the API call itself wouldn't interpret them.
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

const app = new Hono();

function resolveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scrubSecrets(message: string): string {
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const serviceToken = process.env.EMBEDDINGS_SERVICE_TOKEN;
  let cleaned = message;
  if (apiKey) {
    cleaned = cleaned.split(apiKey).join('[redacted]');
  }
  if (serviceToken) {
    cleaned = cleaned.split(serviceToken).join('[redacted]');
  }
  return cleaned
    .replace(/\b(sk|sk-proj|rk|pk|api[_-]?key)[-_][A-Za-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._-]+/gi, 'bearer [redacted]');
}

function parseTexts(payload: EmbeddingRequest): { texts: string[] } | { error: string } {
  if (!Array.isArray(payload.texts)) {
    return { error: 'texts must be an array of strings' };
  }

  if (payload.texts.length > MAX_TEXTS_PER_REQUEST) {
    return { error: `texts cannot contain more than ${MAX_TEXTS_PER_REQUEST} entries` };
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
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_TEXT_BYTES) {
      return { error: `each text must be at most ${MAX_TEXT_BYTES} bytes` };
    }
    texts.push(trimmed);
  }

  if (texts.length === 0) {
    return { error: 'texts cannot be empty' };
  }

  return { texts };
}

// Constant-time bearer-token compare. `!==` leaks token length / prefix via
// timing on each request; `timingSafeEqual` requires equal-length buffers, so
// reject mismatched lengths up front (length itself is not secret here).
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function requireAuth(request: Request): string | null {
  const token = process.env.EMBEDDINGS_SERVICE_TOKEN;
  if (!token) {
    return null;
  }

  const header = request.headers.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !tokensMatch(match[1]!, token)) {
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
      // Reject client-controlled model strings that smuggle control chars,
      // whitespace, or path segments. The env-var fallback bypasses this on
      // purpose — operator-controlled values are trusted.
      if (payload.model && !MODEL_NAME_PATTERN.test(payload.model)) {
        return c.json({ error: 'invalid model identifier' }, 400);
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
    const rawMessage = error instanceof Error ? error.message : 'Embedding generation failed';
    // Defense in depth: even if an upstream/library error message slipped a
    // key-shaped string through, scrub before logging or returning.
    const message = scrubSecrets(rawMessage);
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
