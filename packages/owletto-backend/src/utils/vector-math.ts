export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function combineEmbeddings(
  child: number[],
  parent: number[],
  childWeight: number,
  parentWeight: number
): number[] {
  const result = new Array(child.length);
  for (let i = 0; i < child.length; i++) {
    result[i] = child[i] * childWeight + parent[i] * parentWeight;
  }
  return result;
}

export function roundTo4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
