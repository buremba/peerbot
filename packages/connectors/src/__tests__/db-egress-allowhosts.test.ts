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
