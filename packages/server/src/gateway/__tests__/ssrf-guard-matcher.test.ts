import { describe, expect, test } from "bun:test";
import { isReservedIp } from "../proxy/ssrf-guard.js";

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
  });

  test("newly-covered IPv6 spellings", () => {
    expect(isReservedIp("::")).toBe(true); // unspecified
    expect(isReservedIp("fe80::1")).toBe(true); // link-local
    expect(isReservedIp("ff02::1")).toBe(true); // multicast
  });

  test("IPv4-mapped IPv6 (dotted + hex) — the classic bypass", () => {
    expect(isReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isReservedIp("::ffff:7f00:1")).toBe(true);
    expect(isReservedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isReservedIp("::ffff:10.0.0.1")).toBe(true);
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
