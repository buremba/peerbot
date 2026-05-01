/**
 * Auto-provision a private personal organization for every newly created user.
 *
 * Mirrors the "filing cabinet" model: each user gets their own private org
 * (their data) which template agents (e.g. examples/personal-finance) can be
 * installed into. Without this, a user landing on the app has no workspace
 * to receive auto-installed agents or per-user mirrored schemas.
 */

import { getDb } from '../db/client';
import { generateSecureToken } from './oauth/utils';
import { provisionMemberAndCoreIdentities } from './subject-identities';

interface UserLike {
  id: string;
  email?: string | null;
  name?: string | null;
  username?: string | null;
}

// Mirrors the org_slug_not_reserved CHECK constraint added in
// 20260420120000_extend_reserved_org_slugs.sql. Inserts that hit a reserved
// slug raise a constraint violation, so the candidate-derivation layer must
// avoid them up front.
export const RESERVED_SLUGS = new Set([
  'settings',
  'auth',
  'api',
  'templates',
  'help',
  'account',
  'admin',
  'health',
  'login',
  'logout',
  'signup',
  'register',
  'www',
  'mcp',
  'static',
  'assets',
  'cdn',
  'docs',
  'mail',
]);

const MAX_SLUG_LENGTH = 48;
const MAX_COLLISION_ATTEMPTS = 100;
// Namespace for pg_advisory_xact_lock(key1, key2). Kept in the signed int32
// range required by PostgreSQL's two-key advisory lock overload.
const PERSONAL_ORG_LOCK_NAMESPACE = 0x706f7267; // "porg"

type Sql = ReturnType<typeof getDb>;

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

export function deriveSlugCandidate(user: UserLike): string {
  const candidates = [user.username, user.name, user.email?.split('@')[0]];
  for (const raw of candidates) {
    if (!raw) continue;
    const s = slugify(raw);
    if (s) return s;
  }
  return `user-${user.id.slice(0, 8).toLowerCase()}`;
}

async function findAvailableSlug(base: string, sql: Sql): Promise<string> {
  const safeBase = RESERVED_SLUGS.has(base) ? `${base}-1` : base;
  let candidate = safeBase;
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
    if (!RESERVED_SLUGS.has(candidate)) {
      const rows = await sql`
        SELECT 1 FROM "organization" WHERE slug = ${candidate} LIMIT 1
      `;
      if (rows.length === 0) return candidate;
    }
    candidate = `${safeBase}-${attempt + 2}`;
  }
  // Last-resort suffix — astronomically unlikely to reach this branch.
  return `${safeBase}-${generateSecureToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

interface EnsureResult {
  organizationId: string;
  slug: string;
  created: boolean;
}

export function personalOrgLockKey(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

async function lockPersonalOrgForUser(userId: string, sql: Sql): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      ${PERSONAL_ORG_LOCK_NAMESPACE},
      ${personalOrgLockKey(userId)}
    )
  `;
}

async function findExistingPersonalOrg(
  userId: string,
  sql: Sql
): Promise<{ id: string; slug: string } | null> {
  // Idempotency: an org tagged with this user.id in metadata is already this
  // user's personal one. Re-running the hook (e.g. after a transient failure)
  // is a no-op. The ORDER BY keeps resolution deterministic if legacy data ever
  // contains duplicates.
  // organization.metadata is `text` storing JSON; cast to jsonb and use ->>
  // instead of LIKE so a userId containing % or _ can't match unintended rows.
  const existing = await sql`
    SELECT id, slug FROM "organization"
    WHERE metadata IS NOT NULL
      AND (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
    ORDER BY "createdAt" ASC, id ASC
    LIMIT 1
  `;
  if (existing.length === 0) return null;
  return existing[0] as { id: string; slug: string };
}

export async function ensurePersonalOrganization(user: UserLike): Promise<EnsureResult> {
  const sql = getDb();
  let result: EnsureResult | null = null;

  await sql.begin(async (tx) => {
    await lockPersonalOrgForUser(user.id, tx);

    const existing = await findExistingPersonalOrg(user.id, tx);
    if (existing) {
      result = { organizationId: existing.id, slug: existing.slug, created: false };
      return;
    }

    const baseSlug = deriveSlugCandidate(user);
    const slug = await findAvailableSlug(baseSlug, tx);
    const orgId = `org_${generateSecureToken(8)}`;
    const memberId = `member_${generateSecureToken(8)}`;
    const orgName = user.name?.trim() || user.email?.split('@')[0] || slug;
    const metadata = JSON.stringify({ personal_org_for_user_id: user.id });

    await tx`
      INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
      VALUES (${orgId}, ${orgName}, ${slug}, 'private', ${metadata}, NOW())
    `;
    await tx`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (${memberId}, ${user.id}, ${orgId}, 'owner', NOW())
    `;

    result = { organizationId: orgId, slug, created: true };
  });

  const finalResult = result as EnsureResult | null;
  if (!finalResult) {
    throw new Error('Personal organization transaction did not produce a result');
  }

  // Provision the $member entity + core identifiers (auth_user_id, email)
  // outside the transaction. ensureMemberEntity uses createEntity which
  // manages its own transaction and seeds the $member entity type if absent.
  // Failures here shouldn't roll back the org creation — the user has a
  // valid org, identity rows can be backfilled later. Run this for both newly
  // created and pre-existing personal orgs; the helper is idempotent.
  if (user.email) {
    try {
      await provisionMemberAndCoreIdentities(finalResult.organizationId, {
        userId: user.id,
        email: user.email,
        name: user.name,
      });
    } catch (error) {
      console.error('[Auth] Failed to provision $member entity for personal org:', {
        orgId: finalResult.organizationId,
        userId: user.id,
        error: String(error),
      });
    }
  }

  return finalResult;
}
