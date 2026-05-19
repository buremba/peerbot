/**
 * Install-operator bootstrap.
 *
 * At first `lobu run` boot, this provisions a synthetic `install_operator`
 * user so headless installs (CI, containers, /tmp scaffolds without a
 * browser) can sign in via better-auth without a chicken-and-egg /sign-up
 * step. The operator's password is the install's `ENCRYPTION_KEY` —
 * already in `.env` for at-rest encryption, now doing double duty as the
 * install secret. See `docs/install-operator-bootstrap.md` for the full
 * design.
 *
 * Idempotent. Safe to call on every boot.
 */

import { hostname } from 'node:os';
import { hashPassword } from 'better-auth/crypto';
import { getDb } from '../db/client';
import { generateSecureToken } from './oauth/utils';
import { ensurePersonalOrganization } from './personal-org-provisioning';

export const INSTALL_OPERATOR_KIND = 'install_operator' as const;

/** Discriminator value for human signups (the default). */
export const HUMAN_KIND = 'human' as const;

/**
 * Shape of the carve-out predicate. Use in any SQL filter that should
 * exclude the install operator from human-discovery surfaces (member
 * lists, password reset, magic link, OAuth account-linking, signup
 * count).
 *
 * The literal string is duplicated in a few SQL call sites for clarity;
 * code paths that already have a typed user row in hand should use
 * `isInstallOperator(user)` instead so the discriminator stays in one
 * place.
 */
export const NOT_INSTALL_OPERATOR_PREDICATE =
  `principal_kind <> '${INSTALL_OPERATOR_KIND}'` as const;

/**
 * True iff the row represents the synthetic install operator. Centralises
 * the carve-out check so every surface that filters humans uses the same
 * discriminator.
 */
export function isInstallOperator(
  row: { principal_kind?: string | null } | null | undefined
): boolean {
  return row?.principal_kind === INSTALL_OPERATOR_KIND;
}

/**
 * Deterministic synthetic email for the install operator. Not a real
 * deliverable address — no password reset / magic link will ever reach
 * it (and the carve-outs in `auth/index.tsx` reject those flows
 * anyway). Using `<hostname>` keeps it stable across reboots on the
 * same host.
 */
export function installOperatorEmail(): string {
  // hostname() can return an empty string in some sandboxes; fall back so
  // we never produce `install@`.
  const host = hostname() || 'localhost';
  return `install@${host}`.toLowerCase();
}

/**
 * Provision the install operator user + credential account + personal
 * org if they don't yet exist. Idempotent.
 *
 * Returns the operator user id (whether it existed or was just created)
 * so callers can chain `ensureDefaultAgent` etc. against the operator's
 * personal org if they want to.
 */
export async function ensureInstallOperator(): Promise<{
  userId: string;
  created: boolean;
}> {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length === 0) {
    throw new Error(
      'ensureInstallOperator: ENCRYPTION_KEY is required. Set it in .env or opt into ephemeral keys with LOBU_ALLOW_EPHEMERAL_ENCRYPTION_KEY=1 (which gateway.ts will generate before this is called).'
    );
  }

  const sql = getDb();

  // Convergent provisioning: every boot ensures each step exists. The
  // user/account rows are immutable (we never re-hash on top of an
  // existing password — that would silently rotate credentials when
  // ENCRYPTION_KEY changed). But the personal-org step lives outside
  // the user-creation txn, so a transient failure there used to leave
  // the operator permanently broken: subsequent boots would see the
  // user row and skip provisioning entirely, and `/api/local-init`
  // would loop forever on `personal_org_missing`. Now we check each
  // step independently and patch missing pieces.
  const existing = (await sql`
    SELECT id FROM "user"
     WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
     LIMIT 1
  `) as unknown as Array<{ id: string }>;

  let userId: string;
  let created: boolean;

  if (existing.length > 0) {
    userId = existing[0]!.id;
    created = false;
  } else {
    userId = `user_install_${generateSecureToken(8)}`;
    const email = installOperatorEmail();
    const hashed = await hashPassword(encryptionKey);

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO "user"
          (id, name, email, "emailVerified", principal_kind, "createdAt", "updatedAt")
        VALUES
          (${userId}, ${'Local Install'}, ${email}, true,
           ${INSTALL_OPERATOR_KIND}, NOW(), NOW())
      `;

      // Better Auth's email-password adapter expects one `account` row
      // per user with providerId='credential' and the hashed password
      // stored in the `password` column. accountId matches userId by
      // convention.
      const accountId = `acct_install_${generateSecureToken(8)}`;
      await tx`
        INSERT INTO "account"
          (id, "accountId", "providerId", "userId", password,
           "createdAt", "updatedAt")
        VALUES
          (${accountId}, ${userId}, 'credential', ${userId}, ${hashed},
           NOW(), NOW())
      `;
    });
    created = true;
  }

  // Personal org provisioning is convergent: ensurePersonalOrganization
  // is itself idempotent (returns the existing org if one is already
  // tagged with this user.id in metadata). Running it on every boot
  // closes the gap where a transient failure on first boot used to
  // leave the operator without a personal org forever.
  const operatorEmail = installOperatorEmail();
  try {
    await ensurePersonalOrganization({
      id: userId,
      email: operatorEmail,
      name: 'Local Install',
      username: null,
    });
  } catch (err) {
    console.error(
      '[install-operator] Personal-org provisioning failed; will retry on next boot:',
      err
    );
  }

  return { userId, created };
}
