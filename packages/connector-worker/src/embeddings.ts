/**
 * Embedding Generation (local or remote)
 *
 * If EMBEDDINGS_SERVICE_URL is set, calls the HTTP embeddings service.
 * Otherwise, uses @lobu/embeddings local pipeline (@xenova/transformers).
 */

import {
  DEFAULT_DIMENSIONS,
  batchGenerateLocalEmbeddings,
  validateEmbeddingDimensions,
} from '@lobu/embeddings';

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30000;

function getExpectedDimensions(): number {
  const raw = process.env.EMBEDDINGS_DIMENSIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_DIMENSIONS;
  return Number.isFinite(parsed) ? parsed : DEFAULT_DIMENSIONS;
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.EMBEDDINGS_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
}

async function fetchEmbeddingsFromService(texts: string[]): Promise<number[][]> {
  const baseUrl = process.env.EMBEDDINGS_SERVICE_URL;
  if (!baseUrl) {
    throw new Error('EMBEDDINGS_SERVICE_URL is required for service backend');
  }

  const url = baseUrl.replace(/\/+$/, '');
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (process.env.EMBEDDINGS_SERVICE_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EMBEDDINGS_SERVICE_TOKEN}`;
    }

    const response = await fetch(`${url}/api/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Embeddings service error (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      embeddings?: number[][];
      dimensions?: number;
    };

    if (!Array.isArray(payload.embeddings)) {
      throw new Error('Embeddings service response missing embeddings array');
    }

    if (payload.embeddings.length !== texts.length) {
      throw new Error(
        `Embeddings service returned ${payload.embeddings.length} embeddings for ${texts.length} texts`
      );
    }

    if (payload.dimensions && payload.dimensions !== getExpectedDimensions()) {
      throw new Error(
        `Embeddings service returned ${payload.dimensions} dimensions (expected ${getExpectedDimensions()})`
      );
    }

    for (const embedding of payload.embeddings) {
      validateEmbeddingDimensions(embedding, getExpectedDimensions(), 'Embeddings service');
    }

    return payload.embeddings;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await batchGenerateEmbeddings([text]);
  return embedding;
}

export async function batchGenerateEmbeddings(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  if (process.env.EMBEDDINGS_SERVICE_URL) {
    return fetchEmbeddingsFromService(texts);
  }

  const embeddings = await batchGenerateLocalEmbeddings(texts, batchSize);
  for (const embedding of embeddings) {
    validateEmbeddingDimensions(embedding, getExpectedDimensions(), 'Local embeddings');
  }
  return embeddings;
}
