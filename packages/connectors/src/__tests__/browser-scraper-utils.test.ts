import { describe, expect, mock, test } from 'bun:test';

// browser-scraper-utils.ts pulls runtime symbols (acquireBrowser,
// captureErrorArtifacts) from @lobu/connector-sdk, which itself pulls in
// playwright. Stub the SDK so the pure helpers (validateUrlDomain,
// getBrowserCookies, validateCookieNotExpired, filterByCheckpoint) can be
// imported without spinning up a real browser stack.
mock.module('@lobu/connector-sdk', () => ({
  acquireBrowser: () => {
    throw new Error('not used in unit tests');
  },
  captureErrorArtifacts: () => {
    throw new Error('not used in unit tests');
  },
  // Other connector tests (linkedin) load the same stubbed module in the same
  // run; expose the symbols they need so the shared mock satisfies every
  // importer regardless of file order.
  ConnectorRuntime: class {},
  calculateEngagementScore: () => 0,
  extensionNetworkSync: () => {
    throw new Error('not used in unit tests');
  },
}));

const {
  filterByCheckpoint,
  getBrowserCookies,
  validateCookieNotExpired,
  validateUrlDomain,
} = await import('../browser-scraper-utils.ts');

describe('validateUrlDomain', () => {
  test('accepts a well-formed https URL on the expected domain', () => {
    expect(() =>
      validateUrlDomain('https://www.trustpilot.com/review/foo', 'trustpilot.com')
    ).not.toThrow();
  });

  test('accepts a subdomain of the expected domain', () => {
    expect(() => validateUrlDomain('https://api.example.com/x', 'example.com')).not.toThrow();
  });

  test('rejects a malformed URL', () => {
    expect(() => validateUrlDomain('not a url', 'example.com')).toThrow(/Invalid example.com URL/);
  });

  test('rejects http (non-https) URLs', () => {
    expect(() => validateUrlDomain('http://www.example.com/', 'example.com')).toThrow(
      /must use https: protocol/
    );
  });

  test('rejects a URL on a different domain', () => {
    expect(() => validateUrlDomain('https://evil.com/foo', 'example.com')).toThrow(
      /must be on example.com/
    );
  });

  test('rejects a substring-match hostname (security: notexample.com is NOT example.com)', () => {
    expect(() => validateUrlDomain('https://notexample.com/x', 'example.com')).toThrow(
      /must be on example.com/
    );
    expect(() => validateUrlDomain('https://eviltrustpilot.com/x', 'trustpilot.com')).toThrow(
      /must be on trustpilot.com/
    );
  });

  test('accepts the apex domain itself (no subdomain)', () => {
    expect(() => validateUrlDomain('https://example.com/x', 'example.com')).not.toThrow();
  });
});

describe('getBrowserCookies', () => {
  test('prefers checkpoint cookies over session-state cookies', () => {
    const cookies = getBrowserCookies(
      { cookies: [{ name: 'checkpoint-cookie' }] },
      { cookies: [{ name: 'session-cookie' }] },
      'connector.x'
    );
    expect(cookies).toEqual([{ name: 'checkpoint-cookie' }]);
  });

  test('falls back to session-state cookies when checkpoint has none', () => {
    const cookies = getBrowserCookies(
      null,
      { cookies: [{ name: 'session-cookie' }] },
      'connector.x'
    );
    expect(cookies).toEqual([{ name: 'session-cookie' }]);
  });

  test('throws a descriptive error when no cookies are present anywhere', () => {
    expect(() => getBrowserCookies(null, null, 'connector.x')).toThrow(
      /No browser cookies found/
    );
    expect(() => getBrowserCookies(null, null, 'connector.x')).toThrow(/connector\.x/);
  });

  test('throws when checkpoint cookies array is empty and no session', () => {
    expect(() => getBrowserCookies({ cookies: [] }, undefined, 'connector.x')).toThrow(
      /No browser cookies found/
    );
  });

  test('handles undefined sessionState explicitly', () => {
    expect(() => getBrowserCookies(null, undefined, 'connector.x')).toThrow(
      /No browser cookies found/
    );
  });
});

describe('validateCookieNotExpired', () => {
  test('does nothing when the cookie is missing entirely', () => {
    expect(() =>
      validateCookieNotExpired([{ name: 'other' }], 'session', 'connector.x')
    ).not.toThrow();
  });

  test('does nothing when the cookie has no expires field', () => {
    expect(() =>
      validateCookieNotExpired([{ name: 'session' }], 'session', 'connector.x')
    ).not.toThrow();
  });

  test('does nothing when expires is 0 (session cookie)', () => {
    expect(() =>
      validateCookieNotExpired([{ name: 'session', expires: 0 }], 'session', 'connector.x')
    ).not.toThrow();
  });

  test('does nothing when the cookie expires in the future', () => {
    const futureUnix = Math.floor(Date.now() / 1000) + 60 * 60;
    expect(() =>
      validateCookieNotExpired(
        [{ name: 'session', expires: futureUnix }],
        'session',
        'connector.x'
      )
    ).not.toThrow();
  });

  test('throws when the cookie has expired', () => {
    const pastUnix = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    expect(() =>
      validateCookieNotExpired(
        [{ name: 'session', expires: pastUnix }],
        'session',
        'connector.x'
      )
    ).toThrow(/session expired on/);
  });

  test('error message includes the connector slug for the re-auth hint', () => {
    const pastUnix = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    expect(() =>
      validateCookieNotExpired(
        [{ name: 'session', expires: pastUnix }],
        'session',
        'connector.x'
      )
    ).toThrow(/--connector connector\.x/);
  });
});

describe('filterByCheckpoint', () => {
  const events = [
    { occurred_at: new Date('2024-01-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-06-01T00:00:00Z') } as any,
    { occurred_at: new Date('2024-12-31T00:00:00Z') } as any,
  ];

  test('returns every event when no checkpoint is set', () => {
    expect(filterByCheckpoint(events, null)).toEqual(events);
  });

  test('returns every event when checkpoint has no last_timestamp', () => {
    expect(filterByCheckpoint(events, {})).toEqual(events);
  });

  test('keeps only events strictly newer than last_timestamp', () => {
    const filtered = filterByCheckpoint(events, {
      last_timestamp: '2024-06-01T00:00:00Z',
    });
    // strict `>` — event at exactly the cutoff is filtered out
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(events[2]);
  });

  test('returns empty array when cutoff is past every event', () => {
    expect(
      filterByCheckpoint(events, { last_timestamp: '2099-01-01T00:00:00Z' })
    ).toEqual([]);
  });
});
