import { describe, expect, test } from 'bun:test';
import { readEgressPolicy, requestedTlsMode, requiredTlsMode } from '../db-egress-guard.ts';

describe('readEgressPolicy', () => {
  test('block-private string', () => expect(readEgressPolicy('block-private')).toBe('block-private'));
  test('anything else → allow-private (trusted default)', () => {
    expect(readEgressPolicy('allow-private')).toBe('allow-private');
    expect(readEgressPolicy(undefined)).toBe('allow-private');
    expect(readEgressPolicy('')).toBe('allow-private');
    expect(readEgressPolicy('garbage')).toBe('allow-private');
  });
});

describe('requestedTlsMode — the mode the driver will apply, no policy attached', () => {
  test('is empty when the URL says nothing about TLS', () => {
    expect(requestedTlsMode('postgres://u:p@db.example.com:5432/x')).toBe('');
  });

  test('reports disable without throwing (policy is the caller\'s job)', () => {
    expect(requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=disable')).toBe('disable');
    expect(requestedTlsMode('postgres://u:p@db.example.com/x?ssl=false')).toBe('false');
  });

  test('reads the verifying modes the tenant asked for', () => {
    expect(requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=verify-ca')).toBe('verify-ca');
    expect(requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=VERIFY-FULL')).toBe(
      'verify-full'
    );
  });

  test('sslrootcert=system forces verify-full over any sslmode, as the driver does', () => {
    expect(
      requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslrootcert=system')
    ).toBe('verify-full');
    expect(
      requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=disable&sslrootcert=system')
    ).toBe('verify-full');
  });

  test('last duplicate key wins and sslmode beats ssl, matching postgres.js', () => {
    expect(
      requestedTlsMode('postgres://u:p@db.example.com/x?sslmode=require&sslmode=verify-full')
    ).toBe('verify-full');
    expect(
      requestedTlsMode('postgres://u:p@db.example.com/x?ssl=verify-full&sslmode=require')
    ).toBe('require');
  });
});

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
