import { describe, expect, it } from 'bun:test';

import { hasAllScopes } from '../scopes';

describe('OAuth scope helpers', () => {
  it('treats Google userinfo scopes as equivalent to OIDC email/profile aliases', () => {
    expect(
      hasAllScopes(
        [
          'openid',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/gmail.readonly',
        ],
        ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly']
      )
    ).toBe(true);
  });

  it('still requires connector-specific scopes exactly', () => {
    expect(
      hasAllScopes(
        ['openid', 'email', 'profile'],
        ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly']
      )
    ).toBe(false);
  });
});
