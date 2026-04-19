import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntityUrl, getPublicWebUrl } from '../url-builder';

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

  it('returns origin from requestUrl when provided', () => {
    expect(getPublicWebUrl('https://app.owletto.com/mcp')).toBe('https://app.owletto.com');
  });

  it('strips trailing slash from origin', () => {
    expect(getPublicWebUrl('https://app.owletto.com/')).toBe('https://app.owletto.com');
  });

  it('falls back to baseUrl when requestUrl is undefined', () => {
    expect(getPublicWebUrl(undefined, 'https://fallback.owletto.com')).toBe(
      'https://fallback.owletto.com'
    );
  });

  it('strips trailing slash from baseUrl fallback', () => {
    expect(getPublicWebUrl(undefined, 'https://fallback.owletto.com/')).toBe(
      'https://fallback.owletto.com'
    );
  });

  it('prefers baseUrl over requestUrl', () => {
    expect(
      getPublicWebUrl('https://request.owletto.com/mcp', 'https://configured.owletto.com')
    ).toBe('https://configured.owletto.com');
  });

  it('falls back to requestUrl when baseUrl is not set', () => {
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe('https://request.owletto.com');
  });

  it('prefers PUBLIC_WEB_URL env var over requestUrl', () => {
    process.env.PUBLIC_WEB_URL = 'https://env.owletto.com';
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe('https://env.owletto.com');
  });

  it('falls back to LOBU_URL when PUBLIC_WEB_URL is not set', () => {
    process.env.LOBU_URL = 'https://community.lobu.ai';
    expect(getPublicWebUrl('https://request.owletto.com/mcp')).toBe('https://community.lobu.ai');
  });

  it('returns undefined when both are missing', () => {
    expect(getPublicWebUrl(undefined, undefined)).toBeUndefined();
  });

  it('returns undefined when both are empty strings', () => {
    expect(getPublicWebUrl(undefined, '')).toBeUndefined();
  });
});

describe('buildEntityUrl', () => {
  it('builds URL with baseUrl from getPublicWebUrl fallback', () => {
    const baseUrl = getPublicWebUrl(undefined, 'https://app.owletto.com');
    const url = buildEntityUrl(
      {
        ownerSlug: 'acme',
        entityType: 'topic',
        slug: 'test-topic',
      },
      baseUrl
    );
    expect(url).toBe('https://app.owletto.com/acme/topic/test-topic');
  });

  it('builds relative URL when no base available', () => {
    const url = buildEntityUrl(
      {
        ownerSlug: 'acme',
        entityType: 'topic',
        slug: 'test-topic',
      },
      undefined
    );
    expect(url).toBe('/acme/topic/test-topic');
  });
});
