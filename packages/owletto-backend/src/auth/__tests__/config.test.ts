/**
 * Auth Config Tests
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectEnabledLoginProviderConfigs,
  getAuthConfig,
  getLoginProviderScopes,
  isSupportedLoginProvider,
} from '../config';

describe('login provider helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns connector-declared scopes verbatim', () => {
    expect(getLoginProviderScopes('google', ['openid', 'email', 'profile'])).toEqual([
      'openid',
      'email',
      'profile',
    ]);
  });

  it('returns null when the connector declares no login scopes', () => {
    // Core no longer assumes scopes for any provider — connectors must declare them.
    expect(getLoginProviderScopes('google')).toBeNull();
    expect(getLoginProviderScopes('github')).toBeNull();
    expect(getLoginProviderScopes('reddit')).toBeNull();
  });

  it('recognizes supported login providers only when scopes are declared', () => {
    expect(isSupportedLoginProvider('google')).toBe(false);
    expect(isSupportedLoginProvider('github', ['read:user', 'user:email'])).toBe(true);
    expect(isSupportedLoginProvider('twitter', ['users.read', 'users.email'])).toBe(true);
  });

  it('dedupes providers and ignores connectors without declared login scopes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const configs = collectEnabledLoginProviderConfigs([
      {
        // No loginScopes declared and no provisioning union available → filtered out.
        key: 'google.calendar',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'google',
              requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
            },
          ],
        },
      },
      {
        key: 'google.gmail',
        auth_schema:
          '{"methods":[{"type":"oauth","provider":"google","loginScopes":["openid","email","profile"]}]}',
      },
      {
        key: 'github.issues',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'github',
              loginScopes: ['read:user', 'user:email'],
              clientIdKey: 'GH_ID',
              clientSecretKey: 'GH_SECRET',
            },
          ],
        },
      },
      {
        key: 'twitter.timeline',
        auth_schema: {
          methods: [
            {
              type: 'oauth',
              provider: 'twitter',
              loginScopes: ['users.read', 'tweet.read', 'offline.access', 'users.email'],
            },
          ],
        },
      },
      {
        // No loginScopes → filtered out even though it's OAuth.
        key: 'reddit',
        auth_schema: {
          methods: [{ type: 'oauth', provider: 'reddit', requiredScopes: ['read'] }],
        },
      },
    ]);

    expect(configs).toEqual([
      {
        connectorKey: 'google.gmail',
        provider: 'google',
        loginScopes: ['openid', 'email', 'profile'],
        clientIdKey: 'GOOGLE_CLIENT_ID',
        clientSecretKey: 'GOOGLE_CLIENT_SECRET',
      },
      {
        connectorKey: 'github.issues',
        provider: 'github',
        loginScopes: ['read:user', 'user:email'],
        clientIdKey: 'GH_ID',
        clientSecretKey: 'GH_SECRET',
      },
      {
        connectorKey: 'twitter.timeline',
        provider: 'twitter',
        loginScopes: ['users.read', 'tweet.read', 'offline.access', 'users.email'],
        clientIdKey: 'TWITTER_CLIENT_ID',
        clientSecretKey: 'TWITTER_CLIENT_SECRET',
      },
    ]);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('getAuthConfig', () => {
  it('should be an async function', () => {
    const result = getAuthConfig({} as any);
    result.catch(() => {});
    expect(result).toBeInstanceOf(Promise);
  });

  it('should export getAuthConfig function', () => {
    expect(typeof getAuthConfig).toBe('function');
  });

  // Full integration tests with a real database connection should still verify:
  // - OAuth providers enabled when login_enabled=true in DB and credentials in env
  // - Magic link enabled with RESEND_API_KEY
  // - Phone auth enabled with Twilio credentials
  // - Email/password fallback logic
  // - AUTH_DEFAULT_ORGANIZATION_SLUG fallback when no org context
});
