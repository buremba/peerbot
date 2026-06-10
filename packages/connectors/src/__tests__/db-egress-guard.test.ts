import { describe, expect, test } from 'bun:test';
import {
  assertConnectionStringAllowed,
  assertHostAllowed,
  type DbEgressPolicy,
  extractDbHosts,
  type HostLookup,
  isBlockedIp,
  normalizeIpLiteral,
  readEgressPolicy,
} from '../db-egress-guard.ts';

/** A fake DNS resolver: hostname → fixed address list. */
const fakeLookup =
  (addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address }));

const BLOCK: DbEgressPolicy = 'block-private';
const ALLOW: DbEgressPolicy = 'allow-private';

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

describe('normalizeIpLiteral — brackets, zone ids, mapped/NAT64', () => {
  test('strips zone id', () => expect(normalizeIpLiteral('fe80::1%eth0')).toEqual({ kind: 'ipv6', value: 'fe80::1' }));
  test('::ffff: dotted → ipv4', () => expect(normalizeIpLiteral('::ffff:127.0.0.1')).toEqual({ kind: 'ipv4', value: '127.0.0.1' }));
  test('NAT64 → ipv4', () => expect(normalizeIpLiteral('64:ff9b::7f00:1')).toEqual({ kind: 'ipv4', value: '127.0.0.1' }));
  test('hostname → not-ip', () => expect(normalizeIpLiteral('db.example.com')).toEqual({ kind: 'not-ip' }));
  test('garbage with colon → invalid', () => expect(normalizeIpLiteral('64:ff9b::nope').kind).toBe('invalid'));
});

describe('isBlockedIp — fail closed on malformed IP-looking literals', () => {
  for (const bad of ['::ffff:zzzz:1', '64:ff9b::nope', 'fe80::g%eth0']) {
    test(`${bad} treated as blocked (block-private)`, () => expect(isBlockedIp(bad, BLOCK)).toBe(true));
    test(`${bad} treated as blocked (allow-private)`, () => expect(isBlockedIp(bad, ALLOW)).toBe(true));
  }
  // A bare hostname is not an IP literal → not blocked here (resolved by assertHostAllowed).
  test('hostname is not blocked by isBlockedIp', () => expect(isBlockedIp('db.example.com', BLOCK)).toBe(false));
});

describe('readEgressPolicy', () => {
  test('block-private string', () => expect(readEgressPolicy('block-private')).toBe('block-private'));
  test('anything else → allow-private (trusted default)', () => {
    expect(readEgressPolicy('allow-private')).toBe('allow-private');
    expect(readEgressPolicy(undefined)).toBe('allow-private');
    expect(readEgressPolicy('')).toBe('allow-private');
    expect(readEgressPolicy('garbage')).toBe('allow-private');
  });
});

describe('assertHostAllowed — IP literals', () => {
  test('public literal passes (both)', async () => {
    await expect(assertHostAllowed('8.8.8.8', BLOCK)).resolves.toBeUndefined();
    await expect(assertHostAllowed('8.8.8.8', ALLOW)).resolves.toBeUndefined();
  });
  test('loopback literal: passes allow-private, throws block-private', async () => {
    await expect(assertHostAllowed('127.0.0.1', ALLOW)).resolves.toBeUndefined();
    await expect(assertHostAllowed('127.0.0.1', BLOCK)).rejects.toThrow(/blocked internal\/metadata/i);
  });
  test('metadata literal throws under both', async () => {
    await expect(assertHostAllowed('169.254.169.254', ALLOW)).rejects.toThrow(/blocked/i);
    await expect(assertHostAllowed('169.254.169.254', BLOCK)).rejects.toThrow(/blocked/i);
  });
});

describe('assertHostAllowed — hostname resolution (injected resolver)', () => {
  test('hostname resolving to a public IP passes', async () => {
    await expect(
      assertHostAllowed('db.example.com', BLOCK, fakeLookup(['93.184.216.34']))
    ).resolves.toBeUndefined();
  });

  test('hostname resolving to ANY blocked IP throws (multi-record rebind)', async () => {
    await expect(
      assertHostAllowed('rebind.example.com', BLOCK, fakeLookup(['93.184.216.34', '169.254.169.254']))
    ).rejects.toThrow(/resolves to a blocked/i);
  });

  test('hostname resolving to RFC1918: allowed self-hosted, blocked on cloud', async () => {
    await expect(
      assertHostAllowed('internal.db', ALLOW, fakeLookup(['10.1.2.3']))
    ).resolves.toBeUndefined();
    await expect(
      assertHostAllowed('internal.db', BLOCK, fakeLookup(['10.1.2.3']))
    ).rejects.toThrow(/resolves to a blocked/i);
  });

  test('a failed DNS lookup throws a clear (credential-free) error', async () => {
    const failing: HostLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertHostAllowed('nope.invalid', BLOCK, failing)).rejects.toThrow(
      /could not be resolved/i
    );
  });
});

describe('extractDbHosts — host parsing for the egress guard', () => {
  test('single host with port + creds', () =>
    expect(extractDbHosts('postgres://u:p@db.example.com:5432/x')).toEqual(['db.example.com']));
  test('password containing @ uses the LAST @', () =>
    expect(extractDbHosts('postgres://u:p@ss@db.example.com:5432/x')).toEqual(['db.example.com']));
  test('IPv6 bracket host', () =>
    expect(extractDbHosts('postgres://u:p@[::1]:5432/x')).toEqual(['::1']));
  test('multi-host failover URL → every host', () =>
    expect(extractDbHosts('postgres://u:p@h1:5432,169.254.169.254:5432/x')).toEqual([
      'h1',
      '169.254.169.254',
    ]));
  test('no port', () => expect(extractDbHosts('postgres://u:p@plainhost/x')).toEqual(['plainhost']));
  test('no authority (unix socket form) → []', () =>
    expect(extractDbHosts('postgres:///mydb?host=/tmp')).toEqual([]));
  test('non-URL key=value string → []', () =>
    expect(extractDbHosts('host=localhost dbname=x')).toEqual([]));
});

describe('assertConnectionStringAllowed — multi-host + policy', () => {
  test('block-private rejects a multi-host URL where ANY host is metadata (literals, no DNS)', async () => {
    await expect(
      assertConnectionStringAllowed('postgres://u:p@8.8.8.8,169.254.169.254:5432/x', BLOCK)
    ).rejects.toThrow(/blocked internal\/metadata/i);
  });

  test('allow-private does NOT DNS-resolve a hostname multi-host URL (no failover regression)', async () => {
    // The injected lookup throws if called — proving allow-private skips hostnames.
    const explodingLookup: HostLookup = async () => {
      throw new Error('lookup must not be called under allow-private for a hostname');
    };
    await expect(
      assertConnectionStringAllowed(
        'postgres://u:p@a.example.com,b.example.com:5432/x',
        ALLOW,
        explodingLookup
      )
    ).resolves.toBeUndefined();
  });

  test('block-private fails closed when no host can be parsed; allow-private skips it', async () => {
    await expect(
      assertConnectionStringAllowed('postgres:///mydb?host=/tmp', BLOCK)
    ).rejects.toThrow(/could not be parsed/i);
    await expect(
      assertConnectionStringAllowed('postgres:///mydb?host=/tmp', ALLOW)
    ).resolves.toBeUndefined();
  });
});
