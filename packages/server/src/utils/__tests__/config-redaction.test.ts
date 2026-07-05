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
    const out = redactConfigState('watcher', {
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
