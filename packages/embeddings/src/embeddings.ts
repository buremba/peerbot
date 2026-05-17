import {
  type FeatureExtractionPipeline,
  pipeline,
  env as transformersEnv,
} from '@xenova/transformers';

const DEFAULT_MODEL_NAME = 'Xenova/bge-base-en-v1.5';
export const DEFAULT_DIMENSIONS = 768;
const DEFAULT_BATCH_SIZE = 32;

transformersEnv.cacheDir = process.env.TRANSFORMERS_CACHE || '~/.cache/huggingface/transformers/';
transformersEnv.backends.onnx.wasm.numThreads = 1;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getModelName(): string {
  return process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL_NAME;
}

export function getLocalModelName(): string {
  return getModelName();
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) {
    return extractorPromise;
  }

  const modelName = getModelName();
  console.log(`[EmbeddingsService] Loading model: ${modelName}...`);
  const startTime = Date.now();

  // Don't cache a rejected promise — a transient model-load failure would
  // otherwise permanently brick the embeddings backend until process restart.
  extractorPromise = pipeline('feature-extraction', modelName, {
    quantized: true,
  }).catch((err) => {
    extractorPromise = null;
    throw err;
  });

  const extractor = await extractorPromise;
  console.log(`[EmbeddingsService] Model loaded in ${Date.now() - startTime}ms`);
  return extractor;
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
    // Pass the whole batch as an array — transformers.js runs a single padded,
    // vectorized ONNX forward pass instead of N separate ones.
    const output = await extractor(batch, {
      pooling: 'cls',
      normalize: true,
    });

    const flat = output.data as Float32Array | number[];
    const dims = (output as { dims?: number[] }).dims;
    const dim =
      dims && dims.length >= 2 ? dims[dims.length - 1]! : flat.length / batch.length;
    for (let row = 0; row < batch.length; row++) {
      results.push(Array.from(flat.slice(row * dim, (row + 1) * dim)) as number[]);
    }
  }

  return results;
}
