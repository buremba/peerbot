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
 * Shape check for an egress allowlist/denylist entry: a hostname, or a
 * `*.suffix`/`.suffix` wildcard that still names at least two labels. Rejects
 * the bare wildcard, schemes, paths, ports, IP literals, and anything else that
 * would silently widen egress (a comma-joined `"a.com, b.com"` is one bogus
 * host, not two grants).
 *
 * Stricter than the operator-facing agent settings contract, which types these
 * as plain strings. That asymmetry is deliberate: an operator edits their own
 * agent's allowlist, whereas a connector declaration is authored by a third
 * party and applies org-wide to every agent, so it does not get to name a host
 * an operator would have had to type out deliberately.
 *
 * Lives here beside {@link normalizeDomainPattern} so every producer of a
 * pattern validates it the same way.
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
  const asciiHost = toAscii(host);

  // An IPv4 literal passes the two-label test below (`169.254.169.254` is four
  // labels) but names a network location rather than a service. Cloud metadata
  // endpoints — 169.254.169.254, metadata.google.internal — are the reason: a
  // grant for one hands every agent in the org the instance's credentials.
  // Egress entries must be resolvable names, so IP literals are refused
  // outright rather than the link-local range being special-cased.
  //
  // Dotted-decimal is not the only spelling: `inet_aton` (and therefore curl,
  // git and glibc) also accepts hex/octal labels, so `0x7f.0x1` is 127.0.0.1
  // and `0xa9fe.0xa9fe` is the link-local metadata address. Both forms are
  // checked — the raw pattern and its ASCII form, because `domainToASCII`
  // canonicalizes some of these spellings to dotted-decimal and leaves others
  // alone.
  if (isIpv4Literal(host) || isIpv4Literal(asciiHost)) return false;
  // `.internal`/`.local` are not publicly resolvable; a pattern ending in one
  // only ever names infrastructure the proxy should not be reaching for.
  if (/\.(internal|local|localdomain)$/.test(host)) return false;
  // Two labels minimum: a wildcard over a TLD (`*.com`) is not a grant anyone
  // can reason about, and a bare label is not a routable host.
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(asciiHost);
}

/**
 * True when every label is numeric in one of the radices `inet_aton` accepts, so
 * the host is an IPv4 literal rather than a name. Covers the dotted-decimal
 * form plus the hex spellings (`0x7f.0x1`) that resolvers still honor.
 */
function isIpv4Literal(host: string): boolean {
  return host.split(".").every((label) => /^(\d+|0x[0-9a-f]+)$/.test(label));
}
