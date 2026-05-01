import { describe, expect, it } from 'vitest';
import {
  RESERVED_SLUGS,
  deriveSlugCandidate,
  personalOrgLockKey,
  slugify,
} from '../personal-org-provisioning';

describe('slugify', () => {
  it('lowercases and dash-separates words', () => {
    expect(slugify('Burak Emre')).toBe('burak-emre');
  });

  it('strips diacritics', () => {
    expect(slugify('João Martins')).toBe('joao-martins');
    expect(slugify('Zoë')).toBe('zoe');
  });

  it('collapses non-alphanumeric runs and trims edges', () => {
    expect(slugify('  --Finance & Ops!!  ')).toBe('finance-ops');
  });

  it('returns empty string for empty-after-sanitize input', () => {
    expect(slugify('🚀💸')).toBe('');
    expect(slugify('---')).toBe('');
  });

  it('truncates to 48 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long)).toHaveLength(48);
  });
});

describe('deriveSlugCandidate', () => {
  it('prefers username when available', () => {
    expect(
      deriveSlugCandidate({
        id: 'user_abc',
        username: 'buremba',
        name: 'Burak Emre',
        email: 'emr.e@rakam.io',
      })
    ).toBe('buremba');
  });

  it('falls back to name when username is missing', () => {
    expect(
      deriveSlugCandidate({
        id: 'user_abc',
        username: null,
        name: 'Burak Emre',
        email: 'emr.e@rakam.io',
      })
    ).toBe('burak-emre');
  });

  it('falls back to email local part when name is missing', () => {
    expect(
      deriveSlugCandidate({
        id: 'user_abc',
        username: null,
        name: null,
        email: 'emr.e@rakam.io',
      })
    ).toBe('emr-e');
  });

  it('uses a user-id stub when everything is empty', () => {
    expect(
      deriveSlugCandidate({
        id: 'userABCDEF1234',
        username: null,
        name: null,
        email: null,
      })
    ).toBe('user-userabcd');
  });

  it('skips non-slugifiable fields and moves to the next candidate', () => {
    expect(
      deriveSlugCandidate({
        id: 'user_abc',
        username: '🚀',
        name: 'Burak',
        email: null,
      })
    ).toBe('burak');
  });
});

describe('personalOrgLockKey', () => {
  it('returns a stable signed int32 advisory-lock key', () => {
    const key = personalOrgLockKey('user_abc123');
    expect(personalOrgLockKey('user_abc123')).toBe(key);
    expect(Number.isInteger(key)).toBe(true);
    expect(key).toBeGreaterThanOrEqual(-2147483648);
    expect(key).toBeLessThanOrEqual(2147483647);
  });

  it('varies by user id', () => {
    expect(personalOrgLockKey('user_a')).not.toBe(personalOrgLockKey('user_b'));
  });
});

describe('RESERVED_SLUGS', () => {
  it('mirrors the DB org_slug_not_reserved CHECK set', () => {
    // If this diverges from the DB constraint the hook will hit a
    // constraint violation at runtime rather than producing a clean suffix.
    const expected = [
      'settings',
      'auth',
      'api',
      'templates',
      'help',
      'account',
      'admin',
      'health',
      'login',
      'logout',
      'signup',
      'register',
      'www',
      'mcp',
      'static',
      'assets',
      'cdn',
      'docs',
      'mail',
    ];
    for (const slug of expected) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
    }
    expect(RESERVED_SLUGS.size).toBe(expected.length);
  });
});
