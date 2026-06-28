/**
 * connector-health → browser-auth-expired user notification (integration).
 *
 * When a connection goes unhealthy because its SITE SESSION expired (e.g. an
 * extension-scrape connector like Revolut whose Revolut login lapsed), the
 * health scan must notify the org's admins to re-login — on top of the operator
 * Slack alert. A connection that's unhealthy for a NON-auth reason (offline
 * device / transport) must NOT produce that user notification. And the notice
 * fires once per unhealthy episode (deduped by the unhealthy_alerted_at claim).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runConnectorHealthCheck } from '../../connectors/connector-health';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { addUserToOrganization, createTestOrganization, createTestUser } from '../setup/test-fixtures';

// Comfortably outside the 24h min-age grace window so age never masks a flag.
const OLD = new Date(Date.now() - 48 * 60 * 60 * 1000);

async function seedConn(
  orgId: string,
  userId: string,
  connectorKey: string,
  slug: string
): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO connections (
      organization_id, connector_key, slug, display_name, status,
      created_by, visibility, created_at, updated_at
    ) VALUES (
      ${orgId}, ${connectorKey}, ${slug}, ${`Conn ${slug}`}, 'active',
      ${userId}, 'org', ${OLD}, ${OLD}
    )
    RETURNING id
  `;
  return Number(row.id);
}

async function seedFailingFeed(
  orgId: string,
  connectionId: number,
  feedKey: string,
  lastError: string
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO feeds (
      organization_id, connection_id, feed_key, status,
      last_sync_status, last_sync_at, consecutive_failures, last_error,
      created_at, updated_at
    ) VALUES (
      ${orgId}, ${connectionId}, ${feedKey}, 'active',
      'failed', ${new Date()}, 5, ${lastError}, NOW(), NOW()
    )
  `;
}

async function authNotifsFor(
  orgId: string,
  connectionId: number
): Promise<Array<{ id: number; title: string; payload_text: string | null }>> {
  const sql = getTestDb();
  return (await sql`
    SELECT id, title, payload_text
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'notification'
      AND metadata->>'notification_type' = 'browser_auth_expired'
      AND metadata->>'resource_id' = ${String(connectionId)}
  `) as unknown as Array<{ id: number; title: string; payload_text: string | null }>;
}

describe('connector-health → browser-auth-expired notification', () => {
  let orgId: string;
  let ownerId: string;
  let authConnId: number;
  let offlineConnId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Reauth Notify Org' });
    orgId = org.id;
    const user = await createTestUser({ email: 'reauth-owner@test.com' });
    ownerId = user.id;
    await addUserToOrganization(ownerId, orgId, 'owner');

    // (A) Expired site session — should notify.
    authConnId = await seedConn(orgId, ownerId, 'revolut', 'revolut-auth');
    await seedFailingFeed(
      orgId,
      authConnId,
      'transactions',
      'Revolut session needs sign-in (redirected to https://sso.revolut.com/signin)'
    );

    // (B) Offline device / transport — unhealthy, but NOT an auth failure.
    offlineConnId = await seedConn(orgId, ownerId, 'revolut', 'revolut-offline');
    await seedFailingFeed(
      orgId,
      offlineConnId,
      'transactions',
      'No online paired Owletto Chrome extension in this organization. Pair a Chrome extension first (and make sure it is running).'
    );
  });

  afterAll(async () => {
    await cleanupTestDatabase();
  });

  it('notifies the owner on an expired session, but not on an offline device', async () => {
    const res = await runConnectorHealthCheck();

    // Both connections are flagged unhealthy (every feed failing)...
    const flagged = new Set(res.details.map((d) => d.connectionId));
    expect(flagged.has(authConnId)).toBe(true);
    expect(flagged.has(offlineConnId)).toBe(true);

    // ...but only the expired-session one produced a user notification.
    expect(res.authNotified).toBe(1);

    const authNotifs = await authNotifsFor(orgId, authConnId);
    expect(authNotifs).toHaveLength(1);
    expect(authNotifs[0].title.toLowerCase()).toContain('needs sign-in');

    // The owner is a target of that notification.
    const sql = getTestDb();
    const targets = (await sql`
      SELECT user_id FROM notification_targets WHERE event_id = ${Number(authNotifs[0].id)}
    `) as unknown as Array<{ user_id: string }>;
    expect(targets.map((t) => t.user_id)).toContain(ownerId);

    // The offline-device connection produced NO browser-auth-expired notification.
    expect(await authNotifsFor(orgId, offlineConnId)).toHaveLength(0);
  });

  it('does not re-notify while still unhealthy (deduped by the unhealthy claim)', async () => {
    const res = await runConnectorHealthCheck();
    expect(res.newlyAlerted).toBe(0);
    expect(res.authNotified).toBe(0);
    // Still exactly one notification — no duplicate on the second scan.
    expect(await authNotifsFor(orgId, authConnId)).toHaveLength(1);
  });
});
