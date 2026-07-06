import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEntityUrl, buildResourcePermalink, getPublicWebUrl } from '../url-builder';
import {
  HOSTED_UI_FALLBACK_ORIGIN,
  __resetPublicOriginCachesForTests,
  __setLocalFrontendForTests,
} from '../public-origin';

/**
 * Behavior contract for `getPublicWebUrl`:
 *   1. Explicit `baseUrl` argument wins.
 *   2. `PUBLIC_GATEWAY_URL` env wins next.
 *   3. With no local frontend bundled, fall back to the hosted-UI origin
 *      (`HOSTED_UI_FALLBACK_ORIGIN`) so backend-only self-hosters still emit
 *      usable links. The `requestUrl` is only consulted when a local frontend
 *      is present — that's why most tests below assert the fallback even when
 *      a `requestUrl` is supplied.
 */
describe('getPublicWebUrl', () => {
  const originalGatewayUrl = process.env.PUBLIC_GATEWAY_URL;

  beforeEach(() => {
    delete process.env.PUBLIC_GATEWAY_URL;
    __resetPublicOriginCachesForTests();
  });

  afterEach(() => {
    if (originalGatewayUrl !== undefined) {
      process.env.PUBLIC_GATEWAY_URL = originalGatewayUrl;
    } else {
      delete process.env.PUBLIC_GATEWAY_URL;
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

  it('prefers PUBLIC_GATEWAY_URL env var when no explicit baseUrl', () => {
    process.env.PUBLIC_GATEWAY_URL = 'https://env.lobu.com/lobu';
    expect(getPublicWebUrl('https://request.lobu.com/mcp')).toBe('https://env.lobu.com');
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN when no env, no baseUrl, no local frontend', () => {
    // Pin the precondition: a built packages/owletto/dist on the dev machine
    // (any owletto build, e.g. make review) would otherwise flip
    // hasLocalFrontend() and break the assertion.
    __setLocalFrontendForTests(false);
    expect(getPublicWebUrl(undefined, undefined)).toBe(HOSTED_UI_FALLBACK_ORIGIN);
  });

  it('falls back to HOSTED_UI_FALLBACK_ORIGIN even when requestUrl is given (backend-only host)', () => {
    __setLocalFrontendForTests(false);
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

describe('buildResourcePermalink', () => {
  it('run kind → ?run_ids (survives the supersede chain by construction)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'run', runId: 536620 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?run_ids=536620');
  });

  it('event kind → ?content_ids (chain-resolved on read)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'event', eventId: 4309390 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?content_ids=4309390');
  });

  it('feed kind → ?feed_ids (all activity in a channel)', () => {
    expect(
      buildResourcePermalink('acme', { kind: 'feed', feedId: 42 }, 'https://app.lobu.com')
    ).toBe('https://app.lobu.com/acme/memory?feed_ids=42');
  });

  it('builds a relative URL when no base is provided', () => {
    expect(buildResourcePermalink('acme', { kind: 'run', runId: 536620 })).toBe(
      '/acme/memory?run_ids=536620'
    );
  });

  it('returns undefined when the org slug is missing (no usable link)', () => {
    expect(buildResourcePermalink(null, { kind: 'run', runId: 1 })).toBeUndefined();
    expect(buildResourcePermalink(undefined, { kind: 'event', eventId: 1 })).toBeUndefined();
  });
});
