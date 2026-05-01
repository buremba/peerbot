import { describe, expect, it } from 'vitest';
import {
  extractSubdomainOrg,
  getCanonicalRedirectUrl,
  getSubdomainZone,
  normalizeHost,
} from '../public-origin';

const RESERVED = new Set(['www', 'api', 'app', 'admin', 'auth', 'mcp']);

describe('getCanonicalRedirectUrl', () => {
  it('redirects non-canonical hosts to the configured origin', () => {
    expect(
      getCanonicalRedirectUrl(
        'https://owletto.com/brand/acme/watchers?tab=recent',
        'https://community.lobu.ai'
      )
    ).toBe('https://community.lobu.ai/brand/acme/watchers?tab=recent');
  });

  it('does not redirect requests already on the canonical host', () => {
    expect(
      getCanonicalRedirectUrl('https://community.lobu.ai/brand/acme', 'https://community.lobu.ai')
    ).toBeNull();
  });

  it('does not redirect canonical subdomains', () => {
    expect(
      getCanonicalRedirectUrl(
        'https://acme.community.lobu.ai/brand/acme',
        'https://community.lobu.ai'
      )
    ).toBeNull();
  });

  it('does not redirect localhost', () => {
    expect(
      getCanonicalRedirectUrl('http://localhost:8787/brand/acme', 'https://community.lobu.ai')
    ).toBeNull();
  });

  it('preserves sibling subdomains under the auth cookie zone', () => {
    expect(
      getCanonicalRedirectUrl('https://acme.lobu.ai/dashboard', 'https://app.lobu.ai', '.lobu.ai')
    ).toBeNull();
    expect(
      getCanonicalRedirectUrl('https://lobu.ai/marketing', 'https://app.lobu.ai', '.lobu.ai')
    ).toBeNull();
  });

  it('still redirects unrelated hosts when a cookie zone is set', () => {
    expect(
      getCanonicalRedirectUrl('https://owletto.com/foo', 'https://app.lobu.ai', '.lobu.ai')
    ).toBe('https://app.lobu.ai/foo');
  });
});

describe('getSubdomainZone', () => {
  it('prefers AUTH_COOKIE_DOMAIN over the configured origin host', () => {
    expect(getSubdomainZone('https://app.lobu.ai', '.lobu.ai')).toBe('lobu.ai');
  });

  it('accepts cookie domains without a leading dot', () => {
    expect(getSubdomainZone('https://app.lobu.ai', 'lobu.ai')).toBe('lobu.ai');
  });

  it('falls back to the configured origin host when no cookie domain is set', () => {
    expect(getSubdomainZone('https://app.example.com', undefined)).toBe('app.example.com');
  });

  it('returns null when nothing is configured', () => {
    expect(getSubdomainZone(undefined, undefined)).toBeNull();
  });
});

describe('extractSubdomainOrg', () => {
  it('extracts the org slug from a matching host', () => {
    expect(extractSubdomainOrg('acme.lobu.ai', 'lobu.ai', RESERVED)).toBe('acme');
  });

  it('strips port numbers before matching', () => {
    expect(extractSubdomainOrg('acme.lobu.ai:443', 'lobu.ai', RESERVED)).toBe('acme');
  });

  it('returns null for reserved subdomains', () => {
    expect(extractSubdomainOrg('app.lobu.ai', 'lobu.ai', RESERVED)).toBeNull();
    expect(extractSubdomainOrg('www.lobu.ai', 'lobu.ai', RESERVED)).toBeNull();
  });

  it('returns null for the bare zone', () => {
    expect(extractSubdomainOrg('lobu.ai', 'lobu.ai', RESERVED)).toBeNull();
  });

  it('returns null for multi-label subdomains', () => {
    expect(extractSubdomainOrg('foo.bar.lobu.ai', 'lobu.ai', RESERVED)).toBeNull();
  });

  it('returns null for unrelated hosts', () => {
    expect(extractSubdomainOrg('acme.example.com', 'lobu.ai', RESERVED)).toBeNull();
  });

  it('returns null when host or zone is missing', () => {
    expect(extractSubdomainOrg(undefined, 'lobu.ai', RESERVED)).toBeNull();
    expect(extractSubdomainOrg('acme.lobu.ai', null, RESERVED)).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(extractSubdomainOrg('ACME.Lobu.AI', 'lobu.ai', RESERVED)).toBe('acme');
  });

  it('ignores a trailing dot on the host', () => {
    expect(extractSubdomainOrg('acme.lobu.ai.', 'lobu.ai', RESERVED)).toBe('acme');
  });

  it('matches IDN hosts to their ASCII zone via punycode', () => {
    // "müller" → "xn--mller-kva" under IDNA.
    const result = extractSubdomainOrg('müller.lobu.ai', 'lobu.ai', RESERVED);
    expect(result).toBe('xn--mller-kva');
  });

  it('tolerates a zone with leading dot or uppercase', () => {
    expect(extractSubdomainOrg('acme.lobu.ai', '.LOBU.AI', RESERVED)).toBe('acme');
  });
});

describe('normalizeHost', () => {
  it('lowercases and strips port / leading-dot / trailing-dot', () => {
    expect(normalizeHost('App.Lobu.AI:8080')).toBe('app.lobu.ai');
    expect(normalizeHost('.lobu.ai')).toBe('lobu.ai');
    expect(normalizeHost('lobu.ai.')).toBe('lobu.ai');
  });

  it('converts IDN to punycode', () => {
    expect(normalizeHost('müller.example.com')).toBe('xn--mller-kva.example.com');
  });

  it('returns null for missing or malformed input', () => {
    expect(normalizeHost(undefined)).toBeNull();
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('   ')).toBeNull();
  });
});
