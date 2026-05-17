import { normalizeEmbeddings, validateEmbeddingDimensions } from './embedding-utils.js';

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

/**
 * Strip anything that looks like an API key / bearer token from an upstream
 * error body before it leaves the process. Compatible third-party "OpenAI"
 * endpoints occasionally echo the Authorization header value back in their
 * error payload — never let that surface in our logs or HTTP responses.
 */
function sanitizeUpstreamError(text: string, apiKey: string): string {
  let cleaned = text;
  if (apiKey) {
    // Mask exact key matches anywhere in the body.
    cleaned = cleaned.split(apiKey).join('[redacted]');
  }
  // Best-effort masking of common secret shapes (sk-..., bearer tokens,
  // generic 24+ char alnum runs that look like keys).
  cleaned = cleaned
    .replace(/\b(sk|sk-proj|rk|pk|api[_-]?key)[-_][A-Za-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._-]+/gi, 'bearer [redacted]');
  return cleaned.slice(0, 300);
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
      throw new Error(
        `OpenAI embeddings error (${response.status}): ${sanitizeUpstreamError(errorText, config.apiKey)}`
      );
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
