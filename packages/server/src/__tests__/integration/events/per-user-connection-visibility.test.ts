/**
 * S0 integration proof (real Postgres rows): the buildScopedQuery seam
 * (query_sql / client.query / metrics) must enforce PER-USER connection
 * visibility, not just org scope. Two users each own a PRIVATE connection;
 * a third connection is org-visible. Each user must see org-visible events +
 * their OWN private-connection events — never the other user's private data.
 *
 * Before S0, this seam applied org scope only, so `userA` saw `userB`'s
 * private-connection events (the leak). After S0 it threads the requesting
 * user through buildConnectionVisibilityClause, matching what
 * search_memory/get_content already enforce.
 */

import { describe, expect, it } from 'vitest';
import { validateAndScopeQuery } from '../../../utils/execute-data-sources';
import { getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestEvent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function originIdsVisibleTo(orgId: string, userId: string | null): Promise<string[]> {
  const { sql, params } = validateAndScopeQuery('SELECT origin_id FROM events', orgId, {
    userId,
  });
  const rows = await getTestDb().unsafe(sql, params as unknown[]);
  return rows.map((r: Record<string, unknown>) => String(r.origin_id));
}

async function connectionIdsVisibleTo(orgId: string, userId: string | null): Promise<number[]> {
  const { sql, params } = validateAndScopeQuery('SELECT id FROM connections', orgId, {
    userId,
  });
  const rows = await getTestDb().unsafe(sql, params as unknown[]);
  return rows.map((r: Record<string, unknown>) => Number(r.id));
}

// feeds derive from a connection (connection_id NOT NULL) — they must inherit
// the owning connection's per-user visibility.
async function feedConnIdsVisibleTo(orgId: string, userId: string | null): Promise<number[]> {
  const { sql, params } = validateAndScopeQuery('SELECT connection_id FROM feeds', orgId, {
    userId,
  });
  const rows = await getTestDb().unsafe(sql, params as unknown[]);
  return rows.map((r: Record<string, unknown>) => Number(r.connection_id));
}

describe('buildScopedQuery — per-user connection visibility (S0, real rows)', () => {
  it('isolates private-connection events per requesting user', async () => {
    const org = await createTestOrganization({ name: 'S0 Org' });
    const userA = await createTestUser();
    const userB = await createTestUser();

    const connA = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      created_by: userA.id,
      visibility: 'private',
    });
    const connB = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      created_by: userB.id,
      visibility: 'private',
    });
    const connOrg = await createTestConnection({
      organization_id: org.id,
      connector_key: 'slack',
      visibility: 'org',
    });

    const evA = await createTestEvent({
      organization_id: org.id,
      connection_id: connA.id,
      content: 'A private',
      connector_key: 'slack',
    });
    const evB = await createTestEvent({
      organization_id: org.id,
      connection_id: connB.id,
      content: 'B private',
      connector_key: 'slack',
    });
    const evOrg = await createTestEvent({
      organization_id: org.id,
      connection_id: connOrg.id,
      content: 'org shared',
      connector_key: 'slack',
    });

    // userA: own private + org-visible, NOT userB's private (the leak S0 closes).
    const aSees = await originIdsVisibleTo(org.id, userA.id);
    expect(aSees).toContain(evA.origin_id);
    expect(aSees).toContain(evOrg.origin_id);
    expect(aSees).not.toContain(evB.origin_id);

    // userB: mirror image.
    const bSees = await originIdsVisibleTo(org.id, userB.id);
    expect(bSees).toContain(evB.origin_id);
    expect(bSees).toContain(evOrg.origin_id);
    expect(bSees).not.toContain(evA.origin_id);

    // No user (headless/service): org-visible only — private data fails closed.
    const anonSees = await originIdsVisibleTo(org.id, null);
    expect(anonSees).toContain(evOrg.origin_id);
    expect(anonSees).not.toContain(evA.origin_id);
    expect(anonSees).not.toContain(evB.origin_id);

    // The connections ROW itself is per-user too: a private connection's
    // metadata (display_name, account_id, config) must not leak to other users.
    const aConns = await connectionIdsVisibleTo(org.id, userA.id);
    expect(aConns).toContain(connA.id);
    expect(aConns).toContain(connOrg.id);
    expect(aConns).not.toContain(connB.id);

    const bConns = await connectionIdsVisibleTo(org.id, userB.id);
    expect(bConns).toContain(connB.id);
    expect(bConns).toContain(connOrg.id);
    expect(bConns).not.toContain(connA.id);

    const anonConns = await connectionIdsVisibleTo(org.id, null);
    expect(anonConns).toContain(connOrg.id);
    expect(anonConns).not.toContain(connA.id);
    expect(anonConns).not.toContain(connB.id);

    // feeds inherit their connection's visibility (each test connection auto-
    // creates a default feed). userA must not enumerate userB's private feeds.
    const aFeeds = await feedConnIdsVisibleTo(org.id, userA.id);
    expect(aFeeds).toContain(connA.id);
    expect(aFeeds).toContain(connOrg.id);
    expect(aFeeds).not.toContain(connB.id);

    const anonFeeds = await feedConnIdsVisibleTo(org.id, null);
    expect(anonFeeds).toContain(connOrg.id);
    expect(anonFeeds).not.toContain(connA.id);
    expect(anonFeeds).not.toContain(connB.id);
  });
});
