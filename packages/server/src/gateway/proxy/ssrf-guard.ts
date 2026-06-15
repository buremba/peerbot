import dns from "node:dns/promises";
import * as net from "node:net";

/**
 * SSRF / reserved-IP guard shared by the MCP proxy (gateway/auth/mcp/proxy.ts)
 * and the MCP OAuth discovery module (gateway/auth/mcp/oauth-discovery.ts).
 *
 * The matcher collapses the spellings an attacker can use to dress up an
 * internal address so `net.BlockList` won't recognise it: IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` / `::ffff:7f00:1`), the NAT64 well-known prefix
 * (`64:ff9b::/96`), zone IDs (`fe80::1%eth0`), and the `0.0.0.0/8` / `::`
 * unspecified ranges — all of which the previous hand-rolled check missed.
 *
 * NOTE: `isInternalUrl` resolves the host and checks the answers, but the caller
 * then issues a separate `fetch` that re-resolves the name. That check-then-fetch
 * gap is a DNS-rebinding (TOCTOU) window this module does not yet close — the
 * fix is to pin the connection to the validated IP (a pinned-`fetch` primitive).
 * Tracked as a follow-up.
 */

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

function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
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
      return blockedIpv4List.check(normalized.value, "ipv4");
    case "ipv6":
      return blockedIpv6List.check(normalized.value, "ipv6");
    case "invalid":
      return true;
    case "not-ip":
      return false;
  }
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
