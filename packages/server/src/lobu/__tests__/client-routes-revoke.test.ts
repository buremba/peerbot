/**
 * Coverage for revoking a connected MCP client (client-routes.ts):
 *
 *  1. Authorization. `mcpAuth` only resolves identity — it authenticates, it
 *     does not authorize a role — so before this gate any org member could
 *     revoke a client another member registered, killing live tokens and MCP
 *     sessions for everyone. Revoke is owner/admin; listing stays open to
 *     members (it exposes no secrets).
 *
 *  2. Multi-registration semantics. A client that re-registers gets a NEW
 *     oauth_clients row under the same client_name (prod: "Lobu CLI" has 6
 *     ids). Revoking one id leaves the same app connected through its
 *     siblings — the user disconnects ChatGPT and ChatGPT stays online.
 *     `?scope=all` fans out across same (client_name, user_id, organization_id).
 *
 * Uses the shared route-test mocks over the embedded Postgres harness.
 */

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

/** Seed org + user, then N registrations of the same logical client. */
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

  // Two registrations of "ChatGPT" (same name/user/org) + one unrelated client.
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

  // One live token per client so revocation has something to revoke.
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
    // Nothing was revoked.
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

  test('an admin can revoke, and by default only the one registration', async () => {
    authStash.memberRole = 'admin';
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a', { method: 'DELETE' });

    expect(res.status).toBe(200);
    // The sibling registration is deliberately untouched without ?scope=all.
    expect(await liveTokenIds()).toEqual(['mcp_chatgpt_b', 'mcp_other']);
  });

  test('scope=all revokes every registration of the same client', async () => {
    const routes = await importClientRoutes();
    const res = await routes.request('/mcp/mcp_chatgpt_a?scope=all', {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedClientIds: string[] };
    expect([...body.revokedClientIds].sort()).toEqual([
      'mcp_chatgpt_a',
      'mcp_chatgpt_b',
    ]);
    // Both ChatGPT registrations gone; the unrelated client survives.
    expect(await liveTokenIds()).toEqual(['mcp_other']);
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
