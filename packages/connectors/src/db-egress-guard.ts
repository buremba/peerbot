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
 * The IP classifier itself is `@lobu/connector-sdk/ip-reachability`, shared with
 * the gateway's HTTP egress guard and the connector SDK's URL guard. It collapses
 * the forms an attacker can use to dress up an internal address (IPv4-mapped and
 * IPv4-compatible IPv6, NAT64 `64:ff9b::/96`, zone IDs) and FAILS CLOSED on any
 * IP-looking literal it can't parse. This module owns only the POLICY on top:
 * which ranges each policy denies, the metadata pins, and the allowlist.
 *
 * Under `block-private` the guard goes beyond classify-and-reject
 * (`buildDbEgressHardening`):
 *  - resolve-then-PIN: each hostname is resolved ONCE at guard time, every
 *    address is validated, and the socket postgres.js opens dials exactly the
 *    validated IP (custom `socket` factory) — the driver never re-resolves, so a
 *    DNS rebind between check and connect (or across pool reconnects) is closed.
 *  - forced TLS: the connection is encrypted regardless of URL params
 *    (`sslmode=disable` is rejected outright; see `requiredTlsMode`).
 *
 * DEFERRED (explicit follow-up, not a gap in the platform boundary): a per-org
 * destination allowlist ("this org may only reach these DB hosts"). block-private
 * + pin + forced TLS is what protects the PLATFORM (no internal/metadata/tenant
 * lateral movement, no plaintext creds on the wire); an allowlist protects a
 * tenant from its own operators and is an enterprise policy feature layered on
 * top later.
 */
import { createRequire } from 'node:module';
import type net from 'node:net';

/**
 * `node:dns` and `node:net` are reached through a RUNTIME require, not a static
 * import, on purpose: this module is bundled into the isolate artifact, and a
 * static import would leave a bare `require('node:dns')` in the bundle that
 * `findIsolateIneligibleBuiltins` rejects before the connector ever loads. The
 * two lookups below are the only uses, and neither runs in the isolate — a
 * connector there dials through the host's `connect`, which enforces the same
 * policy host-side (`executor/isolate.ts` `socketOpen`).
 */
const dynamicRequire = typeof require === 'function' ? require : createRequire(import.meta.url);
import {
  ipFamily,
  isReservedIpv4,
  isReservedIpv6,
  matchesIpv4Prefix,
  matchesIpv6Prefix,
  normalizeIpLiteral,
} from '@lobu/connector-sdk/ip-reachability';

export type DbEgressPolicy = 'allow-private' | 'block-private';

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

/**
 * Cloud-metadata endpoints that live OUTSIDE the ranges the `allow-private`
 * floor already denies, listed individually so they stay blocked under every
 * policy and even for an explicitly allowlisted host.
 *
 * Each sits in a range `allow-private` deliberately permits, so without this
 * set an exemption would drop the host to that floor and expose the endpoint:
 * Alibaba's is in CGNAT `100.64.0.0/10` — exactly the range a Tailscale
 * exemption targets — and AWS's IPv6 IMDS is in ULA `fc00::/7`, where a
 * self-hoster's DB legitimately lives. Kept metadata-only so ordinary CGNAT
 * and ULA hosts stay reachable. (169.254.169.254 and 169.254.170.2 need no
 * entry — link-local `169.254.0.0/16` is already denied at the floor.)
 */
const METADATA_V4: ReadonlyArray<readonly [string, number]> = [
  ['100.100.100.200', 32], // Alibaba Cloud metadata (inside CGNAT)
  ['192.0.0.192', 32], // Oracle Cloud metadata (IETF protocol assignments)
];

const METADATA_V6: ReadonlyArray<readonly [string, number]> = [
  ['fd00:ec2::254', 128], // AWS IMDS over IPv6 (inside ULA)
];

function isMetadataV4(address: string): boolean {
  return METADATA_V4.some(([base, prefix]) => matchesIpv4Prefix(address, base, prefix));
}

function isMetadataV6(address: string): boolean {
  return METADATA_V6.some(([base, prefix]) => matchesIpv6Prefix(address, base, prefix));
}

/**
 * `block-private` denies exactly the shared reserved-range set; `allow-private`
 * drops to the narrower floor above. Cloud-metadata endpoints are denied under
 * both, including for allowlisted hosts.
 */
function isBlockedV4(address: string, policy: DbEgressPolicy): boolean {
  if (isMetadataV4(address)) return true;
  if (policy === 'block-private') return isReservedIpv4(address);
  return ALLOW_PRIVATE_V4.some(([base, prefix]) =>
    matchesIpv4Prefix(address, base, prefix),
  );
}

function isBlockedV6(address: string, policy: DbEgressPolicy): boolean {
  if (isMetadataV6(address) || matchesIpv6Prefix(address, '::', 128)) {
    return true;
  }
  if (policy === 'block-private') return isReservedIpv6(address);
  return ALLOW_PRIVATE_V6.some(([base, prefix]) =>
    matchesIpv6Prefix(address, base, prefix),
  );
}

/**
 * True if `ip` (a single IP literal) is blocked under `policy`. A literal that
 * looks like an IP but won't parse is treated as blocked (fail closed); a value
 * that isn't an IP literal at all returns false (the caller resolves it first).
 */
export function isBlockedIp(ip: string, policy: DbEgressPolicy): boolean {
  const normalized = normalizeIpLiteral(ip);
  switch (normalized.kind) {
    case 'ipv4':
      return isBlockedV4(normalized.value, policy);
    case 'ipv6':
      return isBlockedV6(normalized.value, policy);
    case 'invalid':
      return true;
    case 'not-ip':
      return false;
  }
}

/** Resolver injected for testability; defaults to the real DNS lookup. */
export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;

const defaultLookup: HostLookup = async (host) => {
  const dns = dynamicRequire('node:dns') as typeof import('node:dns');
  return dns.promises.lookup(host, { all: true });
};

/**
 * Parse an operator-supplied allow-host list (comma-separated) into entries.
 *
 * Deployment config ONLY — it rides the same gateway-authoritative path as the
 * policy itself and is never settable from tenant/connection config, so a tenant
 * cannot widen its own egress boundary. Entries are matched EXACTLY against the
 * bare host extracted from DATABASE_URL (IPv6 without URL brackets); no
 * wildcards or CIDRs, so approving one tailnet host never approves the whole
 * `100.64.0.0/10` range.
 */
export function parseAllowedHosts(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    // Reject shapes that cannot match `extractDbHosts`; otherwise an operator
    // typo silently leaves the intended exemption inactive.
    const reason = malformedAllowedHostReason(entry);
    if (reason) {
      throw new Error(
        `LOBU_DB_EGRESS_ALLOW_HOSTS entry "${entry}" is invalid: ${reason}. ` +
          'Use the exact bare host from DATABASE_URL (no CIDR, wildcard, port, or IPv6 brackets).',
      );
    }
  }
  return entries;
}

/** Why an allow-host entry can never match a parsed DATABASE_URL host, if so. */
function malformedAllowedHostReason(entry: string): string | null {
  if (entry.includes('/')) return 'a CIDR range is not an exact host';
  if (entry.includes('*')) return 'a wildcard is not an exact host';
  if (entry.startsWith('[') || entry.endsWith(']')) {
    return 'brackets are stripped from IPv6 hosts before matching';
  }
  // A bare IPv6 literal legitimately contains `:` — only flag a trailing
  // `:port`, which `extractDbHosts` would already have removed from the URL.
  if (ipFamily(entry) === 0 && /:\d+$/.test(entry)) return 'a :port is not part of the host';
  return null;
}

/** Case-insensitive exact match of a URL host against the allow list. */
function isAllowlistedHost(host: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return false;
  const needle = host.trim().toLowerCase();
  return allowedHosts.some((entry) => entry.toLowerCase() === needle);
}

/**
 * Throw if `host` (an IP literal OR a DNS name) is — or resolves to — an address
 * blocked under `policy`. A hostname is resolved and rejected if ANY returned
 * address is blocked (covers multi-record / round-robin rebind tricks). The
 * error names the host but never the full connection string (credentials must
 * not leak). `lookup` is injectable for tests.
 *
 * `allowedHosts` (operator deployment config) exempts an exactly-matching host
 * from the POLICY range check only — see {@link resolveAllowedHostAddresses}.
 */
export async function assertHostAllowed(
  host: string,
  policy: DbEgressPolicy,
  lookup: HostLookup = defaultLookup,
  allowedHosts: readonly string[] = [],
): Promise<void> {
  await resolveAllowedHostAddresses(host, policy, lookup, allowedHosts);
}

/**
 * Like {@link assertHostAllowed}, but returns the validated address list so a
 * caller can PIN the connection to it (resolve-then-pin closes the DNS-rebind
 * TOCTOU: the socket dials exactly what was validated, never a re-resolve).
 * An IP-literal host returns its normalized form (IPv4-mapped/NAT64 unwrapped);
 * a hostname returns every address the single guard-time lookup produced.
 *
 * An allowlisted host is exempted from the POLICY range check (so an operator
 * can reach a private/CGNAT DB — e.g. over Tailscale — while cloud mode stays
 * on) but NEVER from the always-blocked set: metadata/link-local, unspecified,
 * multicast and reserved are rejected under every policy, for allowlisted and
 * ordinary hosts alike. That floor is what makes this a destination exemption
 * rather than an SSRF off-switch, so allowlisting a name whose DNS answer is
 * `169.254.169.254` — or its IPv6 twin `fd00:ec2::254` — still fails.
 */
export async function resolveAllowedHostAddresses(
  host: string,
  policy: DbEgressPolicy,
  lookup: HostLookup = defaultLookup,
  allowedHosts: readonly string[] = [],
): Promise<string[]> {
  // An exempted host drops to the `allow-private` floor — never below it.
  const effectivePolicy: DbEgressPolicy = isAllowlistedHost(host, allowedHosts)
    ? 'allow-private'
    : policy;
  const normalized = normalizeIpLiteral(host);
  if (normalized.kind === 'ipv4' || normalized.kind === 'ipv6' || normalized.kind === 'invalid') {
    if (isBlockedIp(host, effectivePolicy)) {
      throw new Error(
        `DATABASE_URL host "${host}" is a blocked internal/metadata address (egress policy: ${policy}).`,
      );
    }
    // `invalid` always throws above (isBlockedIp fails closed), so this is ipv4/ipv6.
    return normalized.kind === 'invalid' ? [] : [normalized.value];
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
    if (isBlockedIp(address, effectivePolicy)) {
      throw new Error(
        `DATABASE_URL host "${host}" resolves to a blocked internal/metadata address (${address}, egress policy: ${policy}).`,
      );
    }
  }
  if (addresses.length === 0) {
    throw new Error(`DATABASE_URL host "${host}" could not be resolved: no addresses returned.`);
  }
  return addresses.map(({ address }) => address);
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
  allowedHosts: readonly string[] = [],
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
    await assertHostAllowed(host, policy, lookup, allowedHosts);
  }
}

/** Map a free-form policy string (from config/env) to the enum; default is the
 *  trusted `allow-private` so first-party/self-hosted is never broken — cloud
 *  paths inject `block-private` explicitly. */
export function readEgressPolicy(value: unknown): DbEgressPolicy {
  return value === 'block-private' ? 'block-private' : 'allow-private';
}

// ---------------------------------------------------------------------------
// block-private hardening: forced TLS + resolve-then-pin
// ---------------------------------------------------------------------------

/**
 * The `ssl` value to FORCE onto postgres.js under `block-private`, derived from
 * the URL's own `sslmode`/`ssl` params (`sslmode` wins when both are present —
 * postgres.js maps `sslmode` over `ssl`). An explicit `ssl` option key overrides
 * the URL in postgres.js (`k in o` beats `k in query`), so returning a value
 * here is authoritative. Rules (monotone — never weakens what the URL asked for):
 *  - `disable` / `false` → REJECT: a tenant URL on cloud must never carry
 *    credentials or rows in plaintext across the internet.
 *  - absent / `allow` / `prefer` / `require` → `'require'` (encrypt always;
 *    `prefer` would silently fall back to plaintext when the server declines).
 *  - `verify-ca` / `verify-full` (or any other explicit value, e.g. `true`) →
 *    passed through unchanged: postgres.js treats non-require/allow/prefer
 *    strings as strict TLS (`rejectUnauthorized` stays on).
 *
 * Why the FLOOR is `require` (encrypt, don't verify the chain) and not
 * `verify-full`: tenant databases very commonly present self-signed or
 * private-CA certs (RDS regional bundles, on-prem), so forcing verify-full
 * would hard-break most legitimate BYO databases with no recourse until we
 * ship per-connection CA upload. `require` matches libpq's semantics for the
 * same flag. Upgrading the floor to verify-full once CA upload exists is the
 * noted follow-up — and the pinned-socket design already keeps it sound: the
 * TLS `servername` stays the ORIGINAL hostname (not the pinned IP), so SNI
 * routing and, when verification is on, certificate identity both check
 * against the name the tenant configured.
 */
export function requiredTlsMode(connectionString: string): string {
  const mode = requestedTlsMode(connectionString);
  if (mode === 'disable' || mode === 'false') {
    throw new Error(
      'DATABASE_URL disables TLS (sslmode=disable), but TLS is required on this deployment (egress policy: block-private). Use sslmode=require or stronger.',
    );
  }
  if (mode === '' || mode === 'allow' || mode === 'prefer' || mode === 'require') {
    return 'require';
  }
  return mode;
}

/**
 * The TLS mode postgres.js will actually apply to this connection string — the
 * pure parse half of `requiredTlsMode`, with no deployment policy attached.
 * Returns `''` when the URL says nothing about TLS, otherwise the lowercased
 * last-wins `sslmode` (falling back to `ssl`), with `sslrootcert=system`
 * forcing `verify-full` exactly as the driver does. Read this where the
 * question is whether the tenant ASKED for certificate verification
 * (`verify-ca` / `verify-full`) — an execution lane that cannot deliver it must
 * refuse rather than connect unverified behind a verifying-looking URL.
 */
export function requestedTlsMode(connectionString: string): string {
  // postgres.js parses the URL with `new URL()`, whose `.searchParams` follows
  // WHATWG URL semantics: the fragment (everything from the FIRST `#`) is NOT
  // part of the query, and a `?` that appears AFTER that `#` is fragment text,
  // not a query delimiter. So cut the fragment off the WHOLE string first, then
  // locate `?`. This closes both `?x=y#frag` (folding `#frag` into the last
  // value) and `#frag?sslmode=disable` (a `?` living inside the fragment being
  // misread as a real query) — either would silently corrupt the TLS decision.
  const hash = connectionString.indexOf('#');
  const beforeFragment =
    hash === -1 ? connectionString : connectionString.slice(0, hash);
  const q = beforeFragment.indexOf('?');
  const params = new URLSearchParams(q === -1 ? '' : beforeFragment.slice(q + 1));
  // Match postgres.js's own precedence exactly (connection.js parseOptions):
  // it reduces searchParams into an object so on DUPLICATE keys the LAST value
  // wins, then maps `sslmode` over `ssl` (sslmode present ⇒ ssl := sslmode).
  // `URLSearchParams.get` returns the FIRST value, so using it would let
  // `?sslmode=require&sslmode=verify-full` read `require` and silently DOWNGRADE
  // the strict TLS the driver would actually apply. Read last-wins for both keys,
  // sslmode taking priority when present.
  // postgres.js only maps sslmode over ssl when the (last) sslmode is truthy
  // (`query.sslmode && ...`), so an empty `?sslmode=` falls through to `ssl`.
  const lastSslmode = params.getAll('sslmode').at(-1);
  const lastSsl = params.getAll('ssl').at(-1);
  const mode = ((lastSslmode || lastSsl) ?? '').toLowerCase();
  // postgres.js applies `sslrootcert=system` LAST and UNCONDITIONALLY forces
  // `ssl = 'verify-full'` (connection.js) — it runs after the sslmode→ssl
  // mapping and even overrides `sslmode=disable`, so the driver would encrypt
  // and verify regardless. Our returned value is authoritative in
  // openGuardedPool (an explicit `ssl` option beats the URL), so we must honor
  // it: otherwise a URL trusting the system CA store would be silently
  // DOWNGRADED from verify-full to require (or wrongly rejected as plaintext),
  // disabling certificate verification.
  const usesSystemCa = params.getAll('sslrootcert').at(-1)?.toLowerCase() === 'system';
  if (usesSystemCa) {
    return 'verify-full';
  }
  return mode;
}

/**
 * Resolve-then-pin, step 1: validate every host of the connection string under
 * `block-private` and return `host → validated IP` (first validated address;
 * ALL returned addresses must pass, so any answer is safe to dial). Keys are
 * lowercased — DNS is case-insensitive and postgres.js hands the factory the
 * URL's spelling verbatim.
 */
export async function resolvePinnedDbHosts(
  connectionString: string,
  lookup: HostLookup = defaultLookup,
  allowedHosts: readonly string[] = [],
): Promise<Map<string, string>> {
  const hosts = extractDbHosts(connectionString);
  if (hosts.length === 0) {
    throw new Error('DATABASE_URL host could not be parsed for egress validation.');
  }
  const pinned = new Map<string, string>();
  for (const host of hosts) {
    // An allowlisted host is still RESOLVED AND PINNED — the exemption widens
    // which addresses are acceptable, never whether the socket is nailed to the
    // validated one, so DNS-rebind stays closed for exempted hosts too.
    const addresses = await resolveAllowedHostAddresses(
      host,
      'block-private',
      lookup,
      allowedHosts,
    );
    const first = addresses[0];
    if (first === undefined) {
      throw new Error(`DATABASE_URL host "${host}" produced no usable address.`);
    }
    pinned.set(host.toLowerCase(), first);
  }
  return pinned;
}

/** The slice of parsed postgres.js options the socket factory consumes. */
export interface PinnedSocketOptions {
  host: string[];
  port: number[];
}

/** Injected for tests; production uses a real TCP socket. */
export type MakeSocket = () => net.Socket;

const defaultMakeSocket: MakeSocket = () => {
  const net = dynamicRequire('node:net') as typeof import('node:net');
  return new net.Socket();
};

/**
 * Resolve-then-pin, step 2: a postgres.js `socket` factory that dials the
 * guard-validated IP directly, so the driver NEVER resolves the hostname itself
 * (closing the check→connect DNS-rebind TOCTOU, including across pool
 * reconnects). Mirrors the driver's own multi-host failover by rotating through
 * `options.host`/`options.port` exactly as its built-in connect() does. The
 * ORIGINAL hostname is kept on `socket.host`, which postgres.js reads as the TLS
 * `servername` — SNI-routed servers (and cert verification, when enabled) see
 * the configured name, not the pinned IP. Fails closed on any host the guard
 * didn't validate.
 */
export function createPinnedSocketFactory(
  pinned: ReadonlyMap<string, string>,
  makeSocket: MakeSocket = defaultMakeSocket,
): (options: PinnedSocketOptions) => net.Socket {
  let hostIndex = 0;
  return (options) => {
    const count = Math.max(options.host.length, 1);
    const i = hostIndex % count;
    hostIndex = (i + 1) % count;
    const rawHost = options.host[i] ?? '';
    // postgres.js keeps a single-host IPv6 literal bracketed (URL.hostname).
    const bareHost = rawHost.startsWith('[')
      ? rawHost.slice(1, rawHost.indexOf(']') === -1 ? rawHost.length : rawHost.indexOf(']'))
      : rawHost;
    const port = options.port[i] ?? options.port[0] ?? 5432;
    const address = pinned.get(bareHost.toLowerCase());
    if (address === undefined) {
      throw new Error(
        `DATABASE_URL host "${rawHost}" was not validated by the egress guard; refusing to connect.`,
      );
    }
    const socket = makeSocket();
    socket.connect(port, address);
    // postgres.js reads socket.host as the TLS servername (and its error paths
    // read socket.port); keep the ORIGINAL hostname, not the pinned IP.
    Object.assign(socket, { host: bareHost, port });
    return socket;
  };
}

/** postgres.js option overrides produced by the guard; empty under `allow-private`. */
export interface DbEgressHardening {
  ssl?: string;
  socket?: (options: PinnedSocketOptions) => net.Socket;
}

/**
 * The single block-private entry point: validate the connection string and
 * return the postgres.js option overrides that make the validation stick —
 * forced TLS (`requiredTlsMode`, checked first so a plaintext URL fails fast
 * without a DNS round-trip) and the pinning `socket` factory. Under
 * `allow-private` this behaves exactly like `assertConnectionStringAllowed`
 * (literal-only checks, no resolve, no overrides) so self-hosted keeps native
 * driver semantics (its own DNS, failover, and URL-controlled TLS).
 */
export async function buildDbEgressHardening(
  connectionString: string,
  policy: DbEgressPolicy,
  lookup: HostLookup = defaultLookup,
  makeSocket: MakeSocket = defaultMakeSocket,
  allowedHosts: readonly string[] = [],
): Promise<DbEgressHardening> {
  if (policy !== 'block-private') {
    await assertConnectionStringAllowed(connectionString, policy, lookup, allowedHosts);
    return {};
  }
  const ssl = requiredTlsMode(connectionString);
  const pinned = await resolvePinnedDbHosts(connectionString, lookup, allowedHosts);
  return { ssl, socket: createPinnedSocketFactory(pinned, makeSocket) };
}
