import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
import { authStash, installRouteTestMocks } from './helpers/route-test-mocks';

installRouteTestMocks();

const ORG = 'org-clients';
const USER = 'u1';

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
  await sql`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (${USER}, 'Test', 'u1@test', true, now(), now())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${ORG}, ${ORG}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt")
    VALUES ('m1', ${ORG}, ${USER}, 'owner', now())
    ON CONFLICT (id) DO NOTHING
  `;

  for (const id of ['mcp_chatgpt_a', 'mcp_chatgpt_b']) {
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (${id}, 'ChatGPT', ARRAY['https://example.test/cb']::text[], ${USER}, ${ORG})
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
    VALUES ('mcp_other', 'Some Other App', ARRAY['https://example.test/cb']::text[], ${USER}, ${ORG})
    ON CONFLICT (id) DO NOTHING
  `;

  for (const id of ['mcp_chatgpt_a', 'mcp_chatgpt_b', 'mcp_other']) {
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        ${`tok_${id}`}, 'access', ${`hash_${id}`}, ${id}, ${USER}, ${ORG},
        'mcp:read', now() + interval '1 hour', now()
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}

async function liveTokenIds(): Promise<string[]> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  const rows = await sql`
    SELECT client_id FROM oauth_tokens
    WHERE organization_id = ${ORG} AND revoked_at IS NULL
    ORDER BY client_id
  `;
  return (rows as Array<{ client_id: string }>).map((r) => r.client_id);
}

describe('DELETE /clients/mcp/:clientId', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seed();
    authStash.organizationId = ORG;
    authStash.memberRole = 'owner';
  });

  test('a plain member cannot revoke', async () => {
    authStash.memberRole = 'member';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(403);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_other',
    ]);
  });

  test('a user with no membership role cannot revoke', async () => {
    authStash.memberRole = null;
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });

  test('a request without an organization is rejected before role authorization', async () => {
    authStash.organizationId = null;
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  test('an admin can revoke, and by default only the one registration', async () => {
    authStash.memberRole = 'admin';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await liveTokenIds()).toEqual(['mcp_chatgpt_b', 'mcp_other']);
  });

  test('scope=all revokes every registration of the same client', async () => {
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris)
      VALUES ('mcp_chatgpt_legacy', 'ChatGPT', ARRAY['https://example.test/cb']::text[])
    `;
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_mcp_chatgpt_legacy', 'access', 'hash_mcp_chatgpt_legacy',
        'mcp_chatgpt_legacy', ${USER}, ${ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;
    await sql`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('u2', 'Other', 'u2@test', true, now(), now())
    `;
    await sql`
      INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
      VALUES (
        'mcp_chatgpt_other_user', 'ChatGPT',
        ARRAY['https://example.test/cb']::text[], 'u2', ${ORG}
      )
    `;
    await sql`
      INSERT INTO oauth_tokens (
        id, token_type, token_hash, client_id, user_id, organization_id,
        scope, expires_at, created_at
      ) VALUES (
        'tok_mcp_chatgpt_other_user', 'access', 'hash_mcp_chatgpt_other_user',
        'mcp_chatgpt_other_user', 'u2', ${ORG}, 'mcp:read',
        now() + interval '1 hour', now()
      )
    `;

    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a?scope=all', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedClientIds: string[] };
    expect([...body.revokedClientIds].sort()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_chatgpt_legacy',
    ]);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_other_user',
      'mcp_other',
    ]);
  });

  test('scope=all does not reach a different client that shares nothing', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_other?scope=all', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(await liveTokenIds()).toEqual(['mcp_chatgpt_a', 'mcp_chatgpt_b']);
  });

  test('a client from another org is not revocable', async () => {
    authStash.organizationId = 'org-somewhere-else';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(404);
    expect(await liveTokenIds()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
      'mcp_other',
    ]);
  });
});
