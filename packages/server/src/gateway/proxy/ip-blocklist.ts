import type { LookupAddress, LookupOptions } from "node:dns";
import * as dns from "node:dns/promises";
import * as net from "node:net";
import { Agent } from "undici";

// Single source of truth for the SSRF / reserved-IP guard. Both the worker
// egress HTTP proxy (`http-proxy.ts`) and the MCP upstream proxy
// (`auth/mcp/proxy.ts`) route every host literal and resolved DNS answer
// through this module so the blocklist can't be bypassed by an alternate IP
// spelling (IPv4-mapped IPv6, NAT64, `0.0.0.0`, `::`, zone IDs, etc.).

const blockedIpv4Ranges: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const blockedIpv6Ranges: ReadonlyArray<readonly [string, number]> = [
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

const blockedIpv4List = new net.BlockList();
for (const [address, prefix] of blockedIpv4Ranges) {
  blockedIpv4List.addSubnet(address, prefix, "ipv4");
}

const blockedIpv6List = new net.BlockList();
blockedIpv6List.addAddress("::", "ipv6");
blockedIpv6List.addAddress("::1", "ipv6");
for (const [address, prefix] of blockedIpv6Ranges) {
  blockedIpv6List.addSubnet(address, prefix, "ipv6");
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

/** Turn 16 bits + 16 bits into a dotted-quad IPv4 string. */
function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Expand a valid IPv6 address string into exactly 8 unsigned 16-bit hextets.
 * Handles `::` compression and mixed dotted-quad suffixes (e.g. `::ffff:127.0.0.1`).
 * The caller must pass a string already validated by `net.isIP() === 6`.
 */
function expandIpv6ToHextets(addr: string): number[] {
  const lower = addr.toLowerCase();

  // Detect and handle the embedded IPv4 dotted-quad suffix (e.g. `::ffff:127.0.0.1`).
  // RFC 4291 §2.2 allows the last 32 bits of an IPv6 address to be written in
  // dotted-quad form. When present, convert those 4 octets to 2 hextets first.
  let hexPart = lower;
  let ipv4Suffix: number[] = [];
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx !== -1) {
    // The dotted-quad portion starts at the last ':' before the first dot.
    const colonBeforeDot = lower.lastIndexOf(":", dotIdx);
    const dotted = lower.slice(colonBeforeDot + 1);
    hexPart = lower.slice(0, colonBeforeDot + 1); // keep the trailing ':'
    const octets = dotted.split(".").map((o) => parseInt(o, 10));
    // octets must be exactly 4 valid bytes (already guaranteed by net.isIP)
    ipv4Suffix = [
      ((octets[0]! << 8) | octets[1]!) >>> 0,
      ((octets[2]! << 8) | octets[3]!) >>> 0,
    ];
    // Strip the trailing colon we left on hexPart so split works correctly
    if (hexPart.endsWith(":") && !hexPart.endsWith("::")) {
      hexPart = hexPart.slice(0, -1);
    }
  }

  const halves = hexPart.split("::");
  const left = halves[0]
    ? halves[0].split(":").map((h) => parseInt(h, 16))
    : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(":").map((h) => parseInt(h, 16))
      : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

/**
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
  // Strip a zone identifier first (`%eth0`, `%1`). It's only meaningful for
  // link-local addresses and never changes the routability decision.
  const zoneSplit = host.indexOf("%");
  const bare = (zoneSplit === -1 ? host : host.slice(0, zoneSplit)).trim();
  if (bare.length === 0) {
    return zoneSplit === -1 ? { kind: "not-ip" } : { kind: "invalid" };
  }

  const family = net.isIP(bare);
  if (family === 4) {
    return { kind: "ipv4", value: bare };
  }
  if (family === 0) {
    // Not a valid IP literal. If it contains ':' it was meant to be an IPv6
    // address (or something pretending to be one) but didn't parse — reject.
    // Otherwise treat it as a hostname for the caller to resolve.
    return bare.includes(":") ? { kind: "invalid" } : { kind: "not-ip" };
  }

  // family === 6 from here on.
  const lower = bare.toLowerCase();

  // IPv4-mapped IPv6: `::ffff:a.b.c.d` or `::ffff:hhhh:hhhh`.
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return net.isIP(mapped) === 4
        ? { kind: "ipv4", value: mapped }
        : { kind: "invalid" };
    }
    const parts = mapped.split(":");
    if (parts.length !== 2) {
      return { kind: "invalid" };
    }
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

  // NAT64 well-known prefix `64:ff9b::/96` — the trailing 32 bits hold the
  // synthesised IPv4 destination. Both compressed (`64:ff9b::a9fe:a9fe`) and
  // expanded (`64:ff9b:0:0:0:0:a9fe:a9fe`) spellings must decode identically.
  // Canonicalize into 8 hextets and verify the first 96 bits match the prefix.
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

export function isBlockedIpAddress(ip: string): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case "ipv4":
      return blockedIpv4List.check(normalized.value, "ipv4");
    case "ipv6":
      // A genuine IPv6 address can still wrap an internal target via a
      // mapped/translation prefix `net.BlockList` doesn't know about; the
      // normalization above handles the standard ones (::ffff:, 64:ff9b::),
      // so by this point a bare IPv6 only needs the IPv6 blocklist.
      return blockedIpv6List.check(normalized.value, "ipv6");
    case "invalid":
      // Fail closed: an address that looks like an IP literal but won't
      // parse cleanly must not be allowed through.
      return true;
    case "not-ip":
      return false;
  }
}

/**
 * Strip surrounding brackets from an IPv6 literal so `net.isIP()` can
 * recognise it. WHATWG URL parsing returns `parsedUrl.hostname` with
 * brackets for IPv6 (e.g. `[::1]`), and `net.isIP("[::1]")` returns 0,
 * which would cause the IP-blocklist check to be skipped and the value
 * to fall through to DNS lookup — bypassing the loopback/private-IP
 * guards. Normalising to the bare address closes that hole.
 */
export function stripIpv6Brackets(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

type DnsLookupAllFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

let dnsLookupOverride: DnsLookupAllFn | null = null;

/** Test seam: override the DNS resolver used by {@link resolveUrlToSafeAddress}. */
export function setIpBlocklistDnsLookup(fn: DnsLookupAllFn | null): void {
  dnsLookupOverride = fn;
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
let ssrfFetchOverride: FetchImpl | null = null;

/**
 * Test seam: override the `fetch` used by {@link ssrfSafeFetch}. Lets tests
 * drive the redirect-revalidation path without real network egress (the pinned
 * dispatcher always connects to the validated IP, which is never a loopback
 * test server). Production always uses the global undici `fetch`.
 */
export function setSsrfFetchImpl(fn: FetchImpl | null): void {
  ssrfFetchOverride = fn;
}

/**
 * Outcome of resolving a URL to a single validated IP address.
 *  - `ok: true`  → connect to `address` (already past the blocklist).
 *  - `ok: false` → blocked; `reason` is a human-readable cause for logging.
 */
export type SafeAddressResult =
  | { ok: true; address: string; family: 4 | 6 }
  | { ok: false; reason: string };

/**
 * Resolve a URL's host to exactly one IP address that has passed the
 * reserved/internal blocklist, closing the DNS-rebinding (TOCTOU) hole.
 *
 * The caller MUST connect to the returned `address`, never re-resolve the
 * hostname — otherwise a resolver that flips between a public and an internal
 * answer between the check and the connect can slip past the guard. The
 * returned address is pinned (the exact literal we validated).
 *
 * IP literals (including IPv4-mapped IPv6 / NAT64 wrappers) are normalized to
 * their bare IPv4/IPv6 form and checked directly without a DNS round-trip.
 */
export async function resolveUrlToSafeAddress(
  url: string,
): Promise<SafeAddressResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `unparseable URL: ${url}` };
  }

  const hostname = stripIpv6Brackets(parsed.hostname);

  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === "invalid") {
    return { ok: false, reason: `malformed target host: ${hostname}` };
  }
  if (normalized.kind !== "not-ip") {
    if (isBlockedIpAddress(hostname)) {
      return { ok: false, reason: `target is local/private IP: ${hostname}` };
    }
    // Pin to the normalized literal — for IPv4-mapped / NAT64 inputs this is
    // the bare IPv4 we actually validated.
    return {
      ok: true,
      address: normalized.value,
      family: normalized.kind === "ipv4" ? 4 : 6,
    };
  }

  let addresses: LookupAddress[];
  try {
    addresses = dnsLookupOverride
      ? await dnsLookupOverride(hostname, { all: true, verbatim: true })
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      ok: false,
      reason: `DNS lookup failed for ${hostname}: ${message}`,
    };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `DNS returned no addresses for ${hostname}` };
  }

  // Every resolved answer must clear the blocklist — a single internal answer
  // (split-horizon / rebinding) blocks the whole request.
  const blocked = addresses.find((addr) => isBlockedIpAddress(addr.address));
  if (blocked) {
    return {
      ok: false,
      reason: `${hostname} resolved to blocked IP ${blocked.address}`,
    };
  }

  const first = addresses[0]!;
  return {
    ok: true,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/**
 * Thrown by {@link ssrfSafeFetch} when the target host resolves to a blocked
 * reserved/internal address. Callers translate this into a 403 / explicit
 * error rather than letting the request reach an internal service.
 */
export class SsrfBlockedError extends Error {
  constructor(public readonly detail: string) {
    super("URL resolves to a blocked internal network");
    this.name = "SsrfBlockedError";
  }
}

/**
 * Build the undici `connect.lookup` that pins every connection attempt to one
 * pre-validated IP. It must honor BOTH Node `dns.lookup` callback shapes:
 * undici calls it with `{ all: true }` and expects an array of
 * `{ address, family }`; returning the scalar form in that case makes the
 * connection fail before it is attempted. Exported for tests.
 */
export function pinnedConnectLookup(pinnedIp: string, family: number) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options?.all) {
      callback(null, [{ address: pinnedIp, family }]);
    } else {
      callback(null, pinnedIp, family);
    }
  };
}

/** Max redirect hops ssrfSafeFetch will follow before giving up. */
const MAX_SSRF_REDIRECTS = 5;

/**
 * SSRF-safe `fetch`: resolve the URL's host to exactly ONE validated public IP
 * via {@link resolveUrlToSafeAddress}, then pin the connection to that address
 * so the socket can never be redirected to an internal target by a second DNS
 * resolution (DNS rebinding / TOCTOU). The Host header and TLS SNI still derive
 * from the original URL hostname, so virtual-hosting and certificate validation
 * are unaffected.
 *
 * Redirects are followed MANUALLY (`redirect: "manual"`) and every hop is
 * re-validated through {@link resolveUrlToSafeAddress}. This is required: the
 * pinned `connect.lookup` only fires for hostnames, so a 3xx whose `Location`
 * is an IP literal (e.g. `http://169.254.169.254/`) would otherwise bypass the
 * guard entirely and reach an internal service. The original `init` (method,
 * headers, body) is replayed on each hop, so non-replayable stream bodies
 * should not be combined with redirecting endpoints.
 *
 * Throws {@link SsrfBlockedError} when any hop's host is blocked or the redirect
 * chain is too long.
 */
export async function ssrfSafeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; ; hop++) {
    const resolved = await resolveUrlToSafeAddress(currentUrl);
    if (!resolved.ok) {
      throw new SsrfBlockedError(resolved.reason);
    }

    const pinnedIp = resolved.address;
    const pinnedFamily = resolved.family ?? (pinnedIp.includes(":") ? 6 : 4);
    const dispatcher = new Agent({
      connect: { lookup: pinnedConnectLookup(pinnedIp, pinnedFamily) },
    });

    // `dispatcher` is an undici option on the global fetch; the lib DOM/Node
    // `RequestInit` type doesn't surface it, so widen the init type here.
    const doFetch = ssrfFetchOverride ?? fetch;
    const response = await doFetch(currentUrl, {
      ...init,
      redirect: "manual",
      dispatcher,
    } as unknown as RequestInit & { dispatcher: unknown });

    // Gracefully tear down the per-request dispatcher WITHOUT awaiting: undici's
    // close() resolves only after the in-flight (possibly streaming) request
    // completes, so awaiting it here — before the caller has read the body —
    // would deadlock. Fire-and-forget keeps the Response body readable and lets
    // the agent close once the stream drains. `close` may be absent under Bun's
    // undici interop; never let teardown surface as a request failure.
    const close = (dispatcher as { close?: () => Promise<void> }).close;
    const closeDispatcher = () => {
      if (typeof close === "function") {
        void close.call(dispatcher).catch(() => {
          /* noop */
        });
      }
    };

    const location =
      response.status >= 300 && response.status < 400
        ? response.headers.get("location")
        : null;
    if (!location) {
      closeDispatcher();
      return response;
    }

    // Following a redirect: drain the 3xx body, then re-validate the target.
    await response.body?.cancel().catch(() => {
      /* noop */
    });
    closeDispatcher();
    if (hop >= MAX_SSRF_REDIRECTS) {
      throw new SsrfBlockedError(
        `too many redirects (>${MAX_SSRF_REDIRECTS}) starting from ${url}`,
      );
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}
