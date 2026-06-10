import { afterEach, describe, expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import {
  isBlockedIpAddress,
  resolveUrlToSafeAddress,
  setIpBlocklistDnsLookup,
  setSsrfFetchImpl,
  SsrfBlockedError,
  ssrfSafeFetch,
} from "../proxy/ip-blocklist.js";

// Regression coverage for the MCP-proxy SSRF / reserved-IP guard.
//
// Before the fix the MCP proxy used a hand-rolled `isReservedIp` matcher that
// missed:
//   - 0.0.0.0/8           (the unspecified / "this host" range)
//   - IPv6 unspecified `::`
//   - IPv4-mapped IPv6 `::ffff:a.b.c.d` (loopback, link-local metadata, RFC1918)
// and was DNS-rebinding-vulnerable (validated the host, then `fetch`
// re-resolved it). The proper fix routes the MCP proxy through the same
// hardened blocklist used by the egress proxy and pins the connection to the
// single validated IP.

afterEach(() => {
  setIpBlocklistDnsLookup(null);
  setSsrfFetchImpl(null);
});

describe("isBlockedIpAddress — payloads the old MCP matcher missed", () => {
  test("blocks 0.0.0.0/8 (unspecified range)", () => {
    expect(isBlockedIpAddress("0.0.0.0")).toBe(true);
    expect(isBlockedIpAddress("0.1.2.3")).toBe(true);
  });

  test("blocks IPv6 unspecified ::", () => {
    expect(isBlockedIpAddress("::")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 loopback (dotted + hex)", () => {
    expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:7f00:1")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 link-local cloud metadata", () => {
    expect(isBlockedIpAddress("::ffff:169.254.169.254")).toBe(true);
  });

  test("blocks IPv4-mapped IPv6 RFC1918 private ranges", () => {
    expect(isBlockedIpAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:172.16.0.1")).toBe(true);
  });

  test("still blocks the ranges the old matcher already caught", () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("10.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
  });

  test("permits genuine public addresses", () => {
    expect(isBlockedIpAddress("8.8.8.8")).toBe(false);
    expect(isBlockedIpAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedIpAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("resolveUrlToSafeAddress — host-literal URLs", () => {
  test("blocks an internal IP literal in the URL host", async () => {
    const r = await resolveUrlToSafeAddress("http://0.0.0.0/mcp");
    expect(r.ok).toBe(false);
  });

  test("blocks a bracketed IPv4-mapped IPv6 loopback literal", async () => {
    const r = await resolveUrlToSafeAddress("http://[::ffff:127.0.0.1]/mcp");
    expect(r.ok).toBe(false);
  });

  test("pins a public IP literal to itself", async () => {
    const r = await resolveUrlToSafeAddress("https://8.8.8.8/mcp");
    expect(r).toMatchObject({ ok: true, address: "8.8.8.8" });
  });
});

describe("resolveUrlToSafeAddress — DNS rebinding (TOCTOU)", () => {
  test("blocks a hostname that resolves to a private IP", async () => {
    setIpBlocklistDnsLookup(
      async (): Promise<LookupAddress[]> => [
        { address: "10.1.2.3", family: 4 },
      ],
    );
    const r = await resolveUrlToSafeAddress("https://internal.example/mcp");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("10.1.2.3");
  });

  test("resolves the host once and returns the validated public IP to pin", async () => {
    // First answer is the validated public IP; a later flip to loopback (the
    // rebinding payload) must never be used because the caller connects to the
    // returned `address`, not by re-resolving the name.
    let calls = 0;
    setIpBlocklistDnsLookup(async (): Promise<LookupAddress[]> => {
      calls += 1;
      return calls === 1
        ? [{ address: "203.0.113.7", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });

    const r = await resolveUrlToSafeAddress("https://rebind.example/mcp");
    expect(calls).toBe(1);
    expect(r).toMatchObject({ ok: true, address: "203.0.113.7" });
  });

  test("blocks when ANY resolved answer is internal (split-horizon)", async () => {
    setIpBlocklistDnsLookup(
      async (): Promise<LookupAddress[]> => [
        { address: "203.0.113.7", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    );
    const r = await resolveUrlToSafeAddress("https://mixed.example/mcp");
    expect(r.ok).toBe(false);
  });
});

// ssrfSafeFetch follows redirects MANUALLY and re-validates every hop. The
// pinned connect.lookup only fires for hostnames, so without per-hop
// revalidation a 3xx whose Location is an IP literal (e.g. the cloud metadata
// service) would bypass the guard entirely. These tests drive the redirect
// path through the fetch test-seam (the pinned dispatcher always connects to
// the validated IP, so a real loopback test server is unreachable here).
describe("ssrfSafeFetch — redirect re-validation", () => {
  test("rejects a redirect whose Location points at an internal IP literal", async () => {
    // First hop resolves to a public IP (no real DNS).
    setIpBlocklistDnsLookup(async () => [{ address: "203.0.113.1", family: 4 }]);
    let calls = 0;
    setSsrfFetchImpl(async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      });
    });

    let blocked = false;
    try {
      await ssrfSafeFetch("http://entry.example/");
    } catch (e) {
      blocked = e instanceof SsrfBlockedError;
    }
    expect(blocked).toBe(true);
    // The metadata host is rejected by re-validation BEFORE a second fetch.
    expect(calls).toBe(1);
  });

  test("follows a redirect to a public host and returns the final response", async () => {
    setIpBlocklistDnsLookup(async () => [{ address: "203.0.113.1", family: 4 }]);
    setSsrfFetchImpl(async (url) => {
      if (url.includes("first.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://second.example/done" },
        });
      }
      return new Response("final", { status: 200 });
    });

    const res = await ssrfSafeFetch("http://first.example/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final");
  });

  test("rejects an over-long redirect chain", async () => {
    setIpBlocklistDnsLookup(async () => [{ address: "203.0.113.1", family: 4 }]);
    // Always redirect to another public host — never terminates.
    let n = 0;
    setSsrfFetchImpl(async () => {
      n++;
      return new Response(null, {
        status: 302,
        headers: { location: `http://hop${n}.example/` },
      });
    });

    let blocked = false;
    try {
      await ssrfSafeFetch("http://start.example/");
    } catch (e) {
      blocked = e instanceof SsrfBlockedError;
    }
    expect(blocked).toBe(true);
  });
});
