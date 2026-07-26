import { isSecretKey } from '@lobu/core';
import { describe, expect, it } from 'vitest';
import {
  REDACTED_SENTINEL,
  redactConfigState,
} from '../config-redaction';

describe('redactConfigState', () => {
  it('redacts denylisted keys at any depth, any case style', () => {
    const out = redactConfigState('connection', {
      name: 'slack-main',
      config: {
        botToken: 'xoxb-real-secret',
        signing_secret: 'shhh',
        nested: { apiKey: 'sk-123', refreshTokens: ['a', 'b'] },
        channel: 'C123',
      },
    });
    const config = out?.config as Record<string, unknown>;
    expect(config.botToken).toBe(REDACTED_SENTINEL);
    expect(config.signing_secret).toBe(REDACTED_SENTINEL);
    expect((config.nested as Record<string, unknown>).apiKey).toBe(REDACTED_SENTINEL);
    expect((config.nested as Record<string, unknown>).refreshTokens).toBe(REDACTED_SENTINEL);
    expect(config.channel).toBe('C123');
    expect(out?.name).toBe('slack-main');
  });

  it('does not redact non-secret keys that merely contain substrings', () => {
    const out = redactConfigState('agent', {
      tokenizer: 'cl100k',
      keyboard: 'qwerty',
      secretsPolicy: 'strict', // "secrets_policy" — suffix is "policy", not "secret"
    });
    expect(out?.tokenizer).toBe('cl100k');
    expect(out?.keyboard).toBe('qwerty');
    expect(out?.secretsPolicy).toBe('strict');
  });

  it('replaces auth-profile credentials wholesale', () => {
    const out = redactConfigState('auth-profile', {
      kind: 'oauth',
      credentials: { some_connector_defined_field: 'value' },
    });
    expect(out?.credentials).toBe(REDACTED_SENTINEL);
    expect(out?.kind).toBe('oauth');
  });

  it('forces provider-key state to null', () => {
    expect(redactConfigState('provider-key', { providerId: 'anthropic' })).toBeNull();
  });

  it('passes through null state (deletes)', () => {
    expect(redactConfigState('agent', null)).toBeNull();
  });

  it('preserves arrays and leaves null secret values untouched', () => {
    const out = redactConfigState('behavior', {
      sources: [{ feed: 'gmail' }],
      api_key: null,
    });
    expect(out?.sources).toEqual([{ feed: 'gmail' }]);
    expect(out?.api_key).toBeNull();
  });

  it('redacts inference-provider apiKey', () => {
    const out = redactConfigState('inference-provider', {
      baseUrl: 'https://api.z.ai',
      apiKey: 'zk-live',
    });
    expect(out?.apiKey).toBe(REDACTED_SENTINEL);
    expect(out?.baseUrl).toBe('https://api.z.ai');
  });
});

/**
 * The denylist is SUFFIX-anchored (`(^|_)(token|secret|…)s?$`), which by
 * construction misses URL/DSN-shaped credential keys — `DATABASE_URL` ends in
 * `_url`, not in any denylisted term. That gap is exactly the bug this branch
 * started from: a `postgres://user:pass@host/db` sitting in
 * `connections.config.DATABASE_URL` and served straight back by
 * `connections.list()`. These cases pin the fix so it cannot silently regress.
 */
describe('isSecretKey > URL/DSN-shaped credential keys', () => {
  it.each(['DATABASE_URL', 'database_url', 'databaseUrl', 'dsn', 'connection_string', 'connectionString', 'db_url'])(
    'classifies %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(true);
    }
  );

  it.each(['authorization', 'Authorization', 'cookie', 'session_id', 'sessionId', 'bearer'])(
    'classifies %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(true);
    }
  );

  // The suffix anchoring is load-bearing — these must stay readable.
  it.each(['tokenizer', 'keyboard', 'secretsPolicy', 'url', 'base_url', 'webhook_url', 'authorization_mode'])(
    'does NOT classify %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    }
  );
});

/**
 * Key names are not sufficient on their own: a connection string can sit under
 * a perfectly innocuous key (`primary`, `endpoint`). The value-shaped pass
 * strips the `user:password@` userinfo while leaving scheme + host readable.
 */
describe('redactConfigState > URI credential values', () => {
  it('redacts credentials embedded in a connection string under a non-secret key', () => {
    const out = redactConfigState('connection', {
      config: {
        primary: 'postgres://admin:hunter2@db.internal:5432/app',
        endpoint: 'https://api.example.com/v1',
      },
    });
    const config = out?.config as Record<string, unknown>;
    expect(config.primary).toBe(`postgres://${REDACTED_SENTINEL}@db.internal:5432/app`);
    expect(config.primary).not.toContain('hunter2');
    // A URL with no userinfo is untouched.
    expect(config.endpoint).toBe('https://api.example.com/v1');
  });
});
