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

// ---------------------------------------------------------------------------
// Cloud hardening: forced TLS + resolve-then-pin (block-private only)
// ---------------------------------------------------------------------------

import {
  buildDbEgressHardening,
  createPinnedSocketFactory,
  requiredTlsMode,
  resolvePinnedDbHosts,
} from '../db-egress-guard.ts';

/** Records connect() calls instead of dialing; shaped like net.Socket enough for the factory. */
class FakeSocket {
  connects: Array<{ port: number; address: string }> = [];
  host?: string;
  port?: number;
  connect(port: number, address: string): this {
    this.connects.push({ port, address });
    return this;
  }
}
const fakeSocketFactory = (created: FakeSocket[]) => () => {
  const s = new FakeSocket();
  created.push(s);
  return s as unknown as import('node:net').Socket;
};

describe('requiredTlsMode — forced TLS under block-private', () => {
  test('rejects sslmode=disable with a clear error', () => {
    expect(() => requiredTlsMode('postgres://u:p@db.example.com:5432/x?sslmode=disable')).toThrow(
      /TLS is required/i
    );
  });

  test('rejects ssl=false and ssl=disable (postgres.js aliases)', () => {
    expect(() => requiredTlsMode('postgres://u:p@db.example.com/x?ssl=false')).toThrow(
      /TLS is required/i
    );
    expect(() => requiredTlsMode('postgres://u:p@db.example.com/x?ssl=disable')).toThrow(
      /TLS is required/i
    );
  });

  test('forces "require" when the URL says nothing about TLS', () => {
    expect(requiredTlsMode('postgres://u:p@db.example.com:5432/x')).toBe('require');
  });

  test('upgrades the weak modes (allow/prefer) to "require"', () => {
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=allow')).toBe('require');
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=prefer')).toBe('require');
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require')).toBe('require');
  });

  test('never downgrades verify-ca / verify-full', () => {
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=verify-ca')).toBe('verify-ca');
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=verify-full')).toBe(
      'verify-full'
    );
  });

  // postgres.js applies `sslrootcert=system` LAST and unconditionally forces
  // ssl=verify-full (connection.js), overriding sslmode. Our returned value is
  // authoritative in openGuardedPool (explicit ssl beats the URL), so it must
  // report verify-full too — otherwise a system-CA URL is silently DOWNGRADED
  // to require, disabling certificate verification (MITM exposure).
  test('sslrootcert=system forces verify-full (no downgrade to require)', () => {
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?sslrootcert=system')).toBe(
      'verify-full'
    );
    // sslmode=require alone would resolve to require; sslrootcert=system upgrades it.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslrootcert=system')
    ).toBe('verify-full');
    // postgres.js applies it even over sslmode=disable, so we must not reject as plaintext.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=disable&sslrootcert=system')
    ).toBe('verify-full');
  });

  // postgres.js parses via `new URL()`: the fragment (`#...`) is NOT part of the
  // query, so `sslrootcert=system#frag` still reads `system` and forces
  // verify-full. A naive `?`-slice would fold `#frag` into the value and
  // silently DOWNGRADE to require — the fragment must be stripped first.
  test('URL fragment does not downgrade sslrootcert=system (WHATWG semantics)', () => {
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslrootcert=system#frag')
    ).toBe('verify-full');
    // Fragment after another param must not corrupt the last param either.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslrootcert=system#frag')
    ).toBe('verify-full');
    // A fragment carrying an sslmode-looking string must be ignored, not parsed.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=verify-full#sslmode=disable')
    ).toBe('verify-full');
    // `#` BEFORE `?`: the `?` lives inside the fragment, so there is NO query.
    // A `sslmode=disable` after such a `?` must NOT be parsed (and must not
    // throw as plaintext) — new URL() treats the whole tail as fragment.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x#label?sslmode=disable')
    ).toBe('require');
    // Same, with an sslrootcert in the fragment: it must not force verify-full.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x#frag?sslrootcert=system')
    ).toBe('require');
  });

  test('sslmode beats a contradictory ssl param (postgres.js precedence)', () => {
    expect(() =>
      requiredTlsMode('postgres://u:p@db.example.com/x?ssl=require&sslmode=disable')
    ).toThrow(/TLS is required/i);
  });

  // postgres.js reduces searchParams last-wins on duplicate keys. Reading the
  // FIRST value would DOWNGRADE the strict TLS the driver actually applies.
  test('duplicate sslmode: LAST value wins (no TLS downgrade)', () => {
    // Driver would apply verify-full; we must not report require and downgrade it.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslmode=verify-full')
    ).toBe('verify-full');
    // Last value require ⇒ require (not a downgrade; both encrypt).
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=verify-full&sslmode=require')
    ).toBe('require');
  });

  test('duplicate sslmode: a trailing disable is rejected (matches driver)', () => {
    expect(() =>
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslmode=disable')
    ).toThrow(/TLS is required/i);
  });

  test('duplicate ssl (no sslmode): LAST value wins', () => {
    expect(requiredTlsMode('postgres://u:p@db.example.com/x?ssl=require&ssl=verify-full')).toBe(
      'verify-full'
    );
  });

  test('sslrootcert other than system does not force verify-full', () => {
    // A non-"system" sslrootcert (e.g. a file path) does not trigger the driver
    // override, so normal sslmode resolution applies.
    expect(
      requiredTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslrootcert=/etc/ca.pem')
    ).toBe('require');
  });
});

describe('resolvePinnedDbHosts — resolve-then-pin', () => {
  test('pins a hostname to its first validated address', async () => {
    const pinned = await resolvePinnedDbHosts(
      'postgres://u:p@db.example.com:5432/x',
      fakeLookup(['93.184.216.34', '93.184.216.35'])
    );
    expect(pinned.get('db.example.com')).toBe('93.184.216.34');
  });

  test('an IP-literal host pins to its normalized form', async () => {
    const pinned = await resolvePinnedDbHosts('postgres://u:p@8.8.8.8:5432/x', fakeLookup([]));
    expect(pinned.get('8.8.8.8')).toBe('8.8.8.8');
    // IPv4-mapped IPv6 collapses to the v4 it hides.
    const mapped = await resolvePinnedDbHosts(
      'postgres://u:p@[::ffff:8.8.8.8]:5432/x',
      fakeLookup([])
    );
    expect(mapped.get('::ffff:8.8.8.8')).toBe('8.8.8.8');
  });

  test('throws when ANY resolved address is blocked (multi-record rebind)', async () => {
    await expect(
      resolvePinnedDbHosts(
        'postgres://u:p@evil.example.com/x',
        fakeLookup(['93.184.216.34', '169.254.169.254'])
      )
    ).rejects.toThrow(/blocked internal\/metadata/i);
  });

  test('multi-host URL pins every host', async () => {
    const byHost: Record<string, string[]> = {
      h1: ['8.8.8.8'],
      h2: ['1.1.1.1'],
    };
    const lookup: HostLookup = async (host) =>
      (byHost[host] ?? []).map((address) => ({ address }));
    const pinned = await resolvePinnedDbHosts('postgres://u:p@h1:5432,h2:5433/x', lookup);
    expect(pinned.get('h1')).toBe('8.8.8.8');
    expect(pinned.get('h2')).toBe('1.1.1.1');
  });

  test('fails closed on an unparseable authority', async () => {
    await expect(resolvePinnedDbHosts('host=localhost dbname=x', fakeLookup([]))).rejects.toThrow(
      /could not be parsed/i
    );
  });
});

describe('createPinnedSocketFactory — the socket dials the pinned IP, never re-resolves', () => {
  test('dials the pinned address but keeps the ORIGINAL hostname on socket.host (TLS SNI)', () => {
    const created: FakeSocket[] = [];
    const factory = createPinnedSocketFactory(
      new Map([['db.example.com', '93.184.216.34']]),
      fakeSocketFactory(created)
    );
    const s = factory({ host: ['db.example.com'], port: [5432] }) as unknown as FakeSocket;
    expect(s.connects).toEqual([{ port: 5432, address: '93.184.216.34' }]);
    expect(s.host).toBe('db.example.com');
    expect(s.port).toBe(5432);
  });

  test('rotates across a multi-host URL with per-host ports (failover parity)', () => {
    const created: FakeSocket[] = [];
    const factory = createPinnedSocketFactory(
      new Map([
        ['h1', '8.8.8.8'],
        ['h2', '1.1.1.1'],
      ]),
      fakeSocketFactory(created)
    );
    const opts = { host: ['h1', 'h2'], port: [5432, 5433] };
    factory(opts);
    factory(opts);
    factory(opts);
    expect(created.map((s) => s.connects[0])).toEqual([
      { port: 5432, address: '8.8.8.8' },
      { port: 5433, address: '1.1.1.1' },
      { port: 5432, address: '8.8.8.8' },
    ]);
  });

  test('strips IPv6 brackets and matches host case-insensitively', () => {
    const created: FakeSocket[] = [];
    const factory = createPinnedSocketFactory(
      new Map([
        ['2606:4700:4700::1111', '2606:4700:4700::1111'],
        ['db.example.com', '93.184.216.34'],
      ]),
      fakeSocketFactory(created)
    );
    const s1 = factory({
      host: ['[2606:4700:4700::1111]'],
      port: [5432],
    }) as unknown as FakeSocket;
    expect(s1.connects).toEqual([{ port: 5432, address: '2606:4700:4700::1111' }]);
    const s2 = factory({ host: ['DB.Example.COM'], port: [5432] }) as unknown as FakeSocket;
    expect(s2.connects).toEqual([{ port: 5432, address: '93.184.216.34' }]);
  });

  test('fails closed for a host the guard never validated', () => {
    const factory = createPinnedSocketFactory(
      new Map([['db.example.com', '93.184.216.34']]),
      fakeSocketFactory([])
    );
    expect(() => factory({ host: ['other.example.com'], port: [5432] })).toThrow(
      /not validated/i
    );
  });
});

describe('buildDbEgressHardening — policy plumbing', () => {
  test('allow-private: no overrides, and a hostname is NOT resolved', async () => {
    let calls = 0;
    const counting: HostLookup = async () => {
      calls++;
      return [{ address: '10.0.0.5' }];
    };
    const hardening = await buildDbEgressHardening(
      'postgres://u:p@internal.db.local:5432/x',
      ALLOW,
      counting
    );
    expect(hardening.ssl).toBeUndefined();
    expect(hardening.socket).toBeUndefined();
    expect(calls).toBe(0);
  });

  test('allow-private still rejects a metadata IP literal', async () => {
    await expect(
      buildDbEgressHardening('postgres://u:p@169.254.169.254:5432/x', ALLOW, fakeLookup([]))
    ).rejects.toThrow(/blocked/i);
  });

  test('block-private: returns forced TLS + a pinning socket factory', async () => {
    const hardening = await buildDbEgressHardening(
      'postgres://u:p@db.example.com:5432/x',
      BLOCK,
      fakeLookup(['93.184.216.34'])
    );
    expect(hardening.ssl).toBe('require');
    expect(typeof hardening.socket).toBe('function');
  });

  test('block-private: sslmode=disable is rejected BEFORE any DNS resolution', async () => {
    let calls = 0;
    const counting: HostLookup = async () => {
      calls++;
      return [{ address: '93.184.216.34' }];
    };
    await expect(
      buildDbEgressHardening('postgres://u:p@db.example.com/x?sslmode=disable', BLOCK, counting)
    ).rejects.toThrow(/TLS is required/i);
    expect(calls).toBe(0);
  });

  test('DNS rebind after validation cannot move the socket (pin holds, no re-resolve)', async () => {
    // A "rebinding" resolver: first answer is a clean public IP, every later
    // answer is the metadata IP. The guard resolves ONCE at build time; every
    // socket the pool opens afterwards must dial the first (validated) answer.
    let calls = 0;
    const rebinding: HostLookup = async () => {
      calls++;
      return [{ address: calls === 1 ? '93.184.216.34' : '169.254.169.254' }];
    };
    const created: FakeSocket[] = [];
    const hardening = await buildDbEgressHardening(
      'postgres://u:p@rebind.example.com:5432/x',
      BLOCK,
      rebinding,
      fakeSocketFactory(created)
    );
    const opts = { host: ['rebind.example.com'], port: [5432] };
    hardening.socket?.(opts);
    hardening.socket?.(opts);
    expect(calls).toBe(1);
    expect(created.map((s) => s.connects[0]?.address)).toEqual([
      '93.184.216.34',
      '93.184.216.34',
    ]);
  });
});
