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

/**
 * Shape check for an egress allowlist/denylist entry, matching what the public
 * agent settings API accepts: a hostname, or a `*.suffix`/`.suffix` wildcard
 * that still names at least two labels. Rejects the bare wildcard, schemes,
 * paths, ports, and anything else that would silently widen egress (a
 * comma-joined `"a.com, b.com"` is one bogus host, not two grants).
 *
 * Lives here beside {@link normalizeDomainPattern} so every producer of a
 * pattern validates it the same way — patterns reach the proxy from operator
 * settings AND from connector declarations.
 */
export function isValidDomainPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string") return false;
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed || trimmed === "*") return false;
  if (trimmed.includes("://") || trimmed.includes("/")) return false;
  // Ports are not part of a host pattern; `[` guards IPv6 literals.
  if (trimmed.includes(":") && !trimmed.includes("[")) return false;
  if (/[\s,]/.test(trimmed)) return false;

  const host = trimmed.startsWith("*.")
    ? trimmed.slice(2)
    : trimmed.startsWith(".")
      ? trimmed.slice(1)
      : trimmed;
  // Compare in punycode, the form patterns are stored and matched in, so an IDN
  // host is judged by the same rule as its ASCII equivalent.
  // Two labels minimum: a wildcard over a TLD (`*.com`) is not a grant anyone
  // can reason about, and a bare label is not a routable host.
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(toAscii(host));
}
