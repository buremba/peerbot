import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { canonicalizeHostname } from '@lobu/connector-sdk/egress-policy';
import {
  type EgressAddressPolicy,
  ipFamily,
  isBlockedIp,
  normalizeIpLiteral,
  stripIpv6Brackets,
} from '@lobu/connector-sdk/ip-reachability';
import { Agent, buildConnector } from 'undici';

/**
 * The one Node egress transport for untrusted destinations.
 *
 * Policy (which hosts a caller may name) is `@lobu/connector-sdk/egress-policy`
 * and the IP classifier plus address policy is
 * `@lobu/connector-sdk/ip-reachability`; both are pure. This module is the
 * Node layer above them: DNS resolution, socket pinning, and the credential
 * transport rule. The gateway dials through here for all of it — its worker
 * egress proxy, the MCP proxy, OAuth and connector-operation fetches — and so
 * does the connector isolate lane, for the guest's `fetch` (via
 * {@link fetchPublicUrl} on a per-executor {@link EgressDispatcher}) and for
 * the raw sockets the DB connectors open (via {@link resolveEgressAddresses}).
 * A DNS rebinding gap closed once is closed for every one of them.
 *
 * `fetchPublicUrl` closes the check-then-fetch (TOCTOU) gap a plain predicate
 * leaves open: its connector resolves every hostname once, rejects the whole
 * answer set if any address is refused, then hands one of those exact
 * validated addresses to the socket. Redirects stay on the same dispatcher, so
 * every hop gets the same treatment.
 *
 * `resolveEgressAddresses` is the same validation for callers that open their
 * own socket (the proxy's CONNECT tunnel, the isolate's `socketOpen`): they
 * dial an address it returned and never re-resolve the name.
 *
 * The address axis ({@link EgressAddressOptions}) is what differs between
 * callers: the gateway refuses every reserved address; a self-hosted database
 * run may reach private space under `allow-private`; an operator exemption
 * lowers ONE exact host to that floor. Cloud metadata stays refused under all
 * of them.
 *
 * `isInternalUrl` remains a plain predicate and still has that gap by
 * construction; prefer the transport whenever the point of the check is to then
 * make the request.
 */

/**
 * Raised when a target is, or resolves to, an address the policy refuses.
 *
 * A distinct class rather than a message prefix: `findPrivateAddressError`
 * digs this out of the `cause` / `AggregateError` chain that Node's fetch wraps
 * connector failures in, and matching on message text would silently stop
 * working the first time someone reworded the string. `hostname` is the name
 * the caller asked for; `address` is the refused DNS answer, or `null` when
 * the hostname itself was the refused literal or internal name.
 */
export class PrivateAddressError extends Error {
  readonly hostname: string;
  readonly address: string | null;

  constructor(hostname: string, address?: string) {
    super(`URL points to a private/internal address: ${hostname}${address ? ` (${address})` : ''}`);
    this.name = 'PrivateAddressError';
    this.hostname = hostname;
    this.address = address ?? null;
  }
}

/** Raised for a target that looks like an IP literal but does not parse as one. */
export class MalformedHostError extends Error {
  readonly hostname: string;

  constructor(hostname: string) {
    super(`Target host is not a valid address: ${hostname}`);
    this.name = 'MalformedHostError';
    this.hostname = hostname;
  }
}

/** Raised when the resolver fails or returns no address for a name. */
export class DnsResolutionError extends Error {
  constructor(hostname: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`DNS lookup failed for ${hostname}: ${detail}`);
    this.name = 'DnsResolutionError';
    this.cause = cause;
  }
}

/**
 * Resolve the complete answer set before selecting an address. Selecting a
 * public answer while silently ignoring a private sibling would let resolver
 * ordering determine the result and leave a rebinding path open.
 */
export type ResolveAllAddresses = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;

const systemLookup: ResolveAllAddresses = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** The address axis of an egress decision; see the module header. */
export interface EgressAddressOptions {
  /** Which reserved space may be dialled. Default: `block-private`. */
  addressPolicy?: EgressAddressPolicy;
  /**
   * Exact hostnames or IP literals lowered to the `allow-private` floor — an
   * operator naming its own database, or a run whose allowlist names
   * `localhost`. Never below the floor: metadata stays refused for them too.
   */
  exemptHosts?: readonly string[];
  /** The resolver; the system one by default. Tests stage answers here. */
  lookup?: ResolveAllAddresses;
}

interface ResolvedEgressOptions {
  addressPolicy: EgressAddressPolicy;
  exemptHosts: ReadonlySet<string>;
  lookup: ResolveAllAddresses;
}

/** One canonical spelling for matching and resolving: lowercased, punycoded, no trailing dot, no IPv6 brackets. */
function canonicalHost(rawHostname: string): string {
  return stripIpv6Brackets(canonicalizeHostname(rawHostname));
}

function resolveEgressOptions(options: EgressAddressOptions): ResolvedEgressOptions {
  return {
    addressPolicy: options.addressPolicy ?? 'block-private',
    exemptHosts: new Set((options.exemptHosts ?? []).map(canonicalHost)),
    lookup: options.lookup ?? systemLookup,
  };
}

function effectivePolicy(hostname: string, egress: ResolvedEgressOptions): EgressAddressPolicy {
  return egress.exemptHosts.has(hostname) ? 'allow-private' : egress.addressPolicy;
}

/**
 * Names that never denote a public endpoint. Refusing them by name under
 * `block-private` gives the same answer as resolving them, one round trip
 * earlier, and an internal name that happens to resolve publicly no longer
 * gets through. Under `allow-private` they are ordinary names: `db.local` is
 * the normal shape of a self-hosted database.
 */
const INTERNAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.corp', '.lan', '.home'];

function isInternalName(hostname: string): boolean {
  return hostname === 'localhost' || INTERNAL_NAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Refuse a literal or internal hostname before a socket is opened. DNS names
 * are resolved by {@link resolveEgressAddresses}; this synchronous check is
 * still needed because Node skips DNS lookup entirely for IP-literal redirect
 * targets. Takes the canonical hostname.
 */
function assertReachableHostname(hostname: string, egress: ResolvedEgressOptions): void {
  const policy = effectivePolicy(hostname, egress);
  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === 'invalid') throw new MalformedHostError(hostname);
  if (normalized.kind !== 'not-ip') {
    if (isBlockedIp(normalized.value, policy)) throw new PrivateAddressError(hostname);
    return;
  }
  if (policy === 'block-private' && isInternalName(hostname)) throw new PrivateAddressError(hostname);
}

async function resolveWith(rawHostname: string, egress: ResolvedEgressOptions): Promise<LookupAddress[]> {
  const hostname = canonicalHost(rawHostname);
  assertReachableHostname(hostname, egress);
  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === 'ipv4' || normalized.kind === 'ipv6') {
    return [{ address: normalized.value, family: normalized.kind === 'ipv4' ? 4 : 6 }];
  }
  const policy = effectivePolicy(hostname, egress);
  let answers: ReadonlyArray<{ address: string }>;
  try {
    answers = await egress.lookup(hostname);
  } catch (error) {
    throw new DnsResolutionError(hostname, error);
  }
  if (answers.length === 0) {
    throw new DnsResolutionError(hostname, new Error('no addresses'));
  }
  const addresses: LookupAddress[] = [];
  for (const answer of answers) {
    const literal = normalizeIpLiteral(stripIpv6Brackets(answer.address));
    if (literal.kind === 'not-ip') {
      throw new DnsResolutionError(hostname, new Error(`resolver returned a non-address: ${answer.address}`));
    }
    if (literal.kind === 'invalid' || isBlockedIp(literal.value, policy)) {
      throw new PrivateAddressError(hostname, answer.address);
    }
    // Canonical form out (an IPv4-mapped or NAT64 spelling pins to the bare
    // IPv4 that was checked), so the socket dials exactly what was validated.
    addresses.push({ address: literal.value, family: literal.kind === 'ipv4' ? 4 : 6 });
  }
  return addresses;
}

/**
 * Resolve `rawHostname` to the addresses a caller may dial under `options`.
 *
 * An IP literal is validated and returned in its canonical form; a name is
 * resolved once through `lookup` and the WHOLE answer set must pass the
 * policy. Throws {@link MalformedHostError}, {@link PrivateAddressError} or
 * {@link DnsResolutionError}; callers map those to their own protocol.
 */
export async function resolveEgressAddresses(
  rawHostname: string,
  options: EgressAddressOptions = {},
): Promise<LookupAddress[]> {
  return resolveWith(rawHostname, resolveEgressOptions(options));
}

/**
 * Parse an operator-supplied exemption list: comma-separated EXACT hosts
 * (`LOBU_DB_EGRESS_ALLOW_HOSTS`). Deployment config only — it rides the
 * gateway-authoritative config path and is never settable from tenant or
 * connection config, so a tenant cannot widen its own boundary. An entry
 * matches a host exactly (IPv6 without brackets); no wildcards or CIDRs, so
 * approving one tailnet host never approves `100.64.0.0/10`. Shapes that can
 * never match are rejected here rather than left silently inactive; `source`
 * names the setting in that error.
 */
export function parseExemptHosts(value: unknown, source: string): string[] {
  if (typeof value !== 'string') return [];
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    const reason = unusableExemptHostReason(entry);
    if (reason) {
      throw new Error(
        `${source} entry "${entry}" is invalid: ${reason}. Use the exact bare host (no CIDR, wildcard, port, or IPv6 brackets).`,
      );
    }
  }
  return entries;
}

/** Why an exemption entry can never match a host, if so. */
function unusableExemptHostReason(entry: string): string | null {
  if (entry.includes('/')) return 'a CIDR range is not an exact host';
  if (entry.includes('*')) return 'a wildcard is not an exact host';
  if (entry.startsWith('[') || entry.endsWith(']')) return 'brackets are stripped from IPv6 hosts before matching';
  // A bare IPv6 literal legitimately contains `:` — only flag a trailing `:port`.
  if (ipFamily(entry) === 0 && /:\d+$/.test(entry)) return 'a :port is not part of the host';
  return null;
}

function createGuardedLookup(egress: ResolvedEgressOptions): LookupFunction {
  return (hostname, options, callback) => {
    void resolveWith(hostname, egress)
      .then((addresses) => {
        if (typeof options === 'object' && options.all) {
          (callback as unknown as (error: null, value: LookupAddress[]) => void)(null, addresses);
          return;
        }
        const selected = addresses[0]!;
        (callback as unknown as (error: null, address: string, family: number) => void)(
          null,
          selected.address,
          selected.family,
        );
      })
      .catch((error: unknown) => {
        (callback as unknown as (error: NodeJS.ErrnoException, address?: string, family?: number) => void)(
          error instanceof Error ? error : new Error(`DNS lookup failed for ${hostname}`),
        );
      });
  };
}

type RuntimeConnector = ReturnType<typeof buildConnector>;

function createGuardedConnector(
  egress: ResolvedEgressOptions,
  connect: RuntimeConnector = buildConnector({ lookup: createGuardedLookup(egress) }),
): RuntimeConnector {
  return (options, callback) => {
    try {
      // Load-bearing for redirects to raw IP literals: net.connect bypasses
      // lookup for those, so the lookup callback alone is not a complete guard.
      assertReachableHostname(canonicalHost(options.hostname), egress);
    } catch (error) {
      callback(error instanceof Error ? error : new Error('Blocked outbound connection target'), null);
      return;
    }
    // Forward the original options object unchanged. In particular, TLS SNI
    // remains the URL hostname even though lookup pins the socket to a validated
    // numeric address.
    connect(options, callback);
  };
}

/**
 * An undici dispatcher whose every new connection resolves through the guarded
 * lookup and re-checks literal targets at connect time; a reused socket is
 * already connected to a previously validated address. One per address
 * policy: the gateway shares the default (block-private, no exemptions) and
 * the isolate lane builds one per executor carrying that run's exact allowlist
 * entries. Nominal on purpose — `fetchPublicUrl` accepts only a dispatcher
 * built here, never an arbitrary undici Agent.
 */
export class EgressDispatcher extends Agent {
  private readonly egress: ResolvedEgressOptions;

  constructor(options: EgressAddressOptions = {}) {
    const egress = resolveEgressOptions(options);
    super({ connect: createGuardedConnector(egress) });
    this.egress = egress;
  }

  /** Throw before a request leaves if `hostname` can never be dialled under this dispatcher's policy. */
  assertReachable(hostname: string): void {
    assertReachableHostname(canonicalHost(hostname), this.egress);
  }
}

const defaultDispatcher = new EgressDispatcher();

/** Narrow transport seams exposed only for dependency-free regression tests. */
export const __egressTransportTestOnly = {
  createGuardedConnector,
  createGuardedLookup,
  resolveEgressOptions,
};

/**
 * Surface the security decision itself so callers and operators can tell a
 * blocked target from a transient upstream outage: Node's fetch wraps connector
 * failures in `TypeError("fetch failed")`.
 */
function findPrivateAddressError(error: unknown): Error | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof PrivateAddressError || candidate instanceof MalformedHostError) return candidate;
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause) {
      pending.push(candidate.cause);
    }
  }
  return null;
}

/**
 * Fetch an untrusted URL without a DNS check-then-fetch race. Every new
 * connection resolves through the dispatcher's guarded lookup, and undici uses
 * the same dispatcher for redirect hops, including the literal-host check in
 * the connector above. The default dispatcher is the gateway's block-private
 * one; the isolate lane passes its own.
 */
export async function fetchPublicUrl(
  input: string | URL,
  init: RequestInit = {},
  dispatcher: EgressDispatcher = defaultDispatcher,
): Promise<Response> {
  const parsed = input instanceof URL ? input : new URL(input);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  dispatcher.assertReachable(parsed.hostname);
  const requestInit = {
    ...init,
    dispatcher,
  } as unknown as RequestInit;
  try {
    return await fetch(parsed, requestInit);
  } catch (error) {
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
    throw new Error('Credential-bearing request URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Credential-bearing requests require HTTPS');
  }
  return parsed;
}

/** Apply the HTTPS credential policy before entering the public URL transport. */
export async function fetchCredentialedPublicUrl(input: string | URL, init: RequestInit = {}): Promise<Response> {
  if (init.redirect === 'follow') {
    throw new Error('Credential-bearing requests cannot automatically follow redirects');
  }
  return fetchPublicUrl(parseCredentialedHttpsUrl(input), {
    ...init,
    redirect: init.redirect ?? 'error',
  });
}

/**
 * Resolve a URL's hostname and check whether it points to an internal/reserved
 * network. Returns true (blocked) when URL parsing fails.
 */
export async function isInternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    // WHATWG URL keeps IPv6 literals bracketed (`[::1]`); strip so the classifier sees them.
    const hostname = stripIpv6Brackets(parsed.hostname);

    if (isBlockedIp(hostname, 'block-private')) return true;

    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);

    for (const addr of [...addresses, ...addresses6]) {
      if (isBlockedIp(addr, 'block-private')) return true;
    }

    return false;
  } catch {
    return true;
  }
}
