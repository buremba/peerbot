/**
 * SSRF / egress guard for database connectors.
 *
 * A DB connector opens a raw TCP socket to the host in its connection string.
 * When that string is operator-set (self-hosted / first-party), the host is
 * trusted — private IPs are legitimate (the dogfood reaches Lobu's own private
 * PG; `make dev` reaches localhost). When it is tenant-supplied on multi-tenant
 * cloud, a host like 169.254.169.254 (cloud metadata), an internal CIDR, or
 * another tenant's DB is an exfil/scan vector.
 *
 * Two policies:
 *  - `allow-private`  (self-hosted / first-party, the default): allow loopback,
 *    RFC1918, CGNAT, and ULA — but STILL block link-local/metadata, multicast,
 *    and the unspecified address (no real DB lives there; cheap defense in depth).
 *  - `block-private`  (untrusted cloud): block every non-public address.
 *
 * The IP classifier is ported from the gateway's HTTP egress guard
 * (`packages/server/src/gateway/proxy/http-proxy.ts`) — that package isn't
 * reachable from the bundled connector, so the logic is duplicated, not imported.
 * It collapses the forms an attacker can use to dress up an internal address
 * (IPv4-mapped IPv6, NAT64 `64:ff9b::/96`, zone IDs) and FAILS CLOSED on any
 * IP-looking literal it can't parse.
 *
 * NOTE (intentional limitation): this validates + rejects blocked hosts but does
 * NOT pin the resolved IP into the socket, so a DNS-rebind between this check and
 * the connect is not closed here, and TLS is not forced when the URL omits it.
 * Those, plus flipping `CLOUD_RESTRICTED_CONNECTOR_KEYS`, are the remaining
 * go-live steps before a tenant-supplied URL is accepted on cloud.
 */
import dns from 'node:dns';
import net from 'node:net';

export type DbEgressPolicy = 'allow-private' | 'block-private';

/** IPv4 CIDRs blocked under `block-private` (the full non-public set). */
const BLOCK_PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
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

const BLOCK_PRIVATE_V6: ReadonlyArray<readonly [string, number]> = [
  ['fc00::', 7], // unique local (ULA)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

/**
 * The subset blocked even under `allow-private` — addresses no legitimate DB is
 * ever reachable at, regardless of trust: cloud metadata / link-local, the
 * unspecified address, multicast, and the reserved/broadcast range. Loopback,
 * RFC1918, CGNAT, and ULA are deliberately ABSENT (self-hosted reaches them).
 */
const ALLOW_PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const ALLOW_PRIVATE_V6: ReadonlyArray<readonly [string, number]> = [
  ['fe80::', 10],
  ['ff00::', 8],
];

function buildV4List(ranges: ReadonlyArray<readonly [string, number]>): net.BlockList {
  const list = new net.BlockList();
  for (const [address, prefix] of ranges) list.addSubnet(address, prefix, 'ipv4');
  return list;
}

function buildV6List(
  ranges: ReadonlyArray<readonly [string, number]>,
  withUnspecified: boolean,
): net.BlockList {
  const list = new net.BlockList();
  if (withUnspecified) list.addAddress('::', 'ipv6');
  for (const [address, prefix] of ranges) list.addSubnet(address, prefix, 'ipv6');
  return list;
}

// `block-private` additionally blocks loopback (::1); `allow-private` allows it.
const BLOCK_PRIVATE_V6_LIST = (() => {
  const list = buildV6List(BLOCK_PRIVATE_V6, true);
  list.addAddress('::1', 'ipv6');
  return list;
})();
const BLOCK_PRIVATE_V4_LIST = buildV4List(BLOCK_PRIVATE_V4);
const ALLOW_PRIVATE_V4_LIST = buildV4List(ALLOW_PRIVATE_V4);
const ALLOW_PRIVATE_V6_LIST = buildV6List(ALLOW_PRIVATE_V6, true);

function lists(policy: DbEgressPolicy): { v4: net.BlockList; v6: net.BlockList } {
  return policy === 'block-private'
    ? { v4: BLOCK_PRIVATE_V4_LIST, v6: BLOCK_PRIVATE_V6_LIST }
    : { v4: ALLOW_PRIVATE_V4_LIST, v6: ALLOW_PRIVATE_V6_LIST };
}

type NormalizedHost =
  | { kind: 'ipv4'; value: string }
  | { kind: 'ipv6'; value: string }
  | { kind: 'not-ip' }
  | { kind: 'invalid' };

function hextetsToIpv4(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/** Expand a valid IPv6 (net.isIP === 6) into 8 unsigned 16-bit hextets. */
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
  const left = halves[0] ? halves[0].split(':').map((h) => Number.parseInt(h, 16)) : [];
  const right =
    halves.length === 2 && halves[1] ? halves[1].split(':').map((h) => Number.parseInt(h, 16)) : [];
  const rightWithSuffix = [...right, ...ipv4Suffix];
  const zeros = new Array(8 - left.length - rightWithSuffix.length).fill(0);
  return [...left, ...zeros, ...rightWithSuffix];
}

/**
 * Collapse a host literal to a canonical IPv4/IPv6 (or report not-ip/invalid).
 * Unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`) and NAT64
 * (`64:ff9b::a9fe:a9fe`); strips zone IDs. An IP-looking literal that won't
 * parse returns `invalid` so the caller fails closed.
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
      return net.isIP(mapped) === 4 ? { kind: 'ipv4', value: mapped } : { kind: 'invalid' };
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
 * True if `ip` (a single IP literal) is blocked under `policy`. A literal that
 * looks like an IP but won't parse is treated as blocked (fail closed); a value
 * that isn't an IP literal at all returns false (the caller resolves it first).
 */
export function isBlockedIp(ip: string, policy: DbEgressPolicy): boolean {
  const normalized = normalizeIpLiteral(ip);
  const { v4, v6 } = lists(policy);
  switch (normalized.kind) {
    case 'ipv4':
      return v4.check(normalized.value, 'ipv4');
    case 'ipv6':
      return v6.check(normalized.value, 'ipv6');
    case 'invalid':
      return true;
    case 'not-ip':
      return false;
  }
}

/** Resolver injected for testability; defaults to the real DNS lookup. */
export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;

const defaultLookup: HostLookup = (host) => dns.promises.lookup(host, { all: true });

/**
 * Throw if `host` (an IP literal OR a DNS name) is — or resolves to — an address
 * blocked under `policy`. A hostname is resolved and rejected if ANY returned
 * address is blocked (covers multi-record / round-robin rebind tricks). The
 * error names the host but never the full connection string (credentials must
 * not leak). `lookup` is injectable for tests.
 */
export async function assertHostAllowed(
  host: string,
  policy: DbEgressPolicy,
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  const normalized = normalizeIpLiteral(host);
  if (normalized.kind === 'ipv4' || normalized.kind === 'ipv6' || normalized.kind === 'invalid') {
    if (isBlockedIp(host, policy)) {
      throw new Error(
        `DATABASE_URL host "${host}" is a blocked internal/metadata address (egress policy: ${policy}).`,
      );
    }
    return;
  }

  // A DNS name — resolve every address and reject if any is blocked.
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DATABASE_URL host "${host}" could not be resolved: ${msg}`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address, policy)) {
      throw new Error(
        `DATABASE_URL host "${host}" resolves to a blocked internal/metadata address (${address}, egress policy: ${policy}).`,
      );
    }
  }
}

/**
 * Pull every host out of a connection string the way postgres.js does, so the
 * guard's host set matches the driver's connect set. postgres.js supports a
 * multi-host authority (`postgres://u:p@h1:p1,h2:p2/db`) and failover-dials each
 * host — `new URL().hostname` collapses that to the literal "h1,h2", letting a
 * `public,169.254.169.254` host evade the guard while the driver still dials the
 * metadata IP. Parse the authority by hand: strip scheme, path/query, and
 * userinfo (last `@`, so a password containing `@` is handled), then split on
 * `,` and drop each `:port` and IPv6 brackets. Returns [] when there's no URL
 * authority (e.g. a `key=value` / unix-socket string the driver resolves itself).
 */
export function extractDbHosts(connectionString: string): string[] {
  const schemeAt = connectionString.indexOf('://');
  if (schemeAt === -1) return [];
  let authority = connectionString.slice(schemeAt + 3);
  const pathStart = authority.search(/[/?]/);
  if (pathStart !== -1) authority = authority.slice(0, pathStart);
  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  return authority
    .split(',')
    .map((seg) => {
      const s = seg.trim();
      if (s.startsWith('[')) {
        const close = s.indexOf(']');
        return close === -1 ? s.slice(1) : s.slice(1, close); // IPv6 literal
      }
      const colon = s.lastIndexOf(':');
      return colon === -1 ? s : s.slice(0, colon); // strip :port
    })
    .filter((h) => h.length > 0);
}

/**
 * Assert every host in a postgres connection string is allowed under `policy`
 * (validating each host of a multi-host failover URL):
 *  - block-private (cloud): validate + DNS-resolve every host; throw if any host
 *    (or any address it resolves to) is internal/metadata. Throws fail-closed
 *    when no host can be parsed.
 *  - allow-private (self-hosted, default): the URL is an operator secret, so only
 *    validate IP LITERALS (cheap metadata/link-local block) and DON'T force a DNS
 *    resolve for a hostname — the driver resolves it itself, and a mandatory
 *    pre-resolve would add a new failure mode for a legitimate private/hostname
 *    (or multi-host failover) DB.
 */
export async function assertConnectionStringAllowed(
  connectionString: string,
  policy: DbEgressPolicy,
  lookup: HostLookup = defaultLookup,
): Promise<void> {
  const hosts = extractDbHosts(connectionString);
  if (hosts.length === 0) {
    if (policy === 'block-private') {
      throw new Error('DATABASE_URL host could not be parsed for egress validation.');
    }
    return;
  }
  for (const host of hosts) {
    if (policy === 'allow-private' && normalizeIpLiteral(host).kind === 'not-ip') continue;
    await assertHostAllowed(host, policy, lookup);
  }
}

/** Map a free-form policy string (from config/env) to the enum; default is the
 *  trusted `allow-private` so first-party/self-hosted is never broken — cloud
 *  paths inject `block-private` explicitly. */
export function readEgressPolicy(value: unknown): DbEgressPolicy {
  return value === 'block-private' ? 'block-private' : 'allow-private';
}
