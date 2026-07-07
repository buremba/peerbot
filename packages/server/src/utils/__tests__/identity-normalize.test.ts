import {
  normalizeAuthUserId,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
} from '@lobu/connector-sdk/identity-normalize';
import { describe, expect, it } from 'vitest';

describe('normalizePhone', () => {
  it('strips non-digit characters and returns the digit-only string', () => {
    expect(normalizePhone('+1 (415) 555-1234')).toBe('14155551234');
    expect(normalizePhone('1-415-555-1234')).toBe('14155551234');
    expect(normalizePhone('14155551234')).toBe('14155551234');
    expect(normalizePhone('  +14155551234  ')).toBe('14155551234');
  });

  it('rejects values outside the E.164 digit range', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('1234567890123456')).toBeNull();
    expect(normalizePhone('not-a-phone')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims valid email addresses', () => {
    expect(normalizeEmail('  Emr.E@Rakam.io ')).toBe('emr.e@rakam.io');
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('rejects malformed emails', () => {
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('@missing-local.com')).toBeNull();
    expect(normalizeEmail('missing-domain@')).toBeNull();
    expect(normalizeEmail('missing-tld@example')).toBeNull();
    expect(normalizeEmail('double@@at.com')).toBeNull();
    expect(normalizeEmail('spaces in@email.com')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('normalizeAuthUserId', () => {
  it('trims but preserves case to match Better Auth ids', () => {
    expect(normalizeAuthUserId('  abc123 ')).toBe('abc123');
    expect(normalizeAuthUserId('ABC123')).toBe('ABC123');
  });

  it('rejects empty or non-string', () => {
    expect(normalizeAuthUserId('')).toBeNull();
    expect(normalizeAuthUserId(null)).toBeNull();
  });
});

describe('normalizeIdentifier dispatcher', () => {
  it('dispatches generic cross-channel namespaces', () => {
    expect(normalizeIdentifier('phone', '+1 (415) 555-1234')).toBe('14155551234');
    expect(normalizeIdentifier('email', 'Foo@Bar.COM')).toBe('foo@bar.com');
    expect(normalizeIdentifier('auth_user_id', '  abc123 ')).toBe('abc123');
  });

  it('trim-only falls back for connector-owned namespaces the SDK no longer registers', () => {
    // These namespaces moved to their connector packages. The SDK generic
    // dispatcher only knows the generic set, so it applies trim hygiene and
    // leaves the real normalization to the connector module (chained upstream
    // of this dispatcher at the server ingest seam).
    expect(normalizeIdentifier('github_login', 'Octocat')).toBe('Octocat');
    expect(normalizeIdentifier('slack_user_id', 't0abc:u123')).toBe('t0abc:u123');
    expect(normalizeIdentifier('x_user_id', '00123')).toBe('00123');
    expect(normalizeIdentifier('x_handle', '@Alice')).toBe('@Alice');
  });

  it('falls back to trim-only for unknown namespaces so custom identities still get hygiene', () => {
    expect(normalizeIdentifier('stripe_customer_id', '  cus_abc  ')).toBe('cus_abc');
    expect(normalizeIdentifier('custom', '')).toBeNull();
  });
});