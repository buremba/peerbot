import { generateSecureToken } from '../auth/oauth/utils';
import { getDb } from '../db/client';
import { ensureMemberEntity } from '../utils/member-entity';
import { invalidateMembershipRoleCache } from './multi-tenant';

type JoinPublicResult =
  | { status: 'joined' | 'already_member'; organizationId: string; role: string }
  | { status: 'not_found' }
  | { status: 'not_public' };

interface JoinPublicParams {
  userId: string;
  orgSlug: string;
}

/**
 * Self-serve join for a public organization. Used by the REST /join endpoint
 * and the join_organization MCP tool. Idempotent.
 *
 * Replicates the side effects of Better Auth's afterAddMember hook
 * (ensureMemberEntity + invalidateMembershipRoleCache) since Better Auth's
 * addMember API is admin-gated and can't be used for self-service.
 */
export async function joinPublicOrganization({
  userId,
  orgSlug,
}: JoinPublicParams): Promise<JoinPublicResult> {
  const sql = getDb();

  const orgRows = await sql<{
    id: string;
    visibility: string;
  }>`
    SELECT id, visibility FROM "organization"
    WHERE slug = ${orgSlug}
    LIMIT 1
  `;
  if (orgRows.length === 0) return { status: 'not_found' };
  const { id: organizationId, visibility } = orgRows[0];
  if (visibility !== 'public') return { status: 'not_public' };

  const existing = await sql<{ role: string }>`
    SELECT role FROM "member"
    WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    return {
      status: 'already_member',
      organizationId,
      role: existing[0].role,
    };
  }

  const userRows = await sql<{
    id: string;
    name: string;
    email: string;
    image: string | null;
  }>`
    SELECT id, name, email, image FROM "user"
    WHERE id = ${userId}
    LIMIT 1
  `;
  if (userRows.length === 0) return { status: 'not_found' };
  const user = userRows[0];

  const memberId = `member_${generateSecureToken(8)}`;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${memberId}, ${organizationId}, ${userId}, 'member', NOW())
    ON CONFLICT ("organizationId", "userId") DO NOTHING
  `;

  try {
    await ensureMemberEntity({
      organizationId,
      userId,
      name: user.name || user.email,
      email: user.email,
      image: user.image ?? undefined,
      role: 'member',
      status: 'active',
    });
  } catch (err) {
    console.error('[joinPublicOrganization] Failed to create $member entity:', err);
  }

  invalidateMembershipRoleCache(organizationId, userId);

  return { status: 'joined', organizationId, role: 'member' };
}
