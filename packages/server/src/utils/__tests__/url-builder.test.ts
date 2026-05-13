import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntityUrl, getPublicWebUrl } from '../url-builder';
import {
  HOSTED_UI_FALLBACK_ORIGIN,
  __resetPublicOriginCachesForTests,
} from '../public-origin';

/**
 * Behavior contract for `getPublicWebUrl`:
 *   1. Explicit `baseUrl` argument wins.
 *   2. `PUBLIC_WEB_URL` env wins next.
 *   3. With no local frontend bundled, fall back to the hosted-UI origin
 *      (`HOSTED_UI_FALLBACK_ORIGIN`) so backend-only self-hosters still emit
 *      usable links. The `requestUrl` is only consulted when a local frontend
 *      is present — that's why most tests below assert the fallback even when
 *      a `requestUrl` is supplied.
 */
describe('getPublicWebUrl', () => {
  const originalWebUrl = process.env.PUBLIC_WEB_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_WEB_URL;
    __resetPublicOriginCachesForTests();
  });

  afterEach(() => {
    if (originalWebUrl !== undefined) {
      process.env.PUBLIC_WEB_URL = originalWebUrl;
    } else {
      delete process.env.PUBLIC_WEB_URL;
    }
    __resetPublicOriginCachesForTests();
  });

  it('returns explicit baseUrl when provided', () => {
    expect(getPublicWebUrl(undefined, 'https://configured.lobu.com')).toBe(
      'https://configured.lobu.com'
    );
  });

  it('strips trailing slash from baseUrl', () => {
    expect(getPublicWebUrl(undefined, 'https://fallback.lobu.com/')).toBe(
      'https://fallback.lobu.com'
    );
  });

  it('prefers explicit baseUrl over requestUrl', () => {
    expect(
      getPublicWebUrl('https://request.lobu.com/mcp', 'https://configured.lobu.com')
    ).toBe('https://configured.lobu.com');
  });

  it('prefers PUBLIC_WEB_URL env var when no explicit baseUrl', () => {
    process.env.PUBLIC_WEB_URL = 'https://env.lobu.com';
    expect(getPublicWebUrl('https://request.lobu.com/mcp')).toBe('https://env.lobu.com');
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN when no env, no baseUrl, no local frontend', () => {
    expect(getPublicWebUrl(undefined, undefined)).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN even when requestUrl is given (backend-only host)', () => {
    expect(getPublicWebUrl('https://request.lobu.com/mcp')).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });
});

describe('buildEntityUrl', () => {
  it('builds URL with provided baseUrl', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      'https://app.lobu.com'
    );
    expect(url).toBe('https://app.lobu.com/acme/topic/test-topic');
  });

  it('builds relative URL when no base provided', () => {
    const url = buildEntityUrl(
      { ownerSlug: 'acme', entityType: 'topic', slug: 'test-topic' },
      undefined
    );
    expect(url).toBe('/acme/topic/test-topic');
  });
});
