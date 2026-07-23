import { describe, expect, test } from 'bun:test';
import {
  assertHostAllowed,
  type DbEgressPolicy,
  type HostLookup,
  parseAllowedHosts,
  resolveAllowedHostAddresses,
} from '../db-egress-guard.ts';

const fakeLookup =
  (addresses: string[]): HostLookup =>
  async () =>
    addresses.map((address) => ({ address }));

const BLOCK: DbEgressPolicy = 'block-private';

describe('parseAllowedHosts', () => {
  test('parses a comma-separated list, trimming and dropping blanks', () => {
    expect(parseAllowedHosts(' 100.127.177.56 , db.example.com ,, ')).toEqual([
      '100.127.177.56',
      'db.example.com',
    ]);
  });
  test('undefined / empty yields no entries', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('   ')).toEqual([]);
  });
});

describe('allow-hosts bypass — the Tailscale case', () => {
  test('CGNAT literal is blocked under block-private WITHOUT an allowlist', async () => {
    await expect(assertHostAllowed('100.127.177.56', BLOCK)).rejects.toThrow(
      /blocked internal\/metadata address/,
    );
  });

  test('CGNAT literal is permitted when explicitly allowlisted', async () => {
    await expect(
      assertHostAllowed('100.127.177.56', BLOCK, undefined, ['100.127.177.56']),
    ).resolves.toBeUndefined();
  });

  test('an allowlisted hostname resolving into CGNAT is permitted and pinned', async () => {
    const addrs = await resolveAllowedHostAddresses(
      'mac.tailnet.ts.net',
      BLOCK,
      fakeLookup(['100.127.177.56']),
      ['mac.tailnet.ts.net'],
    );
    expect(addrs).toEqual(['100.127.177.56']);
  });
});

describe('allow-hosts must NOT become a universal bypass', () => {
  test('a DIFFERENT private host is still blocked while one host is allowlisted', async () => {
    await expect(
      assertHostAllowed('10.0.0.5', BLOCK, undefined, ['100.127.177.56']),
    ).rejects.toThrow(/blocked internal\/metadata address/);
  });

  test('cloud metadata stays blocked even when explicitly allowlisted', async () => {
    await expect(
      assertHostAllowed('169.254.169.254', BLOCK, undefined, ['169.254.169.254']),
    ).rejects.toThrow(/blocked internal\/metadata address/);
  });

  test('an allowlisted hostname resolving to metadata is still blocked', async () => {
    await expect(
      assertHostAllowed('evil.example.com', BLOCK, fakeLookup(['169.254.169.254']), [
        'evil.example.com',
      ]),
    ).rejects.toThrow();
  });
});

describe('parseAllowedHosts — malformed entries fail loudly at parse time', () => {
  test('a CIDR entry is rejected (a range is never an exact host)', () => {
    expect(() => parseAllowedHosts('100.64.0.0/10')).toThrow(/CIDR|exact host/i);
  });
  test('a wildcard entry is rejected', () => {
    expect(() => parseAllowedHosts('*.ts.net')).toThrow(/wildcard|exact host/i);
  });
  test('an entry with a port is rejected (hosts are matched without a port)', () => {
    expect(() => parseAllowedHosts('10.0.0.5:5432')).toThrow(/port|exact host/i);
  });
  test('a bracketed IPv6 entry is rejected (extractDbHosts strips brackets)', () => {
    expect(() => parseAllowedHosts('[fd00::1]')).toThrow(/bracket|exact host/i);
  });
  test('a valid mixed list still parses', () => {
    expect(parseAllowedHosts('100.127.177.56, db.corp, fd00::1')).toEqual([
      '100.127.177.56',
      'db.corp',
      'fd00::1',
    ]);
  });
});

/**
 * The allowlist is matched against the RAW host string from DATABASE_URL, while
 * the range check normalizes (IPv4-mapped/NAT64/zone-id). That asymmetry is
 * DELIBERATE and fails CLOSED: an alternate spelling of an allowlisted address
 * misses the allowlist and stays blocked. Locked in so a future "normalize
 * before matching" refactor cannot silently open the NAT64/IPv4-mapped path.
 */
describe('raw-vs-normalized asymmetry is intentional and fails closed', () => {
  const ALLOW = ['100.127.177.56'];
  for (const spelling of [
    '::ffff:100.127.177.56',
    '64:ff9b::100.127.177.56',
    '100.127.177.56%eth0',
  ]) {
    test(`${spelling} does NOT inherit the allowlist entry for 100.127.177.56`, async () => {
      await expect(assertHostAllowed(spelling, BLOCK, undefined, ALLOW)).rejects.toThrow();
    });
  }
});
