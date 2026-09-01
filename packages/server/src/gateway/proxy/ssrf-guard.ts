import dns from "node:dns/promises";
import {
  isReservedIp,
  stripIpv6Brackets,
} from "@lobu/connector-sdk/ip-reachability";

/**
 * DNS-resolving SSRF check used by the MCP proxy (gateway/auth/mcp/proxy.ts).
 *
 * The IP-literal classifier itself lives in `@lobu/connector-sdk/ip-reachability`
 * so the gateway, the database egress guard, and the connector SDK's URL guard
 * all reach the same verdict. This module is the server's DNS layer on top of it.
 *
 * NOTE: `isInternalUrl` resolves the host and checks the answers, but the caller
 * then issues a separate `fetch` that re-resolves the name. That check-then-fetch
 * gap is a DNS-rebinding (TOCTOU) window this module does not yet close — the
 * fix is to pin the connection to the validated IP (a pinned-`fetch` primitive).
 * Tracked as a follow-up.
 */

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
