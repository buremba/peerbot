/**
 * Integration test for `auth/install-operator.ts`.
 *
 * Pins the idempotency contract (re-running ensureInstallOperator on a
 * boot where the operator already exists is a no-op) and validates that
 * the provisioned account row is sign-in-ready (correct providerId,
 * verifiable password hash).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { verifyPassword } from 'better-auth/crypto';
import {
  INSTALL_OPERATOR_KIND,
  ensureInstallOperator,
} from '../../../auth/install-operator';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('ensureInstallOperator', () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  // Canonical 32-byte hex (64 chars) so it passes `assertEncryptionKey`
  // — `ensureInstallOperator` now refuses to bootstrap with a malformed
  // key, since the runtime encryption path would reject it later.
  const VALID_KEY = 'a'.repeat(64);

  beforeEach(async () => {
    await cleanupTestDatabase();
    // Stable, deterministic test secret so verifyPassword can be checked.
    process.env.ENCRYPTION_KEY = VALID_KEY;
  });

  it('creates the install_operator user + credential account on a fresh DB', async () => {
    const { userId, created } = await ensureInstallOperator();
    expect(created).toBe(true);
    expect(userId.startsWith('user_install_')).toBe(true);

    const sql = getTestDb();
    const users = (await sql`
      SELECT id, email, principal_kind FROM "user" WHERE id = ${userId}
    `) as unknown as Array<{ id: string; email: string; principal_kind: string }>;
    expect(users).toHaveLength(1);
    expect(users[0]!.principal_kind).toBe(INSTALL_OPERATOR_KIND);
    expect(users[0]!.email.startsWith('install@')).toBe(true);

    const accounts = (await sql`
      SELECT "providerId", password FROM "account" WHERE "userId" = ${userId}
    `) as unknown as Array<{ providerId: string; password: string | null }>;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.providerId).toBe('credential');
    expect(accounts[0]!.password).toBeTruthy();

    // The stored hash must verify against ENCRYPTION_KEY — that's the
    // entire point of the bootstrap, so guard it explicitly.
    const ok = await verifyPassword({
      hash: accounts[0]!.password!,
      password: process.env.ENCRYPTION_KEY!,
    });
    expect(ok).toBe(true);
  });

  it('is idempotent: running twice produces exactly one user + account', async () => {
    const first = await ensureInstallOperator();
    const second = await ensureInstallOperator();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.userId).toBe(first.userId);

    const sql = getTestDb();
    const users = (await sql`
      SELECT id FROM "user" WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
    `) as unknown as Array<unknown>;
    expect(users).toHaveLength(1);

    const accounts = (await sql`
      SELECT id FROM "account" WHERE "userId" = ${first.userId}
    `) as unknown as Array<unknown>;
    expect(accounts).toHaveLength(1);
  });

  it('throws when ENCRYPTION_KEY is missing', async () => {
    delete process.env.ENCRYPTION_KEY;
    await expect(ensureInstallOperator()).rejects.toThrow(/ENCRYPTION_KEY is required/);
    // Restore for any cleanup hook that needs it.
    process.env.ENCRYPTION_KEY = originalEncryptionKey ?? VALID_KEY;
  });

  it('refuses to bootstrap when ENCRYPTION_KEY is malformed', async () => {
    // 24-byte base64 (length 32 chars) — passes `hashPassword` but the
    // runtime encrypt/decrypt path requires a canonical 32-byte key.
    // The bootstrap must reject the same shape so the user isn't left
    // with an operator that can sign in but can't save any encrypted
    // secret (every save would 500 with the same canonical message).
    process.env.ENCRYPTION_KEY = 'not-a-canonical-32-byte-key';
    await expect(ensureInstallOperator()).rejects.toThrow(
      /canonical base64 or hex encoded 32-byte key/
    );

    // No user/account rows should have been created.
    const sql = getTestDb();
    const users = (await sql`
      SELECT id FROM "user" WHERE principal_kind = ${INSTALL_OPERATOR_KIND}
    `) as unknown as Array<unknown>;
    expect(users).toHaveLength(0);

    process.env.ENCRYPTION_KEY = VALID_KEY;
  });

  it('provisions a personal organization for the operator', async () => {
    const { userId } = await ensureInstallOperator();

    const sql = getTestDb();
    const orgs = (await sql`
      SELECT id FROM "organization"
       WHERE (metadata::jsonb)->>'personal_org_for_user_id' = ${userId}
    `) as unknown as Array<{ id: string }>;
    expect(orgs.length).toBeGreaterThanOrEqual(1);
  });
});
