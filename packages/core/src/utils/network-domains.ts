import { domainToASCII } from "node:url";

/**
 * Convert an IDN/Unicode host (or wildcard suffix) to its ASCII/punycode form
 * so stored patterns compare equal to the `xn--` hostnames that `new URL().hostname`
 * (HTTP path) and the canonicalized CONNECT host produce. `domainToASCII`
 * returns "" for inputs it can't convert, in which case we keep the lowercased
 * original so plain-ASCII hosts (and odd inputs) still match.
 */
function toAscii(host: string): string {
  const ascii = domainToASCII(host);
  return ascii !== "" ? ascii : host.toLowerCase();
}

export function normalizeDomainPattern(pattern: string): string {
  const trimmed = pattern.trim();

  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  const normalized = trimmed.toLowerCase();

  if (normalized.startsWith("*.")) {
    return `.${toAscii(normalized.slice(2))}`;
  }

  return toAscii(normalized);
}

export function normalizeDomainPatterns(
  patterns?: string[]
): string[] | undefined {
  if (!patterns) return undefined;

  return [...new Set(patterns.map(normalizeDomainPattern).filter(Boolean))];
}
