/**
 * Canonical IP-literal classifier shared by every Lobu egress guard.
 *
 * Three call sites need the same answer to "is this host an internal
 * address?", and each layers its own policy on top of this one classifier:
 *
 *  - `packages/server/src/gateway/proxy/ssrf-guard.ts` — transport layer:
 *    resolves DNS and pins the socket to a validated answer.
 *  - `packages/connectors/src/db-egress-guard.ts` — policy layer:
 *    `allow-private` (self-hosted) vs `block-private` (untrusted cloud),
 *    plus operator allowlists and forced TLS.
 *  - `./url-guards.ts` — connector-authored URL check, applied at the
 *    trust boundary before a connector fetches an operator-supplied URL.
 *
 * Keeping the classifier here rather than in each consumer is deliberate:
 * `@lobu/connector-sdk` is the only package all three can import (the server
 * package is not reachable from a bundled connector, and `@lobu/core` pulls
 * OpenTelemetry, Sentry, and winston, which connectors intentionally avoid).
 *
 * The matcher collapses the spellings an attacker can use to dress up an
 * internal address so `net.BlockList` won't recognise it: IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` / `::ffff:7f00:1`), IPv4-compatible IPv6 (`::7f00:1`),
 * the NAT64 well-known prefix (`64:ff9b::/96`), zone IDs (`fe80::1%eth0`), and
 * the `0.0.0.0/8` / `::` unspecified ranges. Anything that looks like an IP but
 * will not parse fails closed.
 *
 * This is the UNION of the two classifiers it replaces, not either one: the
 * database guard unwrapped IPv4-compatible IPv6 and the gateway guard did not,
 * so `::a9fe:a9fe` (cloud metadata) reached the gateway unblocked. Consolidating
 * on the stricter copy closes that gap for every consumer at once.
 */

import net from 'node:net';

/**
 * Reserved (non-publicly-routable) IPv4 ranges.
 *
 * This is also exactly the `block-private` set the database egress guard
 * enforces — the two were maintained as identical copies before this module
 * existed, so consumers share one list rather than drifting apart.
 */
const RESERVED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // unspecified / "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + 255.255.255.255 broadcast
];

/** Reserved (non-publicly-routable) IPv6 ranges. */
const RESERVED_IPV6_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['fc00::', 7], // unique local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

/** Pack two 16-bit hextets into the dotted-quad IPv4 they encode. */
function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Whether `address` falls inside `base/prefix`.
 *
 * An unparseable address matches every prefix. That is deliberate: every
 * caller uses a match to mean "blocked", so a malformed value fails closed.
 */
export function matchesIpv4Prefix(
  address: string,
  base: string,
  prefix: number,
): boolean {
  const addressValue = ipv4ToNumber(address);
  const baseValue = ipv4ToNumber(base);
  if (addressValue === undefined || baseValue === undefined) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

/** Expand a valid (net.isIP===6) IPv6 string into 8 unsigned 16-bit hextets. */
function expandIpv6ToHextets(addr: string): number[] {
  const lower = addr.toLowerCase();
  let hexPart = lower;
  let ipv4Suffix: number[] = [];
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx !== -1) {
    const colonBeforeDot = lower.lastIndexOf(':', dotIdx);
    const dotted = lower.slice(colonBeforeDot + 1);
    hexPart = lower.slice(0, colonBeforeDot + 1);
    const octets = dotted.split('.').map((o) => Number.parseInt(o, 10));
    ipv4Suffix = [
      (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)) >>> 0,
      (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0,
    ];
    if (hexPart.endsWith(':') && !hexPart.endsWith('::')) {
      hexPart = hexPart.slice(0, -1);
    }
  }
  const halves = hexPart.split('::');
  const left = halves[0]
    ? halves[0].split(':').map((h) => Number.parseInt(h, 16))
    : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(':').map((h) => Number.parseInt(h, 16))
      : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

function ipv6ToBigInt(address: string): bigint {
  return expandIpv6ToHextets(address).reduce(
    (acc, hextet) => (acc << 16n) | BigInt(hextet),
    0n,
  );
}

/** Whether `address` falls inside the IPv6 network `base/prefix`. */
export function matchesIpv6Prefix(
  address: string,
  base: string,
  prefix: number,
): boolean {
  const shift = 128n - BigInt(prefix);
  return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift;
}

/**
 * Result of running a host literal through {@link normalizeIpLiteral}.
 *  - `ipv4`     — the value is (or decodes to) a bare IPv4 address.
 *  - `ipv6`     — a genuine IPv6 address that doesn't embed an IPv4.
 *  - `not-ip`   — not an IP literal at all (a DNS name); caller should resolve.
 *  - `invalid`  — looks like an IP literal but doesn't cleanly parse → reject.
 */
export type NormalizedHost =
  | { kind: 'ipv4'; value: string }
  | { kind: 'ipv6'; value: string }
  | { kind: 'not-ip' }
  | { kind: 'invalid' };

/**
 * Collapse an IP literal to its canonical IPv4/IPv6 form (or not-ip/invalid).
 *
 * Single funnel for every host literal that reaches a blocklist check —
 * resolved DNS results and CONNECT/forward targets alike. Collapses the
 * forms an attacker can use to dress up an internal address as something
 * `net.BlockList` won't recognise:
 *   - IPv4-mapped IPv6, dotted (`::ffff:127.0.0.1`) and hex (`::ffff:7f00:1`)
 *   - NAT64 well-known prefix `64:ff9b::/96` (last 32 bits are an IPv4)
 *   - zone IDs (`fe80::1%eth0` → strip `%eth0`)
 *   - compressed / uppercase forms (handled by `net.isIP`)
 * Anything that looks like an IP but doesn't parse returns `invalid` so the
 * caller fails closed rather than falling through to a DNS lookup.
 */
export function normalizeIpLiteral(host: string): NormalizedHost {
  const zoneSplit = host.indexOf('%');
  const bare = (zoneSplit === -1 ? host : host.slice(0, zoneSplit)).trim();
  if (bare.length === 0) {
    return zoneSplit === -1 ? { kind: 'not-ip' } : { kind: 'invalid' };
  }

  const family = net.isIP(bare);
  if (family === 4) return { kind: 'ipv4', value: bare };
  if (family === 0) {
    return bare.includes(':') ? { kind: 'invalid' } : { kind: 'not-ip' };
  }

  const lower = bare.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (mapped.includes('.')) {
      return net.isIP(mapped) === 4
        ? { kind: 'ipv4', value: mapped }
        : { kind: 'invalid' };
    }
    const parts = mapped.split(':');
    if (parts.length !== 2) return { kind: 'invalid' };
    const high = Number.parseInt(parts[0] || '', 16);
    const low = Number.parseInt(parts[1] || '', 16);
    if (
      !Number.isInteger(high) ||
      !Number.isInteger(low) ||
      high < 0 ||
      high > 0xffff ||
      low < 0 ||
      low > 0xffff
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'ipv4', value: hextetsToIpv4(high, low) };
  }

  const hextets = expandIpv6ToHextets(bare);
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    return { kind: 'ipv4', value: hextetsToIpv4(hextets[6] ?? 0, hextets[7] ?? 0) };
  }

  // IPv4-compatible IPv6 (`::a.b.c.d`, e.g. `::7f00:1` = 127.0.0.1): the first 96
  // bits are zero with a non-trivial v4 suffix. Unwrap so the v4 blocklist
  // applies — otherwise swapping `::ffff:` for `::` evades the guard. `::` and
  // `::1` keep their explicit blocklist entries (suffix 0 or 1).
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0 &&
    (hextets[6] !== 0 || (hextets[7] ?? 0) > 1)
  ) {
    return { kind: 'ipv4', value: hextetsToIpv4(hextets[6] ?? 0, hextets[7] ?? 0) };
  }

  return { kind: 'ipv6', value: bare };
}

/**
 * Strip surrounding brackets from an IPv6 literal so `net.isIP()` can
 * recognise it. WHATWG URL parsing returns `parsedUrl.hostname` with
 * brackets for IPv6 (e.g. `[::1]`), and `net.isIP("[::1]")` returns 0,
 * which would cause the IP-blocklist check to be skipped and the value
 * to fall through to a DNS lookup — bypassing the loopback/private-IP
 * guards. Normalising to the bare address closes that hole.
 */
export function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/** Whether a canonical IPv4 address is in a reserved range. */
export function isReservedIpv4(address: string): boolean {
  return RESERVED_IPV4_RANGES.some(([base, prefix]) =>
    matchesIpv4Prefix(address, base, prefix),
  );
}

/** Whether a canonical IPv6 address is in a reserved range (incl. `::` / `::1`). */
export function isReservedIpv6(address: string): boolean {
  return (
    matchesIpv6Prefix(address, '::', 128) ||
    matchesIpv6Prefix(address, '::1', 128) ||
    RESERVED_IPV6_RANGES.some(([base, prefix]) =>
      matchesIpv6Prefix(address, base, prefix),
    )
  );
}

/**
 * Whether an IP literal (in any spelling) belongs to a reserved/internal range.
 * A value that looks like an IP but won't parse fails closed (blocked); a
 * non-IP hostname returns false (the caller resolves it and re-checks).
 *
 * Pass a bare address: this does NOT strip brackets, because a bracketed
 * literal is indistinguishable from a malformed one here and would fail
 * closed. Callers holding a WHATWG `url.hostname` run it through
 * {@link stripIpv6Brackets} first.
 */
export function isReservedIp(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case 'ipv4':
      return isReservedIpv4(normalized.value);
    case 'ipv6':
      return isReservedIpv6(normalized.value);
    case 'invalid':
      return true;
    case 'not-ip':
      return false;
  }
}
