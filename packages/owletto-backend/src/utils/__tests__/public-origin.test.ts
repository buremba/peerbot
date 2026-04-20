import { describe, expect, it } from 'vitest';
import { getCanonicalRedirectUrl } from '../public-origin';

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
