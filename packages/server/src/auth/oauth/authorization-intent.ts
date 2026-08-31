import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthorizationParams } from './types';

const INTENT_VERSION = 1;
const INTENT_LIFETIME_SECONDS = 10 * 60;
const SIGNING_CONTEXT = 'lobu:oauth-authorization-intent:v1:';

type AuthorizationIntentClaims = AuthorizationParams & {
  version: typeof INTENT_VERSION;
  issued_at: number;
  expires_at: number;
};

function sign(encodedClaims: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${SIGNING_CONTEXT}${encodedClaims}`)
    .digest('base64url');
}

/**
 * Bind the consent screen to the request that passed the authorization
 * endpoint's client, redirect, PKCE, scope, and resource validation.
 *
 * The token is intentionally self-contained so it verifies on every replica.
 * Authorization codes remain the one-time protocol artifact; this short-lived
 * intent prevents the browser from widening or retargeting the validated
 * request before a code is minted.
 */
export function createAuthorizationIntent(
  params: AuthorizationParams,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  if (!secret) throw new Error('OAuth authorization intent signing secret is required');
  const claims: AuthorizationIntentClaims = {
    ...params,
    version: INTENT_VERSION,
    issued_at: nowSeconds,
    expires_at: nowSeconds + INTENT_LIFETIME_SECONDS,
  };
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encodedClaims}.${sign(encodedClaims, secret)}`;
}

export function verifyAuthorizationIntent(
  token: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): AuthorizationParams | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedClaims, presentedSignature] = parts;
  if (!encodedClaims || !presentedSignature) return null;

  const expectedSignature = sign(encodedClaims, secret);
  const presented = Buffer.from(presentedSignature);
  const expected = Buffer.from(expectedSignature);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

  let claims: AuthorizationIntentClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    claims.version !== INTENT_VERSION ||
    !Number.isInteger(claims.issued_at) ||
    !Number.isInteger(claims.expires_at) ||
    claims.issued_at > nowSeconds + 60 ||
    claims.expires_at < nowSeconds ||
    claims.response_type !== 'code' ||
    claims.code_challenge_method !== 'S256' ||
    typeof claims.client_id !== 'string' ||
    !claims.client_id ||
    typeof claims.redirect_uri !== 'string' ||
    !claims.redirect_uri ||
    typeof claims.code_challenge !== 'string' ||
    !claims.code_challenge ||
    typeof claims.scope !== 'string' ||
    !claims.scope
  ) {
    return null;
  }
  if (claims.state !== undefined && typeof claims.state !== 'string') return null;
  if (claims.resource !== undefined && typeof claims.resource !== 'string') return null;

  return {
    client_id: claims.client_id,
    redirect_uri: claims.redirect_uri,
    response_type: 'code',
    scope: claims.scope,
    state: claims.state,
    code_challenge: claims.code_challenge,
    code_challenge_method: 'S256',
    resource: claims.resource,
  };
}
