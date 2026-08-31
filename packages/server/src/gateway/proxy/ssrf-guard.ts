import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import * as net from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, buildConnector } from "undici";

/**
 * SSRF / reserved-IP guard used by the MCP proxy (gateway/auth/mcp/proxy.ts).
 *
 * The matcher collapses the spellings an attacker can use to dress up an
 * internal address so `net.BlockList` won't recognise it: IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` / `::ffff:7f00:1`), the NAT64 well-known prefix
 * (`64:ff9b::/96`), zone IDs (`fe80::1%eth0`), and the `0.0.0.0/8` / `::`
 * unspecified ranges — all of which the previous hand-rolled check missed.
 *
 * `fetchPublicUrl` closes the DNS-rebinding (TOCTOU) gap: its connector resolves
 * every hostname once, rejects the entire answer set when any address is
 * reserved, then hands one of those exact validated addresses to the socket.
 * Redirects stay on the same dispatcher, so every hop gets the same treatment.
 */

type ReachabilityRule = readonly [
  base: string,
  prefix: number,
  globallyReachable: boolean,
];

/**
 * IANA IPv4 Special-Purpose Address Registry, last reviewed 2025-10-09.
 *
 * Longest-prefix evaluation is load-bearing: 192.0.0.0/24 is non-global, but
 * PCP and TURN have globally reachable /32 anycast exceptions inside it.
 * Multicast is included as a non-unicast routing boundary even though it lives
 * in a separate IANA registry.
 */
const ipv4ReachabilityRules: readonly ReachabilityRule[] = [
  ["0.0.0.0", 8, false],
  ["10.0.0.0", 8, false],
  ["100.64.0.0", 10, false],
  ["127.0.0.0", 8, false],
  ["169.254.0.0", 16, false],
  ["172.16.0.0", 12, false],
  ["192.0.0.0", 24, false],
  ["192.0.0.0", 29, false],
  ["192.0.0.8", 32, false],
  ["192.0.0.9", 32, true],
  ["192.0.0.10", 32, true],
  ["192.0.0.170", 32, false],
  ["192.0.0.171", 32, false],
  ["192.0.2.0", 24, false],
  ["192.31.196.0", 24, true],
  ["192.52.193.0", 24, true],
  ["192.88.99.0", 24, false],
  ["192.88.99.2", 32, false],
  ["192.168.0.0", 16, false],
  ["192.175.48.0", 24, true],
  ["198.18.0.0", 15, false],
  ["198.51.100.0", 24, false],
  ["203.0.113.0", 24, false],
  ["224.0.0.0", 4, false],
  ["240.0.0.0", 4, false],
  ["255.255.255.255", 32, false],
];

/**
 * IANA IPv6 Special-Purpose Address Registry, last reviewed 2025-10-09.
 * The 2000::/3 rule is IANA's allocated global-unicast envelope; everything
 * outside it fails closed unless the special-purpose registry explicitly marks
 * it global (currently the well-known NAT64 prefix). More-specific IETF
 * allocations preserve real global exceptions inside non-global 2001::/23.
 */
const ipv6ReachabilityRules: readonly ReachabilityRule[] = [
  ["::", 128, false],
  ["::1", 128, false],
  ["::ffff:0:0", 96, false],
  ["64:ff9b::", 96, true],
  ["64:ff9b:1::", 48, false],
  ["100::", 64, false],
  ["100:0:0:1::", 64, false],
  ["2000::", 3, true],
  ["2001::", 23, false],
  ["2001::", 32, false], // TEREDO is N/A; fail closed.
  ["2001:1::1", 128, true],
  ["2001:1::2", 128, true],
  ["2001:1::3", 128, true],
  ["2001:2::", 48, false],
  ["2001:3::", 32, true],
  ["2001:4:112::", 48, true],
  ["2001:10::", 28, false],
  ["2001:20::", 28, true],
  ["2001:30::", 28, true],
  ["2001:db8::", 32, false],
  ["2002::", 16, false], // 6to4 is N/A; fail closed.
  ["2620:4f:8000::", 48, true],
  ["3fff::", 20, false],
  ["5f00::", 16, false],
  ["fc00::", 7, false],
  ["fec0::", 10, false], // deprecated site-local (RFC 3879)
  ["fe80::", 10, false],
  ["ff00::", 8, false],
];

function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return undefined;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function matchesIpv4Prefix(
  address: string,
  base: string,
  prefix: number
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
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx !== -1) {
    const colonBeforeDot = lower.lastIndexOf(":", dotIdx);
    const dotted = lower.slice(colonBeforeDot + 1);
    hexPart = lower.slice(0, colonBeforeDot + 1);
    const octets = dotted.split(".").map((o) => parseInt(o, 10));
    ipv4Suffix = [
      ((octets[0]! << 8) | octets[1]!) >>> 0,
      ((octets[2]! << 8) | octets[3]!) >>> 0,
    ];
    if (hexPart.endsWith(":") && !hexPart.endsWith("::")) {
      hexPart = hexPart.slice(0, -1);
    }
  }
  const halves = hexPart.split("::");
  const left = halves[0] ? halves[0].split(":").map((h) => parseInt(h, 16)) : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(":").map((h) => parseInt(h, 16))
      : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

function ipv6ToBigInt(address: string): bigint {
  return expandIpv6ToHextets(address).reduce(
    (acc, hextet) => (acc << 16n) | BigInt(hextet),
    0n
  );
}

function matchesIpv6Prefix(
  address: string,
  base: string,
  prefix: number
): boolean {
  const shift = 128n - BigInt(prefix);
  return ipv6ToBigInt(address) >> shift === ipv6ToBigInt(base) >> shift;
}

function ipv4IsGloballyReachable(address: string): boolean {
  let decision = true;
  let longestPrefix = -1;
  for (const [base, prefix, globallyReachable] of ipv4ReachabilityRules) {
    if (prefix > longestPrefix && matchesIpv4Prefix(address, base, prefix)) {
      decision = globallyReachable;
      longestPrefix = prefix;
    }
  }
  return decision;
}

function ipv6IsGloballyReachable(address: string): boolean {
  let decision = false;
  let longestPrefix = -1;
  for (const [base, prefix, globallyReachable] of ipv6ReachabilityRules) {
    if (prefix > longestPrefix && matchesIpv6Prefix(address, base, prefix)) {
      decision = globallyReachable;
      longestPrefix = prefix;
    }
  }
  return decision;
}

/**
 * Result of running a host literal through {@link normalizeIpLiteral}.
 *  - `ipv4`     — the value is (or decodes to) a bare IPv4 address.
 *  - `ipv6`     — a genuine IPv6 address that doesn't embed an IPv4.
 *  - `not-ip`   — not an IP literal at all (a DNS name); caller should resolve.
 *  - `invalid`  — looks like an IP literal but doesn't cleanly parse → reject.
 */
export type NormalizedHost =
  | { kind: "ipv4"; value: string }
  | { kind: "ipv6"; value: string }
  | { kind: "not-ip" }
  | { kind: "invalid" };

/**
 * Collapse an IP literal to its canonical IPv4/IPv6 form (or not-ip/invalid).
 *
 * Single funnel for every host literal that reaches the blocklist check —
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
  const zoneSplit = host.indexOf("%");
  const bare = (zoneSplit === -1 ? host : host.slice(0, zoneSplit)).trim();
  if (bare.length === 0) {
    return zoneSplit === -1 ? { kind: "not-ip" } : { kind: "invalid" };
  }

  const family = net.isIP(bare);
  if (family === 4) return { kind: "ipv4", value: bare };
  if (family === 0) {
    return bare.includes(":") ? { kind: "invalid" } : { kind: "not-ip" };
  }

  const lower = bare.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return net.isIP(mapped) === 4
        ? { kind: "ipv4", value: mapped }
        : { kind: "invalid" };
    }
    const parts = mapped.split(":");
    if (parts.length !== 2) return { kind: "invalid" };
    const high = Number.parseInt(parts[0] || "", 16);
    const low = Number.parseInt(parts[1] || "", 16);
    if (
      !Number.isInteger(high) ||
      !Number.isInteger(low) ||
      high < 0 ||
      high > 0xffff ||
      low < 0 ||
      low > 0xffff
    ) {
      return { kind: "invalid" };
    }
    return { kind: "ipv4", value: hextetsToIpv4(high, low) };
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
    return { kind: "ipv4", value: hextetsToIpv4(hextets[6]!, hextets[7]!) };
  }

  return { kind: "ipv6", value: bare };
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
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Whether an IP literal (in any spelling) belongs to a reserved/internal range.
 * A value that looks like an IP but won't parse fails closed (blocked); a
 * non-IP hostname returns false (the caller resolves it and re-checks).
 */
export function isReservedIp(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case "ipv4":
      return !ipv4IsGloballyReachable(normalized.value);
    case "ipv6":
      return !ipv6IsGloballyReachable(normalized.value);
    case "invalid":
      return true;
    case "not-ip":
      return false;
  }
}

function privateAddressError(hostname: string): Error {
  return new Error(`URL points to a private/internal address: ${hostname}`);
}

/**
 * Reject a literal/private hostname before a socket is opened. DNS names are
 * resolved by {@link guardedLookup}; this synchronous check is still needed
 * because Node skips DNS lookup entirely for IP-literal redirect targets.
 */
function assertPublicHostname(rawHostname: string): void {
  const hostname = stripIpv6Brackets(rawHostname.toLowerCase());
  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === "invalid" || isReservedIp(hostname)) {
    throw privateAddressError(hostname);
  }
  if (
    normalized.kind === "not-ip" &&
    (hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal"))
  ) {
    throw privateAddressError(hostname);
  }
}

function assertPublicDnsAnswers(
  hostname: string,
  addresses: LookupAddress[]
): void {
  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }
  for (const answer of addresses) {
    if (isReservedIp(answer.address)) {
      throw privateAddressError(`${hostname} (${answer.address})`);
    }
  }
}

/**
 * Resolve the complete answer set before selecting an address. Selecting a
 * public answer while silently ignoring a private sibling would let resolver
 * ordering determine the result and leave a rebinding path open.
 */
type ResolveAllAddresses = (hostname: string) => Promise<LookupAddress[]>;

function createGuardedLookup(
  resolveAll: ResolveAllAddresses = async (hostname) =>
    dns.lookup(hostname, { all: true, verbatim: true })
): LookupFunction {
  return (hostname, options, callback) => {
    assertPublicHostname(hostname);
    void resolveAll(hostname)
      .then((addresses) => {
        assertPublicDnsAnswers(hostname, addresses);
        if (typeof options === "object" && options.all) {
          (
            callback as unknown as (
              error: null,
              value: LookupAddress[]
            ) => void
          )(null, addresses);
          return;
        }
        const selected = addresses[0]!;
        (
          callback as unknown as (
            error: null,
            address: string,
            family: number
          ) => void
        )(null, selected.address, selected.family);
      })
      .catch((error: unknown) => {
        (
          callback as unknown as (
            error: NodeJS.ErrnoException,
            address?: string,
            family?: number
          ) => void
        )(
          error instanceof Error
            ? error
            : new Error(`DNS lookup failed for ${hostname}`)
        );
      });
  };
}

const guardedLookup = createGuardedLookup();
const connectToValidatedAddress = buildConnector({ lookup: guardedLookup });

type RuntimeConnector = ReturnType<typeof buildConnector>;

function connectPublicTarget(
  options: Parameters<RuntimeConnector>[0],
  callback: Parameters<RuntimeConnector>[1],
  connect: RuntimeConnector = connectToValidatedAddress
): void {
  try {
    // Load-bearing for redirects to raw IP literals: net.connect bypasses
    // lookup for those, so the lookup callback alone is not a complete guard.
    assertPublicHostname(options.hostname);
  } catch (error) {
    callback(
      error instanceof Error
        ? error
        : new Error("Blocked outbound connection target"),
      null
    );
    return;
  }
  // Forward the original options object unchanged. In particular, TLS SNI
  // remains the URL hostname even though lookup pins the socket to a validated
  // numeric address.
  connect(options, callback);
}

const publicNetworkDispatcher = new Agent({
  connect: connectPublicTarget,
});

/** Narrow transport seams exposed only for dependency-free regression tests. */
export const __ssrfGuardTestOnly = {
  connectPublicTarget,
  createGuardedLookup,
};

/**
 * Fetch an untrusted public URL without a DNS check-then-fetch race.
 *
 * The dispatcher is retained for connection pooling, but every new connection
 * resolves through `guardedLookup`; a reused socket is already connected to a
 * previously validated address. Undici also uses the dispatcher for redirect
 * hops, including the literal-host check in the connector above.
 */
function findPrivateAddressError(error: unknown): Error | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (
      candidate instanceof Error &&
      candidate.message.startsWith("URL points to a private/internal address:")
    ) {
      return candidate;
    }
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause) {
      pending.push(candidate.cause);
    }
  }
  return null;
}

export async function fetchPublicUrl(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  const parsed = input instanceof URL ? input : new URL(input);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  assertPublicHostname(parsed.hostname);
  const requestInit = {
    ...init,
    dispatcher: publicNetworkDispatcher,
  } as unknown as RequestInit;
  try {
    return await fetch(parsed, requestInit);
  } catch (error) {
    // Node's fetch wraps connector failures in `TypeError("fetch failed")`.
    // Surface the security decision itself so callers and operators can tell a
    // blocked target from a transient upstream outage.
    throw findPrivateAddressError(error) ?? error;
  }
}

/**
 * Parse a credential-bearing destination and require transport encryption.
 * This is intentionally narrower than {@link fetchPublicUrl}: unauthenticated
 * public HTTP remains supported, but authorization codes, client secrets,
 * refresh tokens, and bearer tokens must never be sent over plaintext HTTP.
 */
export function parseCredentialedHttpsUrl(input: string | URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(input instanceof URL ? input.href : input);
  } catch {
    throw new Error("Credential-bearing request URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Credential-bearing requests require HTTPS");
  }
  return parsed;
}

/** Apply the HTTPS credential policy before entering the public URL transport. */
export async function fetchCredentialedPublicUrl(
  input: string | URL,
  init: RequestInit = {}
): Promise<Response> {
  if (init.redirect === "follow") {
    throw new Error("Credential-bearing requests cannot automatically follow redirects");
  }
  return fetchPublicUrl(parseCredentialedHttpsUrl(input), {
    ...init,
    redirect: init.redirect ?? "error",
  });
}

/**
 * Resolve a URL's hostname and check whether it points to an internal/reserved
 * network. Returns true (blocked) when URL parsing fails.
 */
export async function isInternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    // WHATWG URL keeps IPv6 literals bracketed (`[::1]`); strip so net.isIP sees them.
    const hostname =
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;

    if (isReservedIp(hostname)) return true;

    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);

    for (const addr of [...addresses, ...addresses6]) {
      if (isReservedIp(addr)) return true;
    }

    return false;
  } catch {
    return true;
  }
}
