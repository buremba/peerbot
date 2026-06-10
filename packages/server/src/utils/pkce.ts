import { createHash, randomBytes } from "node:crypto";

/**
 * PKCE (RFC 7636) helpers shared by every OAuth flow in the server.
 *
 * Generate a code verifier: 32 random bytes encoded as base64url (43 chars,
 * the RFC minimum).
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** Derive the PKCE S256 code challenge from a verifier. */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
