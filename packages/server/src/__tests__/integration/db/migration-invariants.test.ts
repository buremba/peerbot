/**
 * Migration-invariant guard.
 *
 * The test harness applies the real baseline -> latest migration chain before
 * any test runs (setup/test-db.ts). This suite asserts the load-bearing schema
 * invariants that recent migrations established, so a future migration that
 * silently drops or reshapes one fails CI here rather than in production.
 *
 * Motivated by the 2-week stability audit:
 *  - #1121 reshaped pending-auth uniqueness from org-wide to per-user, scoped to
 *    oauth_account. The functional contract (same user collides, distinct users
 *    run parallel OAuth flows) is the real invariant — pin it, not just the DDL.
 *  - #1069/#1080 added event_embeddings.embedding_model; its absence reopens the
 *    full-corpus recall regression.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthProfile, PendingAuthConflictError } from '../../../utils/auth-profiles';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('migration invariants', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  describe('schema (DDL applied by the migration chain)', () => {
    it('auth_profiles has the per-user pending oauth_account unique index (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_oauth_account_unique'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      expect(def).toContain('UNIQUE');
      // per-user, per-connector, per-provider scope
      for (const col of ['organization_id', 'connector_key', 'provider', 'created_by']) {
        expect(def).toContain(col);
      }
      // partial predicate: only in-flight oauth_account rows
      expect(def).toContain("'pending_auth'");
      expect(def).toContain("'oauth_account'");
    });

    it('the old org-wide auth_profiles_pending_unique index is gone (#1121)', async () => {
      const sql = getTestDb();
      const rows = await sql`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'auth_profiles'
          AND indexname = 'auth_profiles_pending_unique'
      `;
      expect(rows).toHaveLength(0);
    });

    it('event_embeddings carries the embedding_model stamp column (#1069/#1080)', async () => {
      const sql = getTestDb();
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'event_embeddings'
          AND column_name = 'embedding_model'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe('functional contract: pending oauth_account uniqueness is per-user (#1121)', () => {
    let orgId: string;
    let userA: string;
    let userB: string;
    const connectorKey = 'invariant-oauth-connector';
    const provider = 'google';

    beforeAll(async () => {
      const org = await createTestOrganization({ name: 'Migration Invariant Org' });
      orgId = org.id;
      const a = await createTestUser({ email: 'invariant-user-a@example.com' });
      const b = await createTestUser({ email: 'invariant-user-b@example.com' });
      userA = a.id;
      userB = b.id;
      await addUserToOrganization(userA, orgId, 'member');
      await addUserToOrganization(userB, orgId, 'member');
      await createTestConnectorDefinition({
        key: connectorKey,
        name: 'Invariant OAuth',
        organization_id: orgId,
      });
    });

    async function createPending(createdBy: string) {
      return createAuthProfile({
        organizationId: orgId,
        connectorKey,
        displayName: 'Invariant pending',
        profileKind: 'oauth_account',
        provider,
        status: 'pending_auth',
        createdBy,
      });
    }

    it('a user cannot open two parallel pending flows for the same connector', async () => {
      await createPending(userA);
      await expect(createPending(userA)).rejects.toBeInstanceOf(PendingAuthConflictError);
    });

    it('distinct users CAN run pending flows for the same connector in parallel', async () => {
      const profile = await createPending(userB);
      expect(profile.status).toBe('pending_auth');
      expect(profile.created_by).toBe(userB);
    });
  });
});
