import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db/client';
import logger from '../utils/logger';

/**
 * Generate a short-lived OAuth access token from Lobu's own auth system.
 * Embedded Lobu accepts this via the external auth bridge.
 */
export async function getLobuServiceToken(organizationId?: string): Promise<string | null> {
  const sql = getDb();

  // Fail closed without an org — picking "any owner/admin from any org" would
  // mint a token acting as a random tenant's admin (cross-tenant authority leak).
  if (typeof organizationId !== 'string' || organizationId.trim().length === 0) {
    logger.warn('[lobu] getLobuServiceToken called without an organizationId — refusing');
    return null;
  }

  try {
    const [user] = await sql`
      SELECT m."userId" as user_id, m."organizationId" as org_id
      FROM member m
      WHERE m.role IN ('owner', 'admin')
        AND m."organizationId" = ${organizationId}
      LIMIT 1
    `;

    if (!user) return null;

    // The internal service token is keyed to a `lobu-internal` oauth_client via
    // oauth_tokens.client_id (FK → oauth_clients.id). That system client isn't
    // created by any migration or signup flow, so on a fresh DB — notably the
    // embedded `lobu run` one — the token INSERT below would fail the FK and
    // every watcher dispatch / notification would error ("Failed to generate an
    // embedded Lobu service token"). Ensure it exists (idempotent); it's a
    // credential-less system client used only as the FK anchor for these
    // short-lived internal tokens, never in a real OAuth grant.
    await sql`
      INSERT INTO oauth_clients (id, redirect_uris, client_name, token_endpoint_auth_method)
      VALUES ('lobu-internal', '{}'::text[], 'Lobu Internal Service', 'none')
      ON CONFLICT (id) DO NOTHING
    `;

    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const id = randomBytes(16).toString('hex');

    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id, scope, expires_at
      )
      VALUES (
        ${id},
        'access',
        ${tokenHash},
        'lobu-internal',
        ${user.user_id},
        ${user.org_id},
        'profile:read',
        NOW() + INTERVAL '1 minute'
      )
    `;

    return token;
  } catch (error) {
    logger.warn({ error, organizationId }, '[lobu] Failed to generate service token');
    return null;
  }
}
