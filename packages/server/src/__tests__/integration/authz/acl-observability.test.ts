/**
 * ACL observability — integration tests against real Postgres.
 *
 * Pins the three surfaces of ACL-failure observability:
 *  1. a failing ACL sync persists its reason on `connections.error_message`
 *     under the `acl: ` prefix, never clobbers another subsystem's text, and
 *     clears only ACL-owned text once the sync recovers;
 *  2. a connection whose ACL graph is fail-closed
 *     (`authz_source_acl_state.freshness_state='failed'`) is flagged
 *     `acl_failed` by the connector-health alerter, alerting exactly once per
 *     episode through the existing `unhealthy_alerted_at` claim;
 *  3. deleting a connection removes its `authz_source_acl_state` row.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearConnectionAclError,
  formatAclErrorMessage,
  isAclErrorMessage,
} from '../../../authz/acl-observability';
import { syncGithubConnectionAcl } from '../../../authz/github-acl-sync';
import { runConnectorHealthCheck } from '../../../connectors/connector-health';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

// The connector-health scan skips connections younger than
// minConnectionAgeHours (24h default); backdate fixtures so the ACL rule runs.
const OLD = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

async function seedAclFailedConnection(opts: {
  orgId: string;
  errorMessage: string;
}): Promise<{ id: number }> {
  const sql = getTestDb();
  const conn = await createTestConnection({
    organization_id: opts.orgId,
    connector_key: 'github',
    visibility: 'org',
    createDefaultFeed: false,
  });
  await sql`
    UPDATE connections SET created_at = ${OLD()}, updated_at = ${OLD()} WHERE id = ${conn.id}
  `;
  // A healthy feed, so no FEED rule can be what flags the connection — only the
  // fail-closed ACL state may.
  await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status, kind, virtual,
      last_sync_status, last_sync_at, consecutive_failures, created_at, updated_at
    ) VALUES (
      ${opts.orgId}, ${conn.id}, 'ok', 'active', 'collected', false,
      'success', now(), 0, now(), now()
    )
  `;
  await sql`
    INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
    VALUES (${opts.orgId}, ${String(conn.id)}, 'full', 'failed', now() - interval '1 hour')
  `;
  await sql`
    UPDATE connections SET error_message = ${opts.errorMessage} WHERE id = ${conn.id}
  `;
  return { id: conn.id };
}

describe('acl observability', () => {
  afterAll(async () => {
    await cleanupTestDatabase();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  describe('failure reason persistence', () => {
    it('persists an acl:-prefixed failure reason when a sync fails', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Reason Org' });
      const conn = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        visibility: 'org',
        createDefaultFeed: false,
      });
      await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;

      // Drive the production sync path with a failing GitHub call.
      const result = await syncGithubConnectionAcl(
        {
          listRepos: async () => [{ owner: 'acme', repo: 'repo-a' }],
          fetchCollaborators: async () => {
            throw new Error('401 Unauthorized — GitHub token is not valid');
          },
        },
        { connectionId: String(conn.id), organizationId: org.id },
      );
      expect(result.ok).toBe(false);

      const [state] = await sql`
        SELECT freshness_state FROM authz_source_acl_state
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
      expect(state?.freshness_state).toBe('failed');

      const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
      expect(isAclErrorMessage(row?.error_message)).toBe(true);
      expect(row?.error_message).toContain('GitHub ACL sync failed');
      expect(row?.error_message).toContain('401 Unauthorized');
    });

    it('caps the complete persisted failure message at 500 characters', () => {
      expect(formatAclErrorMessage('x'.repeat(1_000))).toHaveLength(500);
    });

    it('never clobbers a non-ACL error_message when an ACL sync fails', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Collision Org' });
      const conn = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        visibility: 'org',
        createDefaultFeed: false,
      });
      await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state, last_synced_at)
        VALUES (${org.id}, ${String(conn.id)}, 'full', 'fresh', now())
      `;
      // A feed-sync owned message occupies the shared column.
      await sql`
        UPDATE connections SET error_message = 'Feed sync failed: HTTP 429 rate limited' WHERE id = ${conn.id}
      `;

      await syncGithubConnectionAcl(
        {
          listRepos: async () => [{ owner: 'acme', repo: 'repo-a' }],
          fetchCollaborators: async () => {
            throw new Error('401 Unauthorized');
          },
        },
        { connectionId: String(conn.id), organizationId: org.id },
      );

      const [row] = await sql`
        SELECT error_message FROM connections WHERE id = ${conn.id}
      `;
      expect(row?.error_message).toBe('Feed sync failed: HTTP 429 rate limited');
    });

    it('clears only acl:-owned text once the sync recovers', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Clear Org' });
      const aclOwned = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        display_name: 'Acl-owned Conn',
        createDefaultFeed: false,
      });
      const feedOwned = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        display_name: 'Feed-owned Conn',
        createDefaultFeed: false,
      });
      await sql`
        UPDATE connections SET error_message = ${formatAclErrorMessage('GitHub ACL sync failed: 401')} WHERE id = ${aclOwned.id}
      `;
      await sql`
        UPDATE connections SET error_message = 'Feed sync failed: HTTP 429' WHERE id = ${feedOwned.id}
      `;

      await clearConnectionAclError(org.id, String(aclOwned.id));
      await clearConnectionAclError(org.id, String(feedOwned.id));

      const [afterAcl, afterFeed] = await Promise.all([
        sql`SELECT error_message FROM connections WHERE id = ${aclOwned.id}`,
        sql`SELECT error_message FROM connections WHERE id = ${feedOwned.id}`,
      ]);
      expect(afterAcl[0]?.error_message).toBeNull();
      expect(afterFeed[0]?.error_message).toBe('Feed sync failed: HTTP 429');
    });
  });

  describe('connector-health alerting', () => {
    it('alerts once on the transition into acl_failed', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Alert Org' });
      const conn = await seedAclFailedConnection({
        orgId: org.id,
        errorMessage: formatAclErrorMessage('GitHub ACL sync failed: 401 Unauthorized'),
      });

      const result = await runConnectorHealthCheck();
      const detail = result.details.find((d) => d.connectionId === conn.id);
      expect(detail?.reason).toBe('acl_failed');
      expect(detail?.lastError).toContain('GitHub ACL sync failed');
      expect(result.newlyAlerted).toBeGreaterThan(0);
      expect(result.authNotified).toBe(0);

      const [row] = await sql`
        SELECT unhealthy_alerted_at FROM connections WHERE id = ${conn.id}
      `;
      expect(row?.unhealthy_alerted_at).not.toBeNull();
    });

    it('does not attribute a chat runtime ACL failure to a colliding data slug', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Collision Health Org' });
      const data = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        slug: 'shared-runtime-id',
        createDefaultFeed: false,
      });
      const chat = await createTestConnection({
        organization_id: org.id,
        connector_key: 'slack',
        slug: 'agentconn-shared-runtime-id',
        createDefaultFeed: false,
      });
      await sql`
        UPDATE connections
        SET created_at = ${OLD()}, updated_at = ${OLD()},
            credential_mode = CASE WHEN id = ${chat.id} THEN 'byo' ELSE credential_mode END
        WHERE id IN (${data.id}, ${chat.id})
      `;
      await sql`
        INSERT INTO feeds (
          organization_id, connection_id, feed_key, status, kind, virtual,
          last_sync_status, last_sync_at, consecutive_failures, created_at, updated_at
        ) VALUES (
          ${org.id}, ${data.id}, 'ok', 'active', 'collected', false,
          'success', now(), 0, now(), now()
        )
      `;
      await sql`
        INSERT INTO authz_source_acl_state (
          organization_id, connection_id, acl_support, freshness_state
        ) VALUES (${org.id}, 'shared-runtime-id', 'full', 'failed')
      `;

      const result = await runConnectorHealthCheck();
      expect(result.details.find((detail) => detail.connectionId === data.id)).toBeUndefined();
      expect(result.details.find((detail) => detail.connectionId === chat.id)?.reason).toBe(
        'acl_failed',
      );
    });

    it('does not double-alert while still acl_failed, and re-alerts after recovery', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Dedupe Org' });
      const conn = await seedAclFailedConnection({
        orgId: org.id,
        errorMessage: formatAclErrorMessage('GitHub ACL sync failed: 401 Unauthorized'),
      });

      const first = await runConnectorHealthCheck();
      expect(first.details.some((d) => d.connectionId === conn.id)).toBe(true);
      expect(first.newlyAlerted).toBeGreaterThan(0);

      // Still unhealthy → no second alert (the unhealthy_alerted_at claim).
      const second = await runConnectorHealthCheck();
      expect(second.details.some((d) => d.connectionId === conn.id)).toBe(true);
      expect(second.newlyAlerted).toBe(0);

      // Recovery re-arms the marker...
      await sql`
        UPDATE authz_source_acl_state
        SET freshness_state = 'fresh', last_synced_at = now(), updated_at = now()
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
      const afterRecovery = await runConnectorHealthCheck();
      expect(afterRecovery.recovered).toBeGreaterThan(0);
      const [cleared] = await sql`
        SELECT unhealthy_alerted_at FROM connections WHERE id = ${conn.id}
      `;
      expect(cleared?.unhealthy_alerted_at).toBeNull();

      // ...and a fresh failure alerts again (NULL→set transition once more).
      await sql`
        UPDATE authz_source_acl_state
        SET freshness_state = 'failed', updated_at = now()
        WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
      `;
      const broken = await runConnectorHealthCheck();
      expect(broken.newlyAlerted).toBeGreaterThan(0);
    });
  });

  describe('orphan cleanup', () => {
    it('deleting a connection removes only its ACL row', async () => {
      const sql = getTestDb();
      const org = await createTestOrganization({ name: 'Acl Delete Org' });
      const user = await createTestUser({ name: 'Owner', email: 'acl-delete@example.com' });
      await addUserToOrganization(user.id, org.id, 'owner');
      const conn = await createTestConnection({
        organization_id: org.id,
        connector_key: 'github',
        slug: 'unrelated-chat-runtime',
        visibility: 'org',
        createDefaultFeed: false,
      });
      const [{ slug }] = await sql<{ slug: string }>`
        SELECT slug FROM connections WHERE id = ${conn.id}
      `;
      // The numeric key belongs to this data connection. The slug-shaped key
      // simulates a different chat runtime id and must survive this deletion.
      await sql`
        INSERT INTO authz_source_acl_state (organization_id, connection_id, acl_support, freshness_state)
        VALUES
          (${org.id}, ${String(conn.id)}, 'full', 'fresh'),
          (${org.id}, ${slug}, 'full', 'failed')
      `;

      const client = await TestApiClient.for({
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
      });
      const result = (await client.connections.delete(conn.id)) as { deleted?: boolean };
      expect(result.deleted).toBe(true);

      const [tombstoned] = await sql`
        SELECT deleted_at FROM connections WHERE id = ${conn.id}
      `;
      expect(tombstoned?.deleted_at).not.toBeNull();

      const remaining = await sql`
        SELECT connection_id FROM authz_source_acl_state
        WHERE organization_id = ${org.id}
          AND connection_id IN (${String(conn.id)}, ${slug})
      `;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.connection_id).toBe(slug);
    });
  });
});
