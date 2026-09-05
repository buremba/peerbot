import { describe, expect, test } from 'bun:test';
import {
  type EgressAddressPolicy,
  isBlockedIp,
  isReservedIp,
  normalizeIpLiteral,
  stripIpv6Brackets,
} from '../ip-reachability.ts';
import { validatePublicUrl } from '../url-guards.ts';

/**
 * This module replaced three separate IP classifiers: the gateway's egress
 * transport (now `@lobu/connector-worker/egress`), the database connectors'
 * former host-side guard, and the regex block that used to live inline in
 * `validatePublicUrl`. The cases below pin the union of what those three
 * enforced, so no consumer silently loses a check. The `isBlockedIp` cases
 * further down are the database guard's policy matrix, moved here with it.
 */

describe('normalizeIpLiteral collapses evasion spellings', () => {
  test('plain IPv4 passes through', () => {
    expect(normalizeIpLiteral('127.0.0.1')).toEqual({
      kind: 'ipv4',
      value: '127.0.0.1',
    });
  });

  test('IPv4-mapped IPv6 unwraps, dotted and hex', () => {
    expect(normalizeIpLiteral('::ffff:127.0.0.1')).toEqual({
      kind: 'ipv4',
      value: '127.0.0.1',
    });
    expect(normalizeIpLiteral('::ffff:7f00:1')).toEqual({
      kind: 'ipv4',
      value: '127.0.0.1',
    });
  });

  // Regression: the gateway copy of this classifier lacked this branch, so
  // swapping `::ffff:` for `::` reached cloud metadata unblocked.
  test('IPv4-compatible IPv6 unwraps (::a.b.c.d)', () => {
    expect(normalizeIpLiteral('::7f00:1')).toEqual({
      kind: 'ipv4',
      value: '127.0.0.1',
    });
    expect(normalizeIpLiteral('::a9fe:a9fe')).toEqual({
      kind: 'ipv4',
      value: '169.254.169.254',
    });
    expect(normalizeIpLiteral('::192.168.1.1')).toEqual({
      kind: 'ipv4',
      value: '192.168.1.1',
    });
  });

  test('`::` and `::1` are NOT unwrapped to 0.0.0.0 / 0.0.0.1', () => {
    expect(normalizeIpLiteral('::')).toEqual({ kind: 'ipv6', value: '::' });
    expect(normalizeIpLiteral('::1')).toEqual({ kind: 'ipv6', value: '::1' });
  });

  test('NAT64 well-known prefix unwraps', () => {
    expect(normalizeIpLiteral('64:ff9b::7f00:1')).toEqual({
      kind: 'ipv4',
      value: '127.0.0.1',
    });
  });

  test('zone IDs are stripped', () => {
    expect(normalizeIpLiteral('fe80::1%eth0')).toEqual({
      kind: 'ipv6',
      value: 'fe80::1',
    });
  });

  test('a DNS name is not-ip; an IP-shaped non-parse is invalid', () => {
    expect(normalizeIpLiteral('example.com')).toEqual({ kind: 'not-ip' });
    expect(normalizeIpLiteral('::ffff:zz:1')).toEqual({ kind: 'invalid' });
    expect(normalizeIpLiteral('%eth0')).toEqual({ kind: 'invalid' });
  });
});

describe('isReservedIp', () => {
  const reserved = [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    // every spelling of loopback / metadata the guards must collapse
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '::a9fe:a9fe',
    '64:ff9b::7f00:1',
  ];
  for (const ip of reserved) {
    test(`blocks ${ip}`, () => expect(isReservedIp(ip)).toBe(true));
  }

  const publicAddrs = ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '93.184.216.34'];
  for (const ip of publicAddrs) {
    test(`allows public ${ip}`, () => expect(isReservedIp(ip)).toBe(false));
  }

  test('fails closed on an IP-shaped value that will not parse', () => {
    expect(isReservedIp('::ffff:zz:1')).toBe(true);
  });

  test('a DNS name is not reserved (caller resolves, then re-checks)', () => {
    expect(isReservedIp('example.com')).toBe(false);
  });

  test('does not strip brackets itself — callers must', () => {
    expect(isReservedIp('[::1]')).toBe(true); // fails closed as `invalid`
    expect(isReservedIp(stripIpv6Brackets('[2001:4860:4860::8888]'))).toBe(false);
  });
});

describe('validatePublicUrl rejects what the shared classifier blocks', () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://2130706433/', // decimal — WHATWG folds it to 127.0.0.1
    'http://0x7f000001/', // hex
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:7f00:1]/',
    'http://[::7f00:1]/', // IPv4-compatible IPv6
    'http://[64:ff9b::7f00:1]/', // NAT64
    'http://224.0.0.1/', // multicast
    'http://255.255.255.255/', // broadcast
    'http://198.18.0.1/', // benchmarking
    'http://localhost/',
    'http://foo.internal/',
  ];
  for (const url of blocked) {
    test(`rejects ${url}`, () => expect(() => validatePublicUrl(url)).toThrow());
  }

  const allowed = [
    'https://example.com/feed.xml',
    'https://news.ycombinator.com/rss',
    'http://8.8.8.8/',
    'https://[2001:4860:4860::8888]/',
  ];
  for (const url of allowed) {
    test(`allows ${url}`, () => expect(() => validatePublicUrl(url)).not.toThrow());
  }

  test('still rejects non-http(s) schemes', () => {
    expect(() => validatePublicUrl('file:///etc/passwd')).toThrow(/protocol/);
    expect(() => validatePublicUrl('gopher://example.com/')).toThrow(/protocol/);
  });
});

// ---------------------------------------------------------------------------
// The address POLICY axis: `block-private` is exactly the reserved set above;
// `allow-private` drops to a floor that still refuses metadata / link-local,
// multicast, reserved and the unspecified address. Cloud-metadata endpoints
// that sit inside ranges the floor permits are refused under both.
// ---------------------------------------------------------------------------

const BLOCK: EgressAddressPolicy = 'block-private';
const ALLOW: EgressAddressPolicy = 'allow-private';

describe('isBlockedIp — metadata / link-local / unspecified / multicast (blocked under BOTH)', () => {
  const both = [
    '169.254.169.254', // cloud metadata
    '169.254.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1', // multicast
    '::', // unspecified
    'fe80::1', // link-local
    'ff02::1', // multicast
    '64:ff9b::a9fe:a9fe', // NAT64-wrapped 169.254.169.254
  ];
  for (const ip of both) {
    test(`${ip} blocked under block-private`, () => expect(isBlockedIp(ip, BLOCK)).toBe(true));
    test(`${ip} blocked under allow-private`, () => expect(isBlockedIp(ip, ALLOW)).toBe(true));
  }
});

describe('isBlockedIp — loopback (blocked on cloud, ALLOWED self-hosted)', () => {
  const loopback = ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];
  for (const ip of loopback) {
    test(`${ip} blocked under block-private`, () => expect(isBlockedIp(ip, BLOCK)).toBe(true));
    test(`${ip} allowed under allow-private`, () => expect(isBlockedIp(ip, ALLOW)).toBe(false));
  }
});

describe('isBlockedIp — RFC1918 / CGNAT / ULA (blocked on cloud, ALLOWED self-hosted)', () => {
  const priv = [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '100.127.255.255',
    'fc00::1', // ULA
    'fd12::1',
  ];
  for (const ip of priv) {
    test(`${ip} blocked under block-private`, () => expect(isBlockedIp(ip, BLOCK)).toBe(true));
    test(`${ip} allowed under allow-private`, () => expect(isBlockedIp(ip, ALLOW)).toBe(false));
  }
});

describe('isBlockedIp — boundaries are NOT private', () => {
  // Just outside RFC1918 172.16/12 and CGNAT 100.64/10.
  const publicEdges = ['172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1'];
  for (const ip of publicEdges) {
    test(`${ip} public under block-private`, () => expect(isBlockedIp(ip, BLOCK)).toBe(false));
    test(`${ip} public under allow-private`, () => expect(isBlockedIp(ip, ALLOW)).toBe(false));
  }
});

describe('isBlockedIp — genuine public addresses pass under both', () => {
  const pub = ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700:4700::1111'];
  for (const ip of pub) {
    test(`${ip} not blocked (block-private)`, () => expect(isBlockedIp(ip, BLOCK)).toBe(false));
    test(`${ip} not blocked (allow-private)`, () => expect(isBlockedIp(ip, ALLOW)).toBe(false));
  }
});

describe('isBlockedIp — IANA global-reachability matrix', () => {
  const nonGlobal = [
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.2',
    '198.51.100.1',
    '203.0.113.1',
    '100::1',
    '100:0:0:1::1',
    '64:ff9b:1::808:808',
    '2001:2::1',
    '2001:5::1',
    '2001:10::1',
    '2001:db8::1',
    '2002::1',
    '3fff::1',
    '5f00::1',
    'fec0::1',
    '::127.0.0.1',
    '4000::1',
  ];
  for (const ip of nonGlobal) {
    test(`${ip} is blocked under block-private`, () =>
      expect(isBlockedIp(ip, BLOCK)).toBe(true)
    );
  }

  const globalExceptions = [
    '192.0.0.9',
    '192.0.0.10',
    '192.31.196.1',
    '192.52.193.1',
    '192.175.48.1',
    '2001:1::1',
    '2001:1::2',
    '2001:1::3',
    '2001:3::1',
    '2001:4:112::1',
    '2001:20::1',
    '2001:30::1',
    '2620:4f:8000::1',
    '64:ff9b::808:808',
  ];
  for (const ip of globalExceptions) {
    test(`${ip} stays reachable under block-private`, () =>
      expect(isBlockedIp(ip, BLOCK)).toBe(false)
    );
  }

  test('allow-private keeps its trusted self-hosted semantics', () => {
    expect(isBlockedIp('203.0.113.1', ALLOW)).toBe(false);
    expect(isBlockedIp('2001:db8::1', ALLOW)).toBe(false);
    expect(isBlockedIp('64:ff9b:1::808:808', ALLOW)).toBe(false);
  });
});

describe('isBlockedIp — IPv4-compatible IPv6 (::a.b.c.d) is unwrapped, not bypassed', () => {
  // ::7f00:1 = 127.0.0.1 (loopback); ::a9fe:a9fe = 169.254.169.254 (metadata).
  test('::7f00:1 normalizes to 127.0.0.1', () =>
    expect(normalizeIpLiteral('::7f00:1')).toEqual({ kind: 'ipv4', value: '127.0.0.1' }));
  test('::a9fe:a9fe (metadata) blocked under BOTH', () => {
    expect(isBlockedIp('::a9fe:a9fe', BLOCK)).toBe(true);
    expect(isBlockedIp('::a9fe:a9fe', ALLOW)).toBe(true);
  });
  test('::7f00:1 (loopback) blocked on cloud, allowed self-hosted', () => {
    expect(isBlockedIp('::7f00:1', BLOCK)).toBe(true);
    expect(isBlockedIp('::7f00:1', ALLOW)).toBe(false);
  });
  test(':: and ::1 are NOT mis-unwrapped', () => {
    expect(normalizeIpLiteral('::')).toEqual({ kind: 'ipv6', value: '::' });
    expect(normalizeIpLiteral('::1')).toEqual({ kind: 'ipv6', value: '::1' });
    expect(isBlockedIp('::1', ALLOW)).toBe(false); // v6 loopback allowed self-hosted
    expect(isBlockedIp('::1', BLOCK)).toBe(true);
  });
});

describe('isBlockedIp — fail closed on malformed IP-looking literals', () => {
  for (const bad of ['::ffff:zzzz:1', '64:ff9b::nope', 'fe80::g%eth0']) {
    test(`${bad} treated as blocked (block-private)`, () => expect(isBlockedIp(bad, BLOCK)).toBe(true));
    test(`${bad} treated as blocked (allow-private)`, () => expect(isBlockedIp(bad, ALLOW)).toBe(true));
  }
  // A bare hostname is not an IP literal → not blocked here (the transport resolves it and re-checks every answer).
  test('hostname is not blocked by isBlockedIp', () => expect(isBlockedIp('db.example.com', BLOCK)).toBe(false));
});
