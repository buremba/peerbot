import { normalizeEmbeddings, validateEmbeddingDimensions } from './embedding-utils.js';

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

/**
 * Thrown when the upstream OpenAI-compatible API returns a non-2xx response.
 * Carries the upstream HTTP status so callers can map it to an appropriate
 * downstream status (e.g. 429 → 429, 5xx → 502) instead of collapsing every
 * upstream failure to a generic 500.
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
 * Thrown when the upstream call times out (the local AbortController fires
 * before the response is received). Distinguishable from a client-cancelled
 * abort so the HTTP layer can map it to 504 Gateway Timeout.
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
    // The timeout fires by calling controller.abort(), which surfaces here as
    // an AbortError. Translate to a typed timeout error so the HTTP layer can
    // return 504 instead of mis-reporting it as a generic 500.
    if (timedOut) {
      throw new OpenAIEmbeddingsTimeoutError(config.timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Read the body defensively — a truncated/aborted upstream may make
    // response.text() throw; we still want a typed error with the status.
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

  // Upstream advertised 2xx but may still ship a non-JSON body (HTML error
  // page from a reverse proxy, truncated stream, etc). Guard the parse so we
  // surface a clear error instead of an opaque SyntaxError.
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

  // The OpenAI embeddings API does NOT guarantee response ordering — items
  // carry an `index` field precisely so callers can reorder. Previously we
  // mapped data in arrival order, which silently mis-aligned vectors with
  // their inputs whenever the upstream returned them out of order.
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
      throw new Error(
        `OpenAI embeddings response has duplicate index ${item.index}`
      );
    }
    embeddings[item.index] = item.embedding;
  }
  for (let i = 0; i < embeddings.length; i++) {
    if (embeddings[i] === undefined) {
      throw new Error(`OpenAI embeddings response missing index ${i}`);
    }
  }

  for (const embedding of embeddings) {
    validateEmbeddingDimensions(
      embedding,
      config.expectedDimensions,
      'OpenAI embeddings response'
    );
  }

  return config.normalize ? normalizeEmbeddings(embeddings) : embeddings;
}
