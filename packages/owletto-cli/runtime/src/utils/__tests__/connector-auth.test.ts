/**
 * Connector Auth Tests
 */

import { describe, expect, it } from 'vitest';
import {
  getOAuthAuthMethods,
  getRequiredEnvAuthFields,
  normalizeConnectorAuthSchema,
} from '../connector-auth';

describe('normalizeConnectorAuthSchema', () => {
  it('should return default for null', () => {
    const result = normalizeConnectorAuthSchema(null);
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should return default for undefined', () => {
    const result = normalizeConnectorAuthSchema(undefined);
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should return default for empty object', () => {
    const result = normalizeConnectorAuthSchema({});
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should parse valid env_keys method', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [
            { key: 'API_KEY', label: 'API Key', secret: true },
            { key: 'BASE_URL', label: 'Base URL' },
          ],
        },
      ],
    });
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('env_keys');
    const method = result.methods[0] as any;
    expect(method.fields.length).toBe(2);
    expect(method.fields[0].key).toBe('API_KEY');
    expect(method.fields[0].secret).toBe(true);
  });

  it('should parse valid oauth method', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['read', 'write'],
          authorizationUrl: 'https://example.com/authorize',
          tokenUrl: 'https://example.com/token',
          userinfoUrl: 'https://example.com/me',
          authParams: { audience: 'example-api' },
          tokenEndpointAuthMethod: 'client_secret_basic',
          usePkce: true,
          loginScopes: ['openid', 'email'],
        },
      ],
    });
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('oauth');
    const method = result.methods[0] as any;
    expect(method.provider).toBe('google');
    expect(method.requiredScopes).toEqual(['read', 'write']);
    expect(method.authorizationUrl).toBe('https://example.com/authorize');
    expect(method.tokenUrl).toBe('https://example.com/token');
    expect(method.userinfoUrl).toBe('https://example.com/me');
    expect(method.authParams).toEqual({ audience: 'example-api' });
    expect(method.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(method.usePkce).toBe(true);
    expect(method.loginScopes).toEqual(['openid', 'email']);
  });

  it('should parse JSON string input', () => {
    const json = JSON.stringify({
      methods: [{ type: 'none' }],
    });
    const result = normalizeConnectorAuthSchema(json);
    expect(result.methods.length).toBe(1);
    expect(result.methods[0].type).toBe('none');
  });

  it('should return default for invalid JSON string', () => {
    const result = normalizeConnectorAuthSchema('not-json');
    expect(result.methods).toEqual([{ type: 'none' }]);
  });

  it('should detect secret keys automatically', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [{ key: 'client_secret' }, { key: 'api_key' }, { key: 'base_url' }],
        },
      ],
    });
    const method = result.methods[0] as any;
    expect(method.fields[0].secret).toBe(true); // client_secret
    expect(method.fields[1].secret).toBe(true); // api_key
    expect(method.fields[2].secret).toBe(false); // base_url
  });

  it('should skip fields with empty keys', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          fields: [{ key: '' }, { key: 'VALID_KEY' }],
        },
      ],
    });
    const method = result.methods[0] as any;
    expect(method.fields.length).toBe(1);
    expect(method.fields[0].key).toBe('VALID_KEY');
  });

  it('should skip oauth methods with empty provider', () => {
    const result = normalizeConnectorAuthSchema({
      methods: [{ type: 'oauth', provider: '', requiredScopes: [] }],
    });
    expect(result.methods).toEqual([{ type: 'none' }]);
  });
});

describe('getOAuthAuthMethods', () => {
  it('should return only oauth methods', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        { type: 'none' },
        { type: 'oauth', provider: 'google', requiredScopes: ['read'] },
        { type: 'env_keys', fields: [{ key: 'API_KEY' }] },
      ],
    });
    const oauthMethods = getOAuthAuthMethods(schema);
    expect(oauthMethods.length).toBe(1);
    expect(oauthMethods[0].provider).toBe('google');
  });
});

describe('getRequiredEnvAuthFields', () => {
  it('should return required fields from env_keys methods', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          required: true,
          fields: [
            { key: 'API_KEY', required: true },
            { key: 'OPTIONAL', required: false },
          ],
        },
      ],
    });
    const fields = getRequiredEnvAuthFields(schema);
    expect(fields.length).toBe(1);
    expect(fields[0].key).toBe('API_KEY');
  });

  it('should return empty for non-required methods', () => {
    const schema = normalizeConnectorAuthSchema({
      methods: [
        {
          type: 'env_keys',
          required: false,
          fields: [{ key: 'API_KEY' }],
        },
      ],
    });
    const fields = getRequiredEnvAuthFields(schema);
    expect(fields.length).toBe(0);
  });
});
