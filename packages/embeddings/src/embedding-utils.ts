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
