/**
 * Encrypt/decrypt round-trip tests for the connection-config helpers in
 * postgres-stores.ts. Pins the fix for the prefix asymmetry: encrypt now
 * tags ciphertext with `enc:v1:` and decrypt strips it before delegating
 * to @lobu/core's AES-GCM `decrypt()`.
 */

import { describe, expect, it } from 'vitest';
import { encrypt } from '@lobu/core';
import { decryptConfig, encryptConfig } from '../postgres-stores';

describe('postgres-stores connection-config encryption', () => {
  it('round-trips secret fields through encrypt + decrypt', () => {
    const original = {
      platform: 'slack',
      botToken: 'xoxb-real-secret-value',
      signingSecret: 'shhhh',
      allowGroups: true,
    };

    const encrypted = encryptConfig(original);

    // Secret fields are tagged with the version prefix and no longer match
    // the plaintext.
    expect(typeof encrypted.botToken).toBe('string');
    expect(encrypted.botToken).not.toBe(original.botToken);
    expect(encrypted.botToken.startsWith('enc:v1:')).toBe(true);
    expect(encrypted.signingSecret.startsWith('enc:v1:')).toBe(true);

    // Non-secret fields are untouched.
    expect(encrypted.platform).toBe('slack');
    expect(encrypted.allowGroups).toBe(true);

    const decrypted = decryptConfig(encrypted);

    expect(decrypted).toEqual(original);
  });

  it('skips already-encrypted secret values on a second encryptConfig pass', () => {
    const original = { token: 'plaintext-token' };
    const once = encryptConfig(original);
    const twice = encryptConfig(once);

    // Idempotent: a second encryption pass leaves the already-prefixed
    // ciphertext alone instead of double-encrypting.
    expect(twice.token).toBe(once.token);
    expect(decryptConfig(twice).token).toBe('plaintext-token');
  });

  it('decryptConfig leaves prefixless values untouched (treated as plaintext)', () => {
    // A bare `iv:tag:ciphertext` value (the legacy shape produced by the
    // pre-fix encryptConfig) does NOT start with `enc:v1:`, so decryptConfig
    // returns it as-is. The migration is what re-prefixes those rows; this
    // assertion locks in the runtime contract that any non-prefixed string
    // is treated as opaque plaintext.
    const rawCipher = encrypt('would-be-plaintext');
    const result = decryptConfig({ token: rawCipher, platform: 'slack' });

    expect(result.token).toBe(rawCipher);
    expect(result.platform).toBe('slack');
  });

  it('decryptConfig returns the original plaintext for prefixed values', () => {
    const ciphertext = encrypt('super-secret');
    const result = decryptConfig({ token: `enc:v1:${ciphertext}` });

    expect(result.token).toBe('super-secret');
  });

  it('decryptConfig leaves an undecryptable prefixed value alone', () => {
    // Garbage after the prefix shouldn't crash decryptConfig — the inner
    // try/catch swallows the failure and the caller still gets a value
    // back (the original prefixed string), matching the pre-fix contract.
    const result = decryptConfig({ token: 'enc:v1:not-real-ciphertext' });
    expect(result.token).toBe('enc:v1:not-real-ciphertext');
  });

  it('encryptConfig only touches secret-named fields', () => {
    const input = {
      platform: 'telegram',
      // Not a secret-shaped key name — should pass through untouched.
      label: 'team-prod',
      // Secret-shaped names — should be encrypted.
      botToken: 'tg-token',
      apiKey: 'ak',
      authorization: 'Bearer xyz',
    };

    const encrypted = encryptConfig(input);

    expect(encrypted.platform).toBe('telegram');
    expect(encrypted.label).toBe('team-prod');
    expect(encrypted.botToken.startsWith('enc:v1:')).toBe(true);
    expect(encrypted.apiKey.startsWith('enc:v1:')).toBe(true);
    expect(encrypted.authorization.startsWith('enc:v1:')).toBe(true);
  });
});
