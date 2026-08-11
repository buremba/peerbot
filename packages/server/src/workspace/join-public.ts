import { generateSecureToken } from '../auth/oauth/utils';
import { getDb } from '../db/client';
import { ensureMemberEntity } from '../utils/member-entity';
import { recordWorkspaceChangeEvent } from '../utils/insert-event';
import logger from '../utils/logger';
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
 * Self-serve join for a public organization. Used by the REST /join endpoint.
 * Idempotent.
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
  // ON CONFLICT DO NOTHING + RETURNING: when a concurrent request wins the
  // race and already inserted this member, no row is returned and we must NOT
  // emit an audit event for a phantom (never-inserted) member id.
  const inserted = (await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES (${memberId}, ${organizationId}, ${userId}, 'member', NOW())
    ON CONFLICT ("organizationId", "userId") DO NOTHING
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  if (inserted.length === 0) {
    return { status: 'already_member', organizationId, role: 'member' };
  }
  const committedMemberId = inserted[0].id;

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
    // Drift risk: the member row is already committed above, so a failure here
    // leaves them without a resolvable $member claim and the authz gate hides
    // every enforced channel from them. Structured to correlate with the drift
    // detector; non-fatal so the join still succeeds.
    logger.error(
      { err, event: 'member_claim_drift', hook: 'joinPublicOrganization', organizationId, userId },
      '[joinPublicOrganization] Failed to create $member entity',
    );
  }

  invalidateMembershipRoleCache(organizationId, userId);

  // The member row is already committed above; the $member projection failure
  // is caught and non-fatal, so emitting the audit trail here cannot be
  // suppressed by it. `user` is the joining member — the actor of this
  // self-service join.
  recordWorkspaceChangeEvent({
    organizationId,
    resourceKind: 'member',
    resourceId: committedMemberId,
    op: 'created',
    summary: `Member "${user.name || 'a member'}" joined public workspace`,
    state: { id: committedMemberId, user_id: userId, role: 'member' },
    changedFields: ['user_id', 'role'],
    actorSource: 'ui',
    createdBy: userId,
  });

  return { status: 'joined', organizationId, role: 'member' };
}
