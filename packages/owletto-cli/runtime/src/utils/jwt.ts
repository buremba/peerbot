/**
 * JWT utilities for window tokens
 *
 * Window tokens are signed JWTs that encode all query parameters for event fetching.
 * This prevents client manipulation of dates, sources, or filters.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../index';

/**
 * Query parameters stored in window token for deterministic re-query.
 * Since content is immutable, the same query params will always return the same results.
 */
export interface WindowTokenQueryParams {
  limit: number;
  offset: number;
  sort_by: 'date' | 'score';
  sort_order: 'asc' | 'desc';
}

interface WindowTokenPayload {
  watcher_id: number;
  window_id?: number; // Optional - created by complete_window if not present
  window_start: string;
  window_end: string;
  granularity: string; // Required for window creation
  sources: Array<{ name: string; query: string }>;
  query_params: WindowTokenQueryParams; // ensures deterministic re-query
  content_count: number; // Content count at token generation - for staleness detection
  // Condensation/rollup fields
  is_rollup?: boolean; // True when this token is for creating a rollup window
  source_window_ids?: number[]; // IDs of leaf windows being condensed
  depth?: number; // Condensation depth: 0=leaf, 1+=rollup tiers
  iat: number; // issued at - returned to caller for staleness detection
  exp: number; // expiration
}

/**
 * Base64url encode a string
 */
function base64urlEncode(str: string): string {
  const base64 = btoa(str);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Base64url decode a string
 */
function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = str.length % 4;
  const padded = padding ? base64 + '='.repeat(4 - padding) : base64;
  return atob(padded);
}

/**
 * Create HMAC signature using Web Crypto API
 */
async function createSignature(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64urlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

/**
 * Verify HMAC signature using Web Crypto API
 */
async function verifySignature(data: string, signature: string, secret: string): Promise<boolean> {
  const expectedSignature = await createSignature(data, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Get JWT secret from environment
 */
function getJwtSecret(env: Env): string {
  // Use JWT_SECRET if available, otherwise fall back to a derived secret
  const secret = (env as any).JWT_SECRET || (env as any).INSIGHTS_API_KEY;
  if (!secret) {
    throw new Error('JWT_SECRET or INSIGHTS_API_KEY environment variable is required');
  }
  return secret;
}

/**
 * Generate a signed window token
 *
 * @param payload - Token payload containing watcher_id, dates, sources, and window_id
 * @param env - Environment with JWT secret
 * @returns Signed JWT token string
 */
export async function generateWindowToken(
  payload: Omit<WindowTokenPayload, 'iat' | 'exp'>,
  env: Env
): Promise<string> {
  const secret = getJwtSecret(env);
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: WindowTokenPayload = {
    ...payload,
    iat: now,
    exp: now + 3600, // 1 hour
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const headerEncoded = base64urlEncode(JSON.stringify(header));
  const payloadEncoded = base64urlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${headerEncoded}.${payloadEncoded}`;
  const signature = await createSignature(dataToSign, secret);

  return `${dataToSign}.${signature}`;
}

/**
 * Verify and decode a window token
 *
 * @param token - JWT token string
 * @param env - Environment with JWT secret
 * @returns Decoded payload if valid
 * @throws Error if token is invalid or expired
 */
export async function verifyWindowToken(
  token: string,
  env: Env
): Promise<Omit<WindowTokenPayload, 'exp'>> {
  const secret = getJwtSecret(env);
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [headerEncoded, payloadEncoded, signature] = parts;
  const dataToVerify = `${headerEncoded}.${payloadEncoded}`;

  // Verify signature
  const isValid = await verifySignature(dataToVerify, signature, secret);
  if (!isValid) {
    throw new Error('Invalid token signature');
  }

  // Decode payload
  let payload: WindowTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadEncoded));
  } catch {
    throw new Error('Invalid token payload');
  }

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('Token has expired');
  }

  // Return payload with iat (for staleness detection) but without exp
  const { exp, ...rest } = payload;
  return rest;
}
