import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntityUrl, getPublicWebUrl } from '../url-builder';
import { HOSTED_UI_FALLBACK_ORIGIN } from '../public-origin';

/**
 * Behavior contract for `getPublicWebUrl`:
 *   1. Explicit `baseUrl` argument wins.
 *   2. `PUBLIC_WEB_URL` (preferred) or `LOBU_URL` env wins next.
 *   3. With no local frontend bundled, fall back to the hosted-UI origin
 *      (`HOSTED_UI_FALLBACK_ORIGIN`) so backend-only self-hosters still emit
 *      usable links. The `requestUrl` is only consulted when a local frontend
 *      is present — that's why most tests below assert the fallback even when
 *      a `requestUrl` is supplied.
 */
describe('getPublicWebUrl', () => {
  const originalWebUrl = process.env.PUBLIC_WEB_URL;
  const originalLobuUrl = process.env.LOBU_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_WEB_URL;
    delete process.env.LOBU_URL;
  });

  afterEach(() => {
    if (originalWebUrl !== undefined) {
      process.env.PUBLIC_WEB_URL = originalWebUrl;
    } else {
      delete process.env.PUBLIC_WEB_URL;
    }

    if (originalLobuUrl !== undefined) {
      process.env.LOBU_URL = originalLobuUrl;
    } else {
      delete process.env.LOBU_URL;
    }
  });

  it('returns explicit baseUrl when provided', () => {
    expect(getPublicWebUrl(undefined, 'https://configured.owletto.com')).toBe(
      'https://configured.owletto.com'
    );
  });

  it('strips trailing slash from baseUrl', () => {
    expect(getPublicWebUrl(undefined, 'https://fallback.owletto.com/')).toBe(
      'https://fallback.owletto.com'
    );
  });

  it('prefers explicit baseUrl over requestUrl', () => {
    expect(
      getPublicWebUrl('https://request.owletto.com/mcp', 'https://configured.owletto.com')
    ).toBe('https://configured.owletto.com');
  });

  it('prefers PUBLIC_WEB_URL env var when no explicit baseUrl', () => {
    process.env.PUBLIC_WEB_URL = 'https://env.owletto.com';
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe('https://env.owletto.com');
  });

  it('falls back to LOBU_URL when PUBLIC_WEB_URL is not set', () => {
    process.env.LOBU_URL = 'https://community.lobu.ai';
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe('https://community.lobu.ai');
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN when no env, no baseUrl, no local frontend', () => {
    expect(getPublicWebUrl(undefined, undefined)).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN even when requestUrl is given (backend-only host)', () => {
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });
});

describe('buildEntityUrl', () => {
  it('builds URL with provided baseUrl', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      'https://app.owletto.com'
    );
    expect(url).toBe('https://app.owletto.com/acme/topic/test-topic');
  });

  it('builds relative URL when no base provided', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      undefined
    );
    expect(url).toBe('/acme/topic/test-topic');
  });
});
