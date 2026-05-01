/**
 * Layer 1b — MCP Tool Integration Test
 *
 * Exercises the MCP JSON-RPC protocol directly: initialize session,
 * list tools, save knowledge, search/recall knowledge, and verify
 * unauthenticated tool calls fail with an appropriate error.
 *
 * No LLM needed — pure HTTP JSON-RPC calls.
 *
 * Prerequisites:
 *   - docker compose up (at least: app, redis, postgres, embeddings)
 *   - DATABASE_URL in env (or .env)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_URL,
  addUserToOrg,
  cleanupTestData,
  closeDb,
  createTestOrg,
  mcpCallTool,
  mcpInitSession,
  mcpRpc,
  oauthApproveDevice,
  oauthDeviceAuthorize,
  oauthExchangeDeviceCode,
  oauthRegisterClient,
  type SignedUpUser,
  signUpTestUser,
  type TestOrg,
} from './helpers';

let org: TestOrg;
let signedUp: SignedUpUser;
let accessToken: string;

beforeAll(async () => {
  try {
    const health = await fetch(`${APP_URL}/health`);
    if (!health.ok) throw new Error(`Health check returned ${health.status}`);
  } catch (err) {
    throw new Error(`Cannot reach app at ${APP_URL}. Is docker compose up?\n${err}`);
  }

  signedUp = await signUpTestUser();
  org = await createTestOrg();
  await addUserToOrg(signedUp.userId, org.id, 'owner');

  // Complete device-auth to get a valid access token
  const client = await oauthRegisterClient('mcp:read mcp:write');
  const authz = await oauthDeviceAuthorize(
    client.clientId,
    'mcp:read mcp:write',
    `${APP_URL}/${org.slug}`
  );
  await oauthApproveDevice(authz.user_code, signedUp.cookieHeader, org.id);
  const tokens = await oauthExchangeDeviceCode(
    client.clientId,
    authz.device_code,
    client.clientSecret
  );
  accessToken = tokens.access_token;
});

afterAll(async () => {
  await cleanupTestData();
  await closeDb();
});

describe('MCP session + tool discovery', () => {
  let sessionId: string;

  it('initializes an org-scoped MCP session', async () => {
    sessionId = await mcpInitSession(accessToken, org.slug);
    expect(sessionId).toBeTruthy();
  });

  it('lists save_knowledge and search_knowledge tools', async () => {
    const res = await mcpRpc(
      'tools/list',
      {},
      { token: accessToken, sessionId, orgSlug: org.slug }
    );
    const rpc = res.body as { result?: { tools: Array<{ name: string }> } };
    const toolNames = rpc.result!.tools.map((t) => t.name);

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain('save_knowledge');
    expect(toolNames).toContain('search_knowledge');
  });
});

describe('MCP save + recall knowledge', () => {
  let sessionId: string;
  const uniqueMarker = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    sessionId = await mcpInitSession(accessToken, org.slug);
  });

  it('saves knowledge via save_knowledge tool', async () => {
    const result = await mcpCallTool(
      'save_knowledge',
      {
        content: `The secret passphrase is ${uniqueMarker}. This is an e2e test fact.`,
        semantic_type: 'fact',
        metadata: { status: 'active' },
      },
      { token: accessToken, sessionId, orgSlug: org.slug }
    );

    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('recalls the saved knowledge via search_knowledge', async () => {
    // Brief delay for embedding indexing
    await new Promise((r) => setTimeout(r, 3000));

    const result = await mcpCallTool(
      'search_knowledge',
      { query: `secret passphrase ${uniqueMarker}` },
      { token: accessToken, sessionId, orgSlug: org.slug }
    );

    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeGreaterThan(0);
    const text = result.content.map((c) => c.text).join('');
    expect(text).toContain(uniqueMarker);
  }, 30_000);
});

describe('unauthenticated MCP tool calls', () => {
  it('rejects tool calls without a token', async () => {
    // Try calling a tool on the org-scoped endpoint without auth
    const toolRes = await mcpRpc(
      'tools/call',
      { name: 'save_knowledge', arguments: { content: 'should fail', metadata: {} } },
      { orgSlug: org.slug }
    );

    // Should fail — either HTTP 401/403 or RPC error result
    const rpc = toolRes.body as {
      result?: { isError?: boolean };
      error?: unknown;
    };
    const failed =
      toolRes.status === 401 ||
      toolRes.status === 403 ||
      rpc.error != null ||
      rpc.result?.isError === true;

    expect(failed).toBe(true);
  });
});
