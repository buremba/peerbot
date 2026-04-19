import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db/client';
import logger from '../utils/logger';

/**
 * Generate a short-lived OAuth access token from Owletto's own auth system.
 * Embedded Lobu accepts this via the external auth bridge.
 */
export async function getLobuServiceToken(organizationId?: string): Promise<string | null> {
  const sql = getDb();

  try {
    const orgFilter =
      typeof organizationId === 'string' && organizationId.trim().length > 0
        ? sql`AND m."organizationId" = ${organizationId}`
        : sql``;

    const [user] = await sql`
      SELECT m."userId" as user_id, m."organizationId" as org_id
      FROM member m
      WHERE m.role IN ('owner', 'admin')
      ${orgFilter}
      LIMIT 1
    `;

    if (!user) return null;

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
        'owletto-internal',
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
