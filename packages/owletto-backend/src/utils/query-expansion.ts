const QUESTION_WORDS = new Set([
  'what',
  'who',
  'where',
  'when',
  'which',
  'why',
  'how',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'at',
  'on',
  'in',
  'after',
  'before',
  'now',
  'current',
  'latest',
  'approved',
  'made',
]);

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function expandSearchQueries(
  prompt: string,
  options?: {
    maxVariants?: number;
  }
): string[] {
  const queries: string[] = [prompt.trim()];

  const properNounMatches = prompt.match(/\b(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3})\b/g) ?? [];
  for (const match of properNounMatches) {
    if (QUESTION_WORDS.has(match.toLowerCase())) continue;
    queries.push(match);
  }

  const lowerTokens = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !QUESTION_WORDS.has(token));

  if (lowerTokens.length > 0) {
    queries.push(lowerTokens.join(' '));
  }

  for (let i = 0; i < lowerTokens.length - 1; i += 1) {
    queries.push(`${lowerTokens[i]} ${lowerTokens[i + 1]}`);
  }

  for (const token of lowerTokens) {
    queries.push(token);
  }

  return dedupe(queries).slice(0, options?.maxVariants ?? 8);
}
