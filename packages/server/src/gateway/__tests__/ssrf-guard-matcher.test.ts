import { describe, expect, test } from "bun:test";
import { isReservedIp } from "@lobu/connector-sdk/ip-reachability";

// The previous hand-rolled isReservedIp checked only ::1, fc/fd, 127/8, 10/8,
// 172.16/12, 192.168/16, 169.254/16. These pin the ranges/spellings it MISSED
// (the SSRF bypass surface) plus the ones it already caught.
describe("isReservedIp — hardened matcher", () => {
  test("newly-covered IPv4 ranges", () => {
    expect(isReservedIp("0.0.0.0")).toBe(true); // 0.0.0.0/8
    expect(isReservedIp("0.1.2.3")).toBe(true);
    expect(isReservedIp("100.64.0.1")).toBe(true); // CGNAT 100.64/10
    expect(isReservedIp("198.18.0.1")).toBe(true); // benchmark 198.18/15
    expect(isReservedIp("169.254.169.254")).toBe(true); // cloud metadata
    expect(isReservedIp("192.0.0.1")).toBe(true); // IETF protocol assignments
    expect(isReservedIp("192.0.2.1")).toBe(true); // TEST-NET-1
    expect(isReservedIp("192.88.99.2")).toBe(true); // 6a44 relay anycast
    expect(isReservedIp("198.51.100.1")).toBe(true); // TEST-NET-2
    expect(isReservedIp("203.0.113.1")).toBe(true); // TEST-NET-3
  });

  test("newly-covered IPv6 spellings", () => {
    expect(isReservedIp("::")).toBe(true); // unspecified
    expect(isReservedIp("fe80::1")).toBe(true); // link-local
    expect(isReservedIp("ff02::1")).toBe(true); // multicast
  });

  test("IANA non-global IPv6 ranges are blocked", () => {
    expect(isReservedIp("64:ff9b:1::808:808")).toBe(true); // local-use NAT64
    expect(isReservedIp("100::1")).toBe(true); // discard-only
    expect(isReservedIp("100:0:0:1::1")).toBe(true); // dummy IPv6 prefix
    expect(isReservedIp("2001:2::1")).toBe(true); // benchmarking
    expect(isReservedIp("2001:5::1")).toBe(true); // unassigned IETF protocol space
    expect(isReservedIp("2001:10::1")).toBe(true); // deprecated ORCHID
    expect(isReservedIp("2001:db8::1")).toBe(true); // documentation
    expect(isReservedIp("2002::1")).toBe(true); // deprecated 6to4
    expect(isReservedIp("3fff::1")).toBe(true); // documentation
    expect(isReservedIp("5f00::1")).toBe(true); // segment-routing SIDs
    expect(isReservedIp("fec0::1")).toBe(true); // deprecated site-local
    expect(isReservedIp("::127.0.0.1")).toBe(true); // deprecated IPv4-compatible
    expect(isReservedIp("4000::1")).toBe(true); // outside allocated 2000::/3
    expect(isReservedIp("64:ff9b:0:ffff::1")).toBe(true); // unallocated 0000::/8
    expect(isReservedIp("64:ff9b:2::1")).toBe(true); // outside both NAT64 prefixes
  });

  test("real IANA global exceptions are preserved", () => {
    expect(isReservedIp("192.0.0.9")).toBe(false); // PCP anycast
    expect(isReservedIp("192.0.0.10")).toBe(false); // TURN anycast
    expect(isReservedIp("192.31.196.1")).toBe(false); // AS112-v4
    expect(isReservedIp("192.52.193.1")).toBe(false); // AMT-v4
    expect(isReservedIp("192.175.48.1")).toBe(false); // direct AS112-v4
    expect(isReservedIp("2001:1::1")).toBe(false); // PCP anycast
    expect(isReservedIp("2001:1::2")).toBe(false); // TURN anycast
    expect(isReservedIp("2001:1::3")).toBe(false); // DNS-SD anycast
    expect(isReservedIp("2001:3::1")).toBe(false); // AMT is globally reachable
    expect(isReservedIp("2001:4:112::1")).toBe(false); // AS112-v6
    expect(isReservedIp("2001:20::1")).toBe(false); // ORCHIDv2
    expect(isReservedIp("2001:30::1")).toBe(false); // Drone Remote ID
    expect(isReservedIp("2620:4f:8000::1")).toBe(false); // direct AS112-v6
    expect(isReservedIp("2001:4860:4860::8888")).toBe(false);
  });

  test("IPv4-mapped IPv6 (dotted + hex) — the classic bypass", () => {
    expect(isReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isReservedIp("::ffff:10.0.0.1")).toBe(true);
  });

  // Until the three IP classifiers were consolidated, THIS gateway copy lacked
  // the IPv4-compatible unwrap that the database egress guard already had, so
  // dropping `ffff` from a mapped address walked straight past the guard.
  test("IPv4-compatible IPv6 (::a.b.c.d) — the gap the shared matcher closed", () => {
    expect(isReservedIp("::7f00:1")).toBe(true); // → 127.0.0.1
    expect(isReservedIp("::127.0.0.1")).toBe(true);
    expect(isReservedIp("::a9fe:a9fe")).toBe(true); // → 169.254.169.254
    expect(isReservedIp("::c0a8:101")).toBe(true); // → 192.168.1.1
    expect(isReservedIp("::808:808")).toBe(false); // → 8.8.8.8 (public)
  });

  test("zone IDs are stripped before the decision", () => {
    expect(isReservedIp("fe80::1%eth0")).toBe(true);
    expect(isReservedIp("::1%lo")).toBe(true);
  });

  test("ranges the old matcher already caught", () => {
    expect(isReservedIp("127.0.0.1")).toBe(true);
    expect(isReservedIp("::1")).toBe(true);
    expect(isReservedIp("10.0.0.1")).toBe(true);
    expect(isReservedIp("172.16.0.1")).toBe(true);
    expect(isReservedIp("192.168.1.1")).toBe(true);
    expect(isReservedIp("fc00::1")).toBe(true);
  });

  test("genuine public addresses are permitted", () => {
    expect(isReservedIp("8.8.8.8")).toBe(false);
    expect(isReservedIp("1.1.1.1")).toBe(false);
    expect(isReservedIp("::ffff:8.8.8.8")).toBe(false);
    expect(isReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isReservedIp("172.32.0.1")).toBe(false); // just outside 172.16/12
  });

  test("a malformed IP literal fails closed; a hostname is left for resolution", () => {
    expect(isReservedIp("::ffff:zzzz:1")).toBe(true); // looks like IPv6, won't parse
    expect(isReservedIp("not-an-ip.example.com")).toBe(false); // hostname → resolve later
  });

  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 in its trailing 32
  // bits. This is the spelling the MCP proxy's old regex guard missed (F10) —
  // both copies now share this matcher, so it's pinned in one place.
  test("NAT64 64:ff9b::/96 decodes to the embedded IPv4 and is judged on that", () => {
    expect(isReservedIp("64:ff9b::7f00:1")).toBe(true); // → 127.0.0.1
    expect(isReservedIp("64:ff9b::a9fe:a9fe")).toBe(true); // → 169.254.169.254
    expect(isReservedIp("64:ff9b:0:0:0:0:7f00:1")).toBe(true); // expanded form
    expect(isReservedIp("64:ff9b::808:808")).toBe(false); // → 8.8.8.8 (public)
  });
});
