/**
 * `resolve_path.counts` — the always-on tally of what a workspace has.
 *
 * These numbers drive nav badges and onboarding states, so a wrong one is not
 * a cosmetic slip: it tells someone their workspace is set up when it isn't,
 * or offers setup to a workspace that is already running. The org-wide count
 * previously read `connector_definitions`, which is a catalog of installable
 * connectors rather than anything the user connected — a workspace with zero
 * connections reported one. That case is asserted first.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

interface Counts {
  connections: number;
  automations: number;
  agents: number;
  devices: number;
  clients: number;
}

interface Fixture {
  orgId: string;
  orgSlug: string;
  userId: string;
  token: string;
}

async function resolveCounts(
  fixture: Fixture,
  args: Record<string, unknown> = {}
): Promise<Counts> {
  const response = await post(`/api/${fixture.orgSlug}/resolve_path`, {
    body: { path: `/${fixture.orgSlug}`, ...args },
    token: fixture.token,
  });
  if (response.status >= 400) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const result = (await response.json()) as { counts?: Counts };
  if (!result.counts) throw new Error('resolve_path returned no counts');
  return result.counts;
}

describe('resolve_path workspace counts', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: 'Counts Org',
      slug: 'counts-org',
    });
    const user = await createTestUser({ email: 'counts@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const access = await createTestAccessToken(
      user.id,
      org.id,
      (await createTestOAuthClient({ client_name: 'Counts Session' })).client_id
    );
    fixture = {
      orgId: org.id,
      orgSlug: org.slug,
      userId: user.id,
      token: access.token,
    };
  });

  it('counts connections the user made, not connectors they could install', async () => {
    // An installable connector in the catalog is not a connection. This is the
    // regression: counting `connector_definitions` here reported 1.
    await createTestConnectorDefinition({
      key: 'countable-connector',
      name: 'Countable Connector',
      organization_id: fixture.orgId,
    });

    expect((await resolveCounts(fixture)).connections).toBe(0);

    const connection = await createTestConnection({
      organization_id: fixture.orgId,
      connector_key: 'countable-connector',
    });
    expect((await resolveCounts(fixture)).connections).toBe(1);

    // Soft-deleted connections are gone from the user's point of view.
    const sql = getTestDb();
    await sql`UPDATE connections SET deleted_at = NOW() WHERE id = ${connection.id}`;
    expect((await resolveCounts(fixture)).connections).toBe(0);
  });

  it('counts distinct MCP apps with a live grant', async () => {
    // The Agents page groups repeat registrations for the same app and only
    // shows a group while at least one grant is live. The compact workspace
    // count must use those same semantics or onboarding and the sidebar drift.
    const before = (await resolveCounts(fixture)).clients;

    const registered = await createTestOAuthClient({ client_name: 'Registered' });
    const sql = getTestDb();
    await sql`
      UPDATE oauth_clients SET organization_id = ${fixture.orgId}
      WHERE id = ${registered.client_id}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before);

    const first = await createTestOAuthClient({ client_name: 'Repeat app' });
    const second = await createTestOAuthClient({ client_name: 'Repeat app' });
    await createTestAccessToken(fixture.userId, fixture.orgId, first.client_id);
    await createTestAccessToken(fixture.userId, fixture.orgId, second.client_id);
    expect((await resolveCounts(fixture)).clients).toBe(before + 1);

    // One revoked registration does not disconnect the grouped app while its
    // sibling registration still has a live grant.
    await sql`
      UPDATE oauth_tokens SET revoked_at = NOW()
      WHERE client_id = ${first.client_id}
        AND organization_id = ${fixture.orgId}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before + 1);

    await sql`
      UPDATE oauth_tokens SET revoked_at = NOW()
      WHERE client_id = ${second.client_id}
        AND organization_id = ${fixture.orgId}
    `;
    expect((await resolveCounts(fixture)).clients).toBe(before);

    // Registered nowhere and holding no token here: not this workspace's.
    await createTestOAuthClient({ client_name: 'Stranger' });
    expect((await resolveCounts(fixture)).clients).toBe(before);
  });

  it('counts active automations', async () => {
    const sql = getTestDb();
    await sql`
      INSERT INTO automations
        (organization_id, created_by, automation_group_id, name, status,
         notification_channel, notification_priority, min_cooldown_seconds,
         created_at, updated_at)
      VALUES
        (${fixture.orgId}, ${fixture.userId}, 0, 'Live', 'active',
         'notification', 'normal', 0, NOW(), NOW()),
        (${fixture.orgId}, ${fixture.userId}, 0, 'Archived', 'archived',
         'notification', 'normal', 0, NOW(), NOW())
    `;
    expect((await resolveCounts(fixture)).automations).toBe(1);
  });

  it('returns counts without include_bootstrap', async () => {
    // The whole point of moving these out of the bootstrap payload: a page
    // that only needs to know whether the workspace is empty should not have
    // to pull entity types, feeds and recent content to find out.
    const counts = await resolveCounts(fixture, { include_bootstrap: false });
    expect(counts).toEqual({
      connections: expect.any(Number),
      automations: expect.any(Number),
      agents: expect.any(Number),
      devices: expect.any(Number),
      clients: expect.any(Number),
    });
  });
});
