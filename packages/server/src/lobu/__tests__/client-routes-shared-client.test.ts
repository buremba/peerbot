/**
 * Repro probe: one OAuth registration, tokens belonging to TWO different users.
 *
 * RFC 7591 dynamic registration is per-client, not per-user — a single
 * `oauth_clients` row can hold tokens for several people in the same org.
 *
 * Two things have to hold, and both used to be broken:
 *   - revocation is scoped to the resolved owner, so revoking one person's
 *     grant does not disconnect bystanders sharing the registration
 *   - the LISTED owner and the REVOKED owner are the same person, i.e. both
 *     sides pick the same token by the same ordering
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
  // ALICE's token is the NEWEST while BOB sorts lexicographically LAST. That
  // split is deliberate: a MAX(user_id) owner pick lands on Bob and a
  // newest-token pick lands on Alice, so any divergence between the listing
  // and the revoke path shows up as a concrete wrong-person outcome rather
  // than passing by coincidence.
  for (const [uid, ageMinutes] of [
    [BOB, 10],
    [ALICE, 1],
  ] as const) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${uid}`}, 'access', ${`hash_${uid}`}, ${SHARED_CLIENT}, ${uid}, ${ORG},
        'mcp:read', now() + interval '1 hour',
        now() - (${ageMinutes} * interval '1 minute')
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

    // The route resolves the owner from the most recent org token (ALICE) and
    // revokes only that person's grants. Before the user scoping both rows
    // were revoked, so Bob lost access to an app he merely shares.
    expect(await liveTokenUsers()).toEqual([BOB]);
  });

  test('the listed owner is the owner that gets revoked', async () => {
    // BOB sorts lexicographically LAST but ALICE's token is NEWEST. A
    // MAX(user_id) listing would name Bob while a newest-token revoke hits
    // Alice — the row you click would not be the grant you kill. Both sides
    // must pick the same token.
    const routes = await importClientRoutes();

    const listRes = await routes.request('/');
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    expect(row).toBeDefined();

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });

    // Whoever the list named is exactly who lost access.
    const stillLive = await liveTokenUsers();
    const revokedUser = [ALICE, BOB].find((u) => !stillLive.includes(u));
    const expectedEmail = revokedUser === ALICE ? 'alice@test' : 'bob@test';
    expect(row?.linkedUserEmail).toBe(expectedEmail);
  });

  test('a registration owned by one user but last used by another revokes the user it displays', async () => {
    // The registration owner and the person holding the displayed grant can
    // differ when a registration is reused.
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      UPDATE oauth_clients SET user_id = ${BOB} WHERE id = ${SHARED_CLIENT}
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    // Display follows the newest token — Alice.
    expect(row?.linkedUserEmail).toBe('alice@test');

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });

    // …and so must the revocation. Bob keeps his grant.
    expect(await liveTokenUsers()).toEqual([BOB]);
  });

  test('prefers a live grant over a newer revoked grant', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      UPDATE oauth_tokens SET revoked_at = now() WHERE id = ${`tok_${ALICE}`}
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; linkedUserEmail: string | null; status: string }>;
    };
    const row = listed.clients.find((c) => c.id === SHARED_CLIENT);
    expect(row?.status).toBe('connected');
    expect(row?.linkedUserEmail).toBe('bob@test');

    await routes.request(`/mcp/${SHARED_CLIENT}`, { method: 'DELETE' });
    expect(await liveTokenUsers()).toEqual([]);
  });

  test('keeps an organization-owned registration with no tokens visible', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, organization_id)
      VALUES ('mcp_registered_only', 'Registered Only', ARRAY['https://example.test/cb']::text[], ${ORG})
    `;

    const routes = await importClientRoutes();
    const listRes = await routes.request('/');
    const listed = (await listRes.json()) as {
      clients: Array<{ id: string; status: string }>;
    };
    expect(listed.clients).toContainEqual(
      expect.objectContaining({ id: 'mcp_registered_only', status: 'disconnected' })
    );
  });

  test('scope=all also stays within the resolved owner', async () => {
    const { getDb } = await import('../../db/client.js');
    await getDb()`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (
        'mcp_shared_sibling', 'Shared App',
        ARRAY['https://example.test/cb']::text[], ${BOB}, ${ORG}
      )
    `;
    await getDb()`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_shared_sibling', 'access', 'hash_shared_sibling',
        'mcp_shared_sibling', ${ALICE}, ${ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;

    const routes = await importClientRoutes();
    const res = await routes.request(`/mcp/${SHARED_CLIENT}?scope=all`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await liveTokenUsers()).toEqual([BOB]);
  });
});
