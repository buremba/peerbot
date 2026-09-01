import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import {
  isReservedIp,
  normalizeIpLiteral,
  stripIpv6Brackets,
} from "@lobu/connector-sdk/ip-reachability";
import { Agent, buildConnector } from "undici";

/**
 * Server-side egress transport for untrusted URLs.
 *
 * The IP-literal classifier lives in `@lobu/connector-sdk/ip-reachability` so
 * the gateway, the database egress guard, and the connector SDK's URL guard all
 * reach the same verdict. This module is the layer above it: DNS resolution,
 * socket pinning, and the credential policy.
 *
 * `fetchPublicUrl` closes the DNS-rebinding (TOCTOU) gap that a plain
 * check-then-fetch leaves open. Its connector resolves every hostname once,
 * rejects the whole answer set if any address is reserved, then hands one of
 * those exact validated addresses to the socket. Redirects stay on the same
 * dispatcher, so every hop gets the same treatment.
 *
 * `isInternalUrl` remains a plain predicate and still has that gap by
 * construction: it answers a question and returns, and the caller then opens
 * its own connection. Prefer `fetchPublicUrl` whenever the point of the check
 * is to then make the request.
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
    this.name = "PrivateAddressError";
  }
}

function privateAddressError(hostname: string): Error {
  return new PrivateAddressError(hostname);
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
    if (candidate instanceof PrivateAddressError) return candidate;
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
