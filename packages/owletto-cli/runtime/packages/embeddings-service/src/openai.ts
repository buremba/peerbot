import { normalizeEmbeddings, validateEmbeddingDimensions } from './embedding-utils';

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

export async function generateOpenAIEmbeddings(config: {
  texts: string[];
  apiUrl: string;
  apiKey: string;
  model: string;
  expectedDimensions: number;
  normalize: boolean;
  timeoutMs: number;
}): Promise<number[][]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: config.texts,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI embeddings error (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const payload = (await response.json()) as OpenAIEmbeddingResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error('OpenAI embeddings response missing data array');
    }

    const embeddings = payload.data.map((item) => item.embedding);
    if (embeddings.length !== config.texts.length) {
      throw new Error(
        `OpenAI embeddings response returned ${embeddings.length} embeddings for ${config.texts.length} texts`
      );
    }
    for (const embedding of embeddings) {
      validateEmbeddingDimensions(
        embedding,
        config.expectedDimensions,
        'OpenAI embeddings response'
      );
    }

    return config.normalize ? normalizeEmbeddings(embeddings) : embeddings;
  } finally {
    clearTimeout(timeout);
  }
}
