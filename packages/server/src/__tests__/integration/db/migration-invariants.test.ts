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

    it('event_embeddings carries a NOT NULL embedding_model stamp (#1069/#1080, contract #1372)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'event_embeddings'
          AND column_name = 'embedding_model'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.is_nullable).toBe('NO');
    });

    it('event_embeddings PK is (event_id, embedding_model, chunk_index) (#1372 contract)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ attname: string }[]>`
        SELECT a.attname
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'event_embeddings'
          AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)
      `;
      expect(rows.map((r) => r.attname)).toEqual([
        'event_id',
        'embedding_model',
        'chunk_index',
      ]);
    });

    it('current_event_records is supersession-only — no embedding columns (#1372 contract)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'current_event_records'
          AND column_name IN ('embedding', 'embedding_model')
      `;
      expect(rows).toHaveLength(0);
    });

    it('stale orphan tables entity_read_grant + mcp_proxy_sessions are dropped (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('entity_read_grant', 'mcp_proxy_sessions')
      `;
      expect(rows).toHaveLength(0);
    });

    it('vestigial columns are dropped (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const rows = await sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'agents' AND column_name IN ('agent_integrations', 'skill_registries', 'skill_auto_granted_domains'))
            OR (table_name = 'device_workers' AND column_name IN ('first_seen_at', 'notification_budget_per_day'))
            OR (table_name = 'organization' AND column_name = 'repair_agents_enabled')
          )
      `;
      expect(rows).toHaveLength(0);
    });

    it('missing FK indexes were added and the duplicate token_hash index removed (2026-06-16 audit)', async () => {
      const sql = getTestDb();
      const present = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'idx_runs_window_id',
            'oauth_tokens_parent_token_id_idx',
            'oauth_tokens_organization_id_idx'
          )
      `;
      expect(present.map((r) => r.indexname).sort()).toEqual([
        'idx_runs_window_id',
        'oauth_tokens_organization_id_idx',
        'oauth_tokens_parent_token_id_idx',
      ]);

      // The redundant non-unique copy is gone; the UNIQUE index on token_hash stays.
      const hashIdx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'oauth_tokens'
          AND indexname IN ('oauth_tokens_token_hash_idx', 'oauth_tokens_token_hash_key')
      `;
      expect(hashIdx.map((r) => r.indexname)).toEqual(['oauth_tokens_token_hash_key']);
    });

    it('redundant/dead indexes are dropped while their covering indexes remain (2026-06-16 audit round 2)', async () => {
      const sql = getTestDb();
      // Dropped: idx_events_source_embedding (redundant btree(event_id) before
      // the contract PK became composite),
      // idx_connect_tokens_token (dup of the UNIQUE connect_tokens_token_key),
      // geo_places_location_idx (postgis index superseded by geo_places_earth_idx).
      const dropped = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('idx_events_source_embedding', 'idx_connect_tokens_token', 'geo_places_location_idx')
      `;
      expect(dropped).toHaveLength(0);

      // The covering indexes that make the drops safe must still exist.
      const kept = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('event_embeddings_pkey', 'connect_tokens_token_key', 'geo_places_earth_idx')
      `;
      expect(kept.map((r) => r.indexname).sort()).toEqual([
        'connect_tokens_token_key',
        'event_embeddings_pkey',
        'geo_places_earth_idx',
      ]);
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
