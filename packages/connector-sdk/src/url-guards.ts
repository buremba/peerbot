/**
 * URL validation for connector egress (SSRF guards + domain allowlists).
 */

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

  if (hostname === 'localhost' || hostname === '[::1]' || hostname.endsWith('.localhost')) {
    throw new Error(`URL must not point to localhost: ${hostname}`);
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 0
    ) {
      throw new Error(`URL must not point to a private/internal IP address: ${hostname}`);
    }
  }

  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    const linkLocalPrefix = /^fe[89ab][0-9a-f]?:/;
    const multicastPrefix = /^ff[0-9a-f]{2}:/;
    if (
      ipv6 === '::1' ||
      linkLocalPrefix.test(ipv6) ||
      multicastPrefix.test(ipv6) ||
      ipv6.startsWith('fc') ||
      ipv6.startsWith('fd') ||
      ipv6 === '::' ||
      ipv6.startsWith('::ffff:')
    ) {
      throw new Error(`URL must not point to a private/internal IPv6 address: ${hostname}`);
    }
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