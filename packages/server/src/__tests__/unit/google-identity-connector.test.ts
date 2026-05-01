import { afterEach, describe, expect, it, mock } from 'bun:test';
import { connectorCapabilityRegistry } from '../../identity/capability-registry';
import '../../identity/connectors/google';

const originalFetch = globalThis.fetch;

function mockGoogleUserinfo(raw: Record<string, unknown>) {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(raw), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  ) as unknown as typeof fetch;
}

describe('google identity connector', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts Google OAuth2 v2 verified_email for oauth_verified email facts', async () => {
    mockGoogleUserinfo({
      id: 'google-sub-1',
      email: 'Verified@Example.COM',
      verified_email: true,
    });

    const emit = connectorCapabilityRegistry.emitter('google');
    expect(emit).toBeDefined();
    const result = await emit!({ accessToken: 'token', sourceAccountId: 'acct_google' });

    expect(result?.providerStableId).toBe('google-sub-1');
    expect(result?.facts).toEqual([
      {
        namespace: 'email',
        identifier: 'Verified@Example.COM',
        normalizedValue: 'verified@example.com',
        assurance: 'oauth_verified',
        providerStableId: 'google-sub-1',
        sourceAccountId: 'acct_google',
      },
    ]);
  });

  it('does not emit high-assurance email when Google omits/denies verification', async () => {
    mockGoogleUserinfo({
      id: 'google-sub-2',
      email: 'unverified@example.com',
      verified_email: false,
    });

    const emit = connectorCapabilityRegistry.emitter('google');
    const result = await emit!({ accessToken: 'token', sourceAccountId: 'acct_google' });

    expect(result?.providerStableId).toBe('google-sub-2');
    expect(result?.facts).toEqual([]);
  });
});
