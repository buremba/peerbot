import dns from "node:dns/promises";

/**
 * Check whether a resolved IP address belongs to a reserved/internal range.
 *
 * Shared between the MCP proxy (gateway/auth/mcp/proxy.ts) and the MCP OAuth
 * discovery module (gateway/auth/mcp/oauth-discovery.ts) so both enforce
 * identical rules without duplicating logic.
 */
export function isReservedIp(ip: string): boolean {
  // IPv6 loopback
  if (ip === "::1") return true;

  // IPv6 unique local (fc00::/7)
  if (/^f[cd]/i.test(ip)) return true;

  // IPv4
  const parts = ip.split(".").map(Number);
  if (parts.length === 4) {
    const [a, b] = parts as [number, number, number, number];
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
  }

  return false;
}

/**
 * Resolve a URL's hostname and check whether it points to an internal/reserved network.
 * Returns true (blocked) when URL parsing fails.
 */
export async function isInternalUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Check if hostname is already an IP literal
    if (isReservedIp(hostname)) return true;

    // Resolve hostname to IP addresses
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);

    for (const addr of [...addresses, ...addresses6]) {
      if (isReservedIp(addr)) return true;
    }

    return false;
  } catch {
    // If URL parsing fails, block it
    return true;
  }
}
