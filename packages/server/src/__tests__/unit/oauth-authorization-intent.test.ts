import { describe, expect, it } from 'bun:test';
import {
  createAuthorizationIntent,
  verifyAuthorizationIntent,
} from '../../auth/oauth/authorization-intent';

const SECRET = 'test-authorization-intent-secret';
const NOW = 1_700_000_000;
const PARAMS = {
  client_id: 'client-1',
  redirect_uri: 'https://client.example/callback',
  response_type: 'code' as const,
  scope: 'mcp:read mcp:write',
  state: 'state-1',
  code_challenge: 'challenge-1',
  code_challenge_method: 'S256' as const,
  resource: 'https://lobu.example/mcp/acme',
};

describe('OAuth authorization intent', () => {
  it('round-trips the validated authorization request', () => {
    const token = createAuthorizationIntent(PARAMS, SECRET, NOW);
    expect(verifyAuthorizationIntent(token, SECRET, NOW + 30)).toEqual(PARAMS);
  });

  it('rejects tampering and a different signing secret', () => {
    const token = createAuthorizationIntent(PARAMS, SECRET, NOW);
    const [payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        ...PARAMS,
        scope: 'mcp:read mcp:write mcp:admin',
        version: 1,
        issued_at: NOW,
        expires_at: NOW + 600,
      })
    ).toString('base64url');
    expect(verifyAuthorizationIntent(`${tamperedPayload}.${signature}`, SECRET, NOW)).toBeNull();
    expect(verifyAuthorizationIntent(`${payload}.${signature}`, 'different-secret', NOW)).toBeNull();
  });

  it('rejects expired and malformed intents', () => {
    const token = createAuthorizationIntent(PARAMS, SECRET, NOW);
    expect(verifyAuthorizationIntent(token, SECRET, NOW + 601)).toBeNull();
    expect(verifyAuthorizationIntent('not-an-intent', SECRET, NOW)).toBeNull();
  });
});
