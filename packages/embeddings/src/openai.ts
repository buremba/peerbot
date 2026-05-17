import { normalizeEmbeddings, validateEmbeddingDimensions } from './embedding-utils.js';

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

/**
 * Thrown when the upstream OpenAI-compatible API returns a non-2xx response.
 * Carries the upstream HTTP status so callers can map it appropriately.
 */
export class OpenAIEmbeddingsHTTPError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OpenAIEmbeddingsHTTPError';
    this.status = status;
  }
}

/**
 * Thrown when the local AbortController fires before the upstream response,
 * so the HTTP layer can map it to 504 Gateway Timeout.
 */
export class OpenAIEmbeddingsTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`OpenAI embeddings request timed out after ${timeoutMs}ms`);
    this.name = 'OpenAIEmbeddingsTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Strip anything that looks like an API key / bearer token from an upstream
 * error body before it leaves the process. Some "OpenAI-compatible" endpoints
 * echo the Authorization header in error payloads.
 */
function sanitizeUpstreamError(text: string, apiKey: string): string {
  let cleaned = text;
  if (apiKey) {
    cleaned = cleaned.split(apiKey).join('[redacted]');
  }
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
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  let response: Response;
  try {
    response = await fetch(config.apiUrl, {
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
  } catch (err) {
    if (timedOut) {
      throw new OpenAIEmbeddingsTimeoutError(config.timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // A truncated/aborted upstream may make response.text() throw; still emit
    // a typed error with the status.
    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      errorText = '<unreadable response body>';
    }
    throw new OpenAIEmbeddingsHTTPError(
      response.status,
      `OpenAI embeddings error (${response.status}): ${sanitizeUpstreamError(errorText, config.apiKey)}`
    );
  }

  let payload: OpenAIEmbeddingResponse;
  try {
    payload = (await response.json()) as OpenAIEmbeddingResponse;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI embeddings response was not valid JSON: ${detail}`);
  }

  if (!Array.isArray(payload.data)) {
    throw new Error('OpenAI embeddings response missing data array');
  }

  if (payload.data.length !== config.texts.length) {
    throw new Error(
      `OpenAI embeddings response returned ${payload.data.length} embeddings for ${config.texts.length} texts`
    );
  }

  // OpenAI does not guarantee response ordering — items carry an `index` field
  // so callers can reorder. Reorder before returning to keep vectors aligned.
  const embeddings: number[][] = new Array(payload.data.length);
  for (const item of payload.data) {
    if (
      typeof item?.index !== 'number' ||
      item.index < 0 ||
      item.index >= embeddings.length ||
      !Array.isArray(item.embedding)
    ) {
      throw new Error('OpenAI embeddings response item missing index/embedding');
    }
    if (embeddings[item.index] !== undefined) {
      throw new Error(`OpenAI embeddings response has duplicate index ${item.index}`);
    }
    embeddings[item.index] = item.embedding;
  }

  for (const embedding of embeddings) {
    validateEmbeddingDimensions(embedding, config.expectedDimensions, 'OpenAI embeddings response');
  }

  return config.normalize ? normalizeEmbeddings(embeddings) : embeddings;
}
