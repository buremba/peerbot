/**
 * Repro probe: one OAuth registration, tokens belonging to TWO different users.
 *
 * RFC 7591 dynamic registration is per-client, not per-user — a single
 * `oauth_clients` row can hold tokens for several people in the same org. The
 * revoke path picks ONE owner (LIMIT 1 over that client's org tokens) but
 * `revokeClientForOrganization` revokes EVERY org token for the client, so the
 * blast radius is wider than the identity the decision was made on.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG = 'org-shared';
const ALICE = 'u-alice';
const BOB = 'u-bob';
const SHARED_CLIENT = 'mcp_shared_registration';

beforeAll(async () => {
  await ensureDbForGatewayTests();
}, 60_000);

async function importClientRoutes() {
  const mod = await import('../client-routes.js');
  return mod.clientRoutes;
}

async function seed(): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();

  for (const [id, email] of [
    [ALICE, 'alice@test'],
    [BOB, 'bob@test'],
  ] as const) {
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES (${id}, ${id}, ${email}, true, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;

  // ONE registration, no owning user_id — the shared-client shape.
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris)
    VALUES (${SHARED_CLIENT}, 'Shared App', ARRAY['https://example.test/cb']::text[])
    ON CONFLICT (id) DO NOTHING
  `;

  // Alice and Bob each authorized that same registration.
  for (const uid of [ALICE, BOB]) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${uid}`}, 'access', ${`hash_${uid}`}, ${SHARED_CLIENT}, ${uid}, ${ORG},
        'mcp:read', now() + interval '1 hour', now()
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

async function liveTokenUsers(): Promise<string[]> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT user_id FROM oauth_tokens
    WHERE organization_id = ${ORG} AND revoked_at IS NULL
    ORDER BY user_id
  `;
  return (rows as Array<{ user_id: string }>).map((r) => r.user_id);
}

describe('shared OAuth registration', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
    authStash.organizationId = ORG;
    authStash.memberRole = 'owner';
  });

  test('revoking does not take out the other user on the same registration', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request(`/mcp/${SHARED_CLIENT}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // The route resolves the owner from the most recent org token (Bob, seeded
    // last) and revokes only that person's grants. Before the user scoping
    // both rows were revoked, so Alice lost access to an app she shares.
    expect(await liveTokenUsers()).toEqual([ALICE]);
  });

  test('scope=all also stays within the resolved owner', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request(`/mcp/${SHARED_CLIENT}?scope=all`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await liveTokenUsers()).toEqual([ALICE]);
  });
});
