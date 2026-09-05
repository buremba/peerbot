import type { LookupAddress } from 'node:dns';
import dns from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { isReservedIp, normalizeIpLiteral, stripIpv6Brackets } from '@lobu/connector-sdk/ip-reachability';
import { Agent, buildConnector } from 'undici';

/**
 * The one Node egress transport for untrusted destinations.
 *
 * Policy (which hosts a caller may name) is `@lobu/connector-sdk/egress-policy`
 * and the IP classifier is `@lobu/connector-sdk/ip-reachability`; both are
 * pure. This module is the Node layer above them: DNS resolution, socket
 * pinning, and the credential transport rule. The gateway (its worker egress
 * proxy, the MCP proxy, OAuth and connector-operation fetches) and the
 * connector isolate lane's host `fetch` all dial through here, so a DNS
 * rebinding gap closed once is closed for every caller.
 *
 * `fetchPublicUrl` closes the check-then-fetch (TOCTOU) gap a plain predicate
 * leaves open: its connector resolves every hostname once, rejects the whole
 * answer set if any address is reserved, then hands one of those exact
 * validated addresses to the socket. Redirects stay on the same dispatcher, so
 * every hop gets the same treatment.
 *
 * `resolvePublicAddresses` is the same validation for callers that open their
 * own socket (the proxy's CONNECT tunnel): they dial an address it returned and
 * never re-resolve the name.
 *
 * `isInternalUrl` remains a plain predicate and still has that gap by
 * construction; prefer the transport whenever the point of the check is to then
 * make the request.
 */

/**
 * Raised when a target resolves to a reserved address.
 *
 * A distinct class rather than a message prefix: `findPrivateAddressError`
 * digs this out of the `cause` / `AggregateError` chain that Node's fetch wraps
 * connector failures in, and matching on message text would silently stop
 * working the first time someone reworded the string.
 */
export class PrivateAddressError extends Error {
  constructor(hostname: string) {
    super(`URL points to a private/internal address: ${hostname}`);
    this.name = 'PrivateAddressError';
  }
}

/** Raised for a target that looks like an IP literal but does not parse as one. */
export class MalformedHostError extends Error {
  constructor(hostname: string) {
    super(`Target host is not a valid address: ${hostname}`);
    this.name = 'MalformedHostError';
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
 * Reject a literal/private hostname before a socket is opened. DNS names are
 * resolved by {@link resolvePublicAddresses}; this synchronous check is still
 * needed because Node skips DNS lookup entirely for IP-literal redirect targets.
 */
function assertPublicHostname(rawHostname: string): void {
  const hostname = stripIpv6Brackets(rawHostname.toLowerCase());
  const normalized = normalizeIpLiteral(hostname);
  if (normalized.kind === 'invalid') throw new MalformedHostError(hostname);
  if (isReservedIp(hostname)) throw new PrivateAddressError(hostname);
  if (
    normalized.kind === 'not-ip' &&
    (hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal'))
  ) {
    throw new PrivateAddressError(hostname);
  }
}

/**
 * Resolve the complete answer set before selecting an address. Selecting a
 * public answer while silently ignoring a private sibling would let resolver
 * ordering determine the result and leave a rebinding path open.
 */
export type ResolveAllAddresses = (hostname: string) => Promise<LookupAddress[]>;

const systemLookup: ResolveAllAddresses = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Resolve `rawHostname` to the addresses a caller may dial.
 *
 * An IP literal is validated and returned in its canonical form (so an
 * IPv4-mapped or NAT64 spelling pins to the bare IPv4 that was checked); a name
 * is resolved once through `lookup` and the WHOLE answer set must be public.
 * Throws {@link MalformedHostError}, {@link PrivateAddressError} or
 * {@link DnsResolutionError}; callers map those to their own protocol.
 */
export async function resolvePublicAddresses(
  rawHostname: string,
  options: { lookup?: ResolveAllAddresses } = {},
): Promise<LookupAddress[]> {
  const hostname = stripIpv6Brackets(rawHostname);
  assertPublicHostname(hostname);
  const normalized = normalizeIpLiteral(hostname.toLowerCase());
  if (normalized.kind === 'ipv4' || normalized.kind === 'ipv6') {
    return [{ address: normalized.value, family: normalized.kind === 'ipv4' ? 4 : 6 }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await (options.lookup ?? systemLookup)(hostname);
  } catch (error) {
    throw new DnsResolutionError(hostname, error);
  }
  if (addresses.length === 0) {
    throw new DnsResolutionError(hostname, new Error('no addresses'));
  }
  for (const answer of addresses) {
    if (isReservedIp(answer.address)) {
      throw new PrivateAddressError(`${hostname} (${answer.address})`);
    }
  }
  return addresses;
}

function createGuardedLookup(resolveAll: ResolveAllAddresses = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    void resolvePublicAddresses(hostname, { lookup: resolveAll })
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

const guardedLookup = createGuardedLookup();
const connectToValidatedAddress = buildConnector({ lookup: guardedLookup });

type RuntimeConnector = ReturnType<typeof buildConnector>;

function connectPublicTarget(
  options: Parameters<RuntimeConnector>[0],
  callback: Parameters<RuntimeConnector>[1],
  connect: RuntimeConnector = connectToValidatedAddress,
): void {
  try {
    // Load-bearing for redirects to raw IP literals: net.connect bypasses
    // lookup for those, so the lookup callback alone is not a complete guard.
    assertPublicHostname(options.hostname);
  } catch (error) {
    callback(error instanceof Error ? error : new Error('Blocked outbound connection target'), null);
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
export const __egressTransportTestOnly = {
  connectPublicTarget,
  createGuardedLookup,
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
 * Fetch an untrusted public URL without a DNS check-then-fetch race.
 *
 * The dispatcher is retained for connection pooling, but every new connection
 * resolves through `guardedLookup`; a reused socket is already connected to a
 * previously validated address. Undici also uses the dispatcher for redirect
 * hops, including the literal-host check in the connector above.
 */
export async function fetchPublicUrl(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const parsed = input instanceof URL ? input : new URL(input);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
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
