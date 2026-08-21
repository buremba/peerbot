import { generateWorkerToken, mintGatewayMcpToken } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAgent,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

const AGENT_ID = 'personal-agent';
const OTHER_AGENT_ID = 'other-agent';

describe('worker MCP session agent identity', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let workerToken: string;
  let otherWorkerToken: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Worker Identity Org' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id, 'owner');
    await createTestAgent({
      organizationId: org.id,
      agentId: AGENT_ID,
      ownerUserId: user.id,
    });
    await createTestAgent({
      organizationId: org.id,
      agentId: OTHER_AGENT_ID,
      ownerUserId: user.id,
    });
    const rawWorkerToken = generateWorkerToken(
      user.id,
      'conv-agent-turn-1',
      'test-deployment',
      {
        channelId: 'api-conv-agent-turn-1',
        agentId: AGENT_ID,
        organizationId: org.id,
        platform: 'api',
        source: 'internal',
      }
    );
    const rawOtherWorkerToken = generateWorkerToken(user.id, 'conv-agent-turn-2', 'test-deployment', {
      channelId: 'api-conv-agent-turn-2',
      agentId: OTHER_AGENT_ID,
      organizationId: org.id,
      platform: 'api',
      source: 'internal',
    });
    const narrowedWorkerToken = mintGatewayMcpToken(rawWorkerToken);
    const narrowedOtherWorkerToken = mintGatewayMcpToken(rawOtherWorkerToken);
    if (!narrowedWorkerToken || !narrowedOtherWorkerToken) {
      throw new Error('failed to narrow test worker credentials for the MCP hop');
    }
    workerToken = narrowedWorkerToken;
    otherWorkerToken = narrowedOtherWorkerToken;
  });

  /** Mirror the gateway proxy handshake, whose initialize metadata omits agentId. */
  async function initWorkerMcpSession(options?: {
    clientInfoAgentId?: string;
  }): Promise<string> {
    const initResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'lobu-gateway',
            version: '1.0.0',
            ...(options?.clientInfoAgentId ? { agentId: options.clientInfoAgentId } : {}),
          },
        },
        id: 0,
      },
      token: workerToken,
      headers: { 'X-Lobu-Memory-Direct-Auth': '1' },
    });
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    if (!sessionId) {
      throw new Error(
        `initialize returned no mcp-session-id: ${JSON.stringify(await initResponse.json())}`
      );
    }
    await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      token: workerToken,
      headers: {
        'X-Lobu-Memory-Direct-Auth': '1',
        'mcp-session-id': sessionId,
      },
    });
    return sessionId;
  }

  async function callTool<T>(
    sessionId: string,
    name: string,
    args: Record<string, unknown>,
    token = workerToken
  ): Promise<T> {
    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
      token,
      headers: {
        'X-Lobu-Memory-Direct-Auth': '1',
        'X-MCP-Format': 'json',
        'mcp-session-id': sessionId,
      },
    });
    const json = await response.json();
    if (json.error) {
      throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    }
    if (json.result?.isError) {
      throw new Error(json.result.content?.[0]?.text ?? 'tool call failed');
    }
    return JSON.parse(json.result.content[0].text) as T;
  }

  it('queues a person merge from an agent conversation turn for human approval instead of applying it', async () => {
    const sessionId = await initWorkerMcpSession();
    const winner = await createTestEntity({
      name: 'Jane Doe',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });
    const loser = await createTestEntity({
      name: 'J. Doe',
      entity_type: 'person',
      organization_id: org.id,
      created_by: user.id,
    });

    const result = await callTool<{
      approval_queued?: boolean;
      approval_run_id?: number;
    }>(sessionId, 'manage_entity', {
      action: 'merge',
      entity_id: loser.id,
      winner_entity_id: winner.id,
    });

    expect(result.approval_queued).toBe(true);
    expect(result.approval_run_id).toEqual(expect.any(Number));

    const sql = getTestDb();
    const [entity] = await sql`
      SELECT merged_into, deleted_at FROM entities WHERE id = ${loser.id}
    `;
    expect(entity.merged_into).toBeNull();
    expect(entity.deleted_at).toBeNull();
    const [run] = await sql`
      SELECT approval_status FROM runs WHERE id = ${result.approval_run_id}
    `;
    expect(run.approval_status).toBe('pending');
  });

  it('binds the token-verified agent even when initialize clientInfo names a different agent', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE agents SET last_used_at = NULL
      WHERE organization_id = ${org.id} AND id IN (${AGENT_ID}, ${OTHER_AGENT_ID})
    `;

    // A compromised/misbehaving client could ask for another agent's identity
    // in clientInfo — the worker JWT's binding must win.
    const sessionId = await initWorkerMcpSession({ clientInfoAgentId: OTHER_AGENT_ID });
    await callTool(sessionId, 'manage_entity', { action: 'list', entity_type: 'person' });

    const rows = await sql<{ id: string; last_used_at: string | null }[]>`
      SELECT id, last_used_at FROM agents
      WHERE organization_id = ${org.id} AND id IN (${AGENT_ID}, ${OTHER_AGENT_ID})
      ORDER BY id
    `;
    const byId = new Map(rows.map((r) => [r.id, r.last_used_at]));
    expect(byId.get(AGENT_ID)).not.toBeNull();
    expect(byId.get(OTHER_AGENT_ID)).toBeNull();
  });

  it('rejects switching an established live session to another worker agent', async () => {
    const sessionId = await initWorkerMcpSession();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' }, otherWorkerToken)
    ).rejects.toThrow('Session agent changed. Re-initialize.');
  });

  it('recovers a persisted worker session with the same verified agent', async () => {
    const sessionId = await initWorkerMcpSession();
    clearInMemoryMcpSessionsForTests();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' })
    ).resolves.toBeDefined();
  });

  it('rejects switching a recovered session to another worker agent', async () => {
    const sessionId = await initWorkerMcpSession();
    clearInMemoryMcpSessionsForTests();

    await expect(
      callTool(sessionId, 'manage_entity', { action: 'list' }, otherWorkerToken)
    ).rejects.toThrow('MCP session expired or not recognized.');
  });
});
