/**
 * Strip anything that looks like an API key / bearer token from text before it
 * leaves the process. Shared by the OpenAI client (sanitizing upstream error
 * payloads) and the HTTP server (defense-in-depth scrub on outbound error
 * messages). Accepts an optional explicit secret list — typically the API key
 * and service token currently in process env — which is matched literally
 * before the generic patterns run.
 */
export function scrubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let cleaned = text;
  for (const secret of knownSecrets) {
    if (secret) cleaned = cleaned.split(secret).join('[redacted]');
  }
  return cleaned
    .replace(/\b(sk|sk-proj|rk|pk|api[_-]?key)[-_][A-Za-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._-]+/gi, 'bearer [redacted]');
}

export function normalizeEmbeddings(embeddings: number[][]): number[][] {
  return embeddings.map((vec) => {
    const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
    if (norm === 0) {
      return vec;
    }
    return vec.map((x) => x / norm);
  });
}

export function validateEmbeddingDimensions(
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
