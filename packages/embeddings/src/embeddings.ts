/**
 * Local embedding generation with @xenova/transformers.
 */

import {
  type FeatureExtractionPipeline,
  pipeline,
  env as transformersEnv,
} from '@xenova/transformers';

const DEFAULT_MODEL_NAME = 'Xenova/bge-base-en-v1.5';
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_DIMENSIONS = 768;

transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE || '~/.cache/huggingface/transformers/';
transformersEnv.backends.onnx.wasm.numThreads = 1;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getModelName(): string {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL_NAME;
}

export function getLocalModelInfo(): { model: string; dimensions: number } {
  return { model: getModelName(), dimensions: DEFAULT_DIMENSIONS };
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    const modelName = getModelName();
    console.log(`[EmbeddingsService] Loading model: ${modelName}...`);
    const startTime = Date.now();

    extractorPromise = pipeline('feature-extraction', modelName, {
      quantized: true,
    });

    const extractor = await extractorPromise;
    const loadTime = Date.now() - startTime;
    console.log(`[EmbeddingsService] Model loaded in ${loadTime}ms`);

    return extractor;
  }

  return extractorPromise;
}

export async function generateLocalEmbedding(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, {
    pooling: 'cls',
    normalize: true,
  });

  return Array.from(output.data) as number[];
}

export async function batchGenerateLocalEmbeddings(
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
