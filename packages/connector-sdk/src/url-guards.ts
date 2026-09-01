/**
 * URL validation for connector egress (SSRF guards + domain allowlists).
 *
 * The IP classification comes from `./ip-reachability.ts`, the same module the
 * gateway proxy and the database egress guard use, so a connector's URL check
 * cannot be weaker than the guards behind it.
 */

import { isReservedIp, stripIpv6Brackets } from './ip-reachability.js';

export function validatePublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`URL must use http: or https: protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error(`URL must not point to localhost: ${hostname}`);
  }

  // WHATWG URL keeps IPv6 literals bracketed and already folds the decimal,
  // octal, and hex spellings of an IPv4 into dotted-quad, so the shared
  // classifier sees a canonical literal. A non-IP hostname returns false here
  // and is only checked by name — see the DNS caveat on this function.
  if (isReservedIp(stripIpv6Brackets(hostname))) {
    throw new Error(`URL must not point to a private/internal IP address: ${hostname}`);
  }

  if (
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.corp') ||
    hostname.endsWith('.lan')
  ) {
    throw new Error(`URL must not point to an internal hostname: ${hostname}`);
  }
}

export function validateUrlDomain(url: string, expectedDomain: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid ${expectedDomain} URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${expectedDomain} URL must use https: protocol, got ${parsed.protocol}`);
  }
  if (
    parsed.hostname !== expectedDomain &&
    !parsed.hostname.endsWith(`.${expectedDomain}`)
  ) {
    throw new Error(`URL must be on ${expectedDomain}, got ${parsed.hostname}`);
  }
}