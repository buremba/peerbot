/**
 * Embedding Generation (local or remote)
 *
 * If EMBEDDINGS_SERVICE_URL is set, calls the HTTP embeddings service.
 * Otherwise, uses @xenova/transformers locally.
 */

import {
  type FeatureExtractionPipeline,
  pipeline,
  env as transformersEnv,
} from '@xenova/transformers';

function validateEmbeddingDimensions(
  embedding: number[],
  expectedDimensions: number,
  context: string
): void {
  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `${context}: unexpected embedding dimensions ${embedding.length} (expected ${expectedDimensions})`
    );
  }
}

const DEFAULT_MODEL_NAME = 'Xenova/bge-base-en-v1.5';
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 30000;

transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE || '~/.cache/huggingface/transformers/';
transformersEnv.backends.onnx.wasm.numThreads = 1;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExpectedDimensions(): number {
  const raw = process.env.EMBEDDINGS_DIMENSIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_DIMENSIONS;
  return Number.isFinite(parsed) ? parsed : DEFAULT_DIMENSIONS;
}

function getTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.EMBEDDINGS_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
}

function getModelName(): string {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL_NAME;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    const modelName = getModelName();
    console.log(`[Embeddings] Loading model: ${modelName}...`);
    const startTime = Date.now();

    extractorPromise = pipeline('feature-extraction', modelName, {
      quantized: true,
    });

    const extractor = await extractorPromise;
    const loadTime = Date.now() - startTime;
    console.log(`[Embeddings] Model loaded in ${loadTime}ms`);

    return extractor;
  }

  return extractorPromise;
}

async function batchGenerateLocalEmbeddings(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const extractor = await getExtractor();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchOutputs = await Promise.all(
      batch.map((text) =>
        extractor(text, {
          pooling: 'cls',
          normalize: true,
        })
      )
    );

    const batchEmbeddings = batchOutputs.map((output) => Array.from(output.data) as number[]);
    results.push(...batchEmbeddings);
  }

  return results;
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
