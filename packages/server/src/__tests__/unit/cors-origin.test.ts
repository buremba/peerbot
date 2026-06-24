import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getOwnedOwlettoExtensionIds, isAllowedCorsOrigin } from '../../index';
import { __resetPublicOriginCachesForTests } from '../../utils/public-origin';

// The Hono CORS middleware in packages/server/src/index.ts must accept
// `chrome-extension://<our id>`
// or the Owletto service worker's `/api/workers/poll` fetch fails the
// preflight with "No 'Access-Control-Allow-Origin' header is present on the
// requested resource" — exactly the regression we're closing.
//
// Behind a TLS-terminating proxy `c.req.url` is http://; we use the same
// shape here so the canonical-origin check exercises the configured public
// origin path.

const REQUEST_URL = 'http://10.0.0.1/api/workers/poll';

const ORIGINAL_PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL;

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ENVIRONMENT: 'test',
    ...overrides,
  } as unknown as Parameters<typeof isAllowedCorsOrigin>[1];
}

beforeEach(() => {
  process.env.PUBLIC_WEB_URL = 'https://app.lobu.ai';
  __resetPublicOriginCachesForTests();
});

afterEach(() => {
  if (ORIGINAL_PUBLIC_WEB_URL === undefined) {
    delete process.env.PUBLIC_WEB_URL;
  } else {
    process.env.PUBLIC_WEB_URL = ORIGINAL_PUBLIC_WEB_URL;
  }
  __resetPublicOriginCachesForTests();
});

describe('getOwnedOwlettoExtensionIds', () => {
  test('always includes both the dev/unpacked and published store ids', () => {
    const ids = getOwnedOwlettoExtensionIds(makeEnv());
    // Dev/unpacked id, derived from the manifest `key`.
    expect(ids).toContain('amnnhclgmbldmfcfamonoggjhfidemmm');
    // Chrome Web Store id — without this, app.lobu.ai's frame-ancestors
    // blocked the published sidepanel iframe even though local dev worked.
    expect(ids).toContain('jhgcecbdpnoehfnhpdfihlchjddapepi');
  });

  test('merges in well-formed ids from LOBU_OWLETTO_EXTENSION_IDS', () => {
    const fakeDevId = 'abcdefghijklmnopabcdefghijklmnop'; // 32 chars, [a-p]
    const ids = getOwnedOwlettoExtensionIds(
      makeEnv({ LOBU_OWLETTO_EXTENSION_IDS: `  ${fakeDevId} , bogus-id, ` })
    );
    expect(ids).toContain('amnnhclgmbldmfcfamonoggjhfidemmm');
    expect(ids).toContain('jhgcecbdpnoehfnhpdfihlchjddapepi');
    expect(ids).toContain(fakeDevId);
    expect(ids).not.toContain('bogus-id');
  });
});

describe('isAllowedCorsOrigin — chrome-extension://', () => {
  test('accepts the dev/unpacked Owletto extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://amnnhclgmbldmfcfamonoggjhfidemmm',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('accepts the published Chrome Web Store extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://jhgcecbdpnoehfnhpdfihlchjddapepi',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('accepts an extra id configured via LOBU_OWLETTO_EXTENSION_IDS', () => {
    const fakeDevId = 'abcdefghijklmnopabcdefghijklmnop';
    expect(
      isAllowedCorsOrigin(
        `chrome-extension://${fakeDevId}`,
        makeEnv({ LOBU_OWLETTO_EXTENSION_IDS: fakeDevId }),
        REQUEST_URL
      )
    ).toBe(true);
  });

  test('rejects an unknown chrome-extension origin', () => {
    expect(
      isAllowedCorsOrigin(
        'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(false);
  });

  test('rejects http:// pretending to be the extension id (no protocol mismatch)', () => {
    expect(
      isAllowedCorsOrigin(
        'http://amnnhclgmbldmfcfamonoggjhfidemmm',
        makeEnv(),
        REQUEST_URL
      )
    ).toBe(false);
  });
});

describe('isAllowedCorsOrigin — regression coverage for pre-existing branches', () => {
  test('still accepts the canonical https origin', () => {
    expect(isAllowedCorsOrigin('https://app.lobu.ai', makeEnv(), REQUEST_URL)).toBe(true);
  });

  test('still accepts wildcard subdomains of the public origin', () => {
    // PUBLIC_WEB_URL is app.lobu.ai → only `.app.lobu.ai` subdomains match
    // without AUTH_COOKIE_DOMAIN. The sibling-zone case is exercised
    // separately in the existing subdomain-zone tests.
    expect(isAllowedCorsOrigin('https://acme.app.lobu.ai', makeEnv(), REQUEST_URL)).toBe(true);
  });

  test('still rejects an arbitrary third-party origin', () => {
    expect(isAllowedCorsOrigin('https://evil.com', makeEnv(), REQUEST_URL)).toBe(false);
  });
});
