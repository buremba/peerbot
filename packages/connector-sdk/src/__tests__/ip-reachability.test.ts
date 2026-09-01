import { describe, expect, test } from 'bun:test';
import {
  isReservedIp,
  normalizeIpLiteral,
  stripIpv6Brackets,
} from '../ip-reachability.ts';
import { validatePublicUrl } from '../url-guards.ts';

/**
 * This module replaced three separate IP classifiers: the gateway's
 * `ssrf-guard.ts`, the database `db-egress-guard.ts`, and the regex block that
 * used to live inline in `validatePublicUrl`. The cases below pin the union of
 * what those three enforced, so no consumer silently loses a check.
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
