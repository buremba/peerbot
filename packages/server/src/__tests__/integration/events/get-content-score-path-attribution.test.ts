/**
 * Regression test: `sort_by: 'score'` must honour the attribution filters.
 *
 * `get_content` has FOUR filter-application sites, and the
 * `sort_by === 'score' && entity_id` branch builds its OWN filters object
 * (handler.ts, the `getNormalizedScoreContent` call). That object enumerates
 * fields explicitly, so anything not listed is silently DROPPED — the query
 * returns unfiltered rows rather than erroring, which is the worst failure
 * shape: a caller asking "what did this client do" gets everything.
 *
 * Two filters were missing there:
 *   - `client_ids` — added alongside the filter itself in this branch
 *   - `agent_id`   — pre-existing hole, so this is a CLASS not a one-off
 *
 * Both are asserted here against the score path specifically. The date/list and
 * search paths are covered by get-content-client-id-filter.test.ts.
 *
 * Score sorting requires an entity (it derives per-connection scoring formulas
 * from the entity's sources), so unlike the list-path test these fixtures need
 * a real entity + connection, and events linked to both.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const CHATGPT = 'mcp_score_path_chatgpt';
const CLI = 'mcp_score_path_cli';
const AGENT_A = 'agent_score_path_a';
const AGENT_B = 'agent_score_path_b';

async function registerClient(opts: {
  id: string;
  clientName: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO oauth_clients (id, client_name, redirect_uris, user_id, organization_id)
    VALUES (
      ${opts.id}, ${opts.clientName}, ARRAY['https://example.test/cb']::text[],
      ${opts.userId}, ${opts.organizationId}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Insert an event carrying both attribution stamps. `client_id` is a real
 * column; `agent_id` lives in metadata — the two predicates differ, so both
 * shapes must be exercised.
 */
async function insertAttributedEvent(opts: {
  organizationId: string;
  entityId: number;
  connectionId: number;
  title: string;
  clientId: string | null;
  agentId: string | null;
  score: number;
  occurredAt: Date;
}): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO events (
      entity_ids, connection_id, organization_id, origin_id, title,
      payload_type, payload_text, semantic_type, connector_key,
      client_id, metadata, score, occurred_at, created_at
    ) VALUES (
      ARRAY[${opts.entityId}]::bigint[],
      ${opts.connectionId},
      ${opts.organizationId},
      ${`score-attr-${opts.title}`},
      ${opts.title},
      'text',
      ${opts.title},
      'content',
      'test.connector',
      ${opts.clientId},
      ${sql.json(opts.agentId ? { agent_id: opts.agentId } : {})},
      ${opts.score},
      ${opts.occurredAt},
      NOW()
    )
  `;
}

describe('getContent > score path honours attribution filters', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;
  let ctx: ToolContext;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Score Attribution Org' });
    user = await createTestUser({ email: 'score-attr@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const entity = await createTestEntity({
      name: 'Score Attribution Entity',
      organization_id: org.id,
      created_by: user.id,
    });
    entityId = entity.id;

    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'test.connector',
      entity_ids: [entityId],
      created_by: user.id,
    });

    await registerClient({
      id: CHATGPT,
      clientName: 'ChatGPT',
      userId: user.id,
      organizationId: org.id,
    });
    await registerClient({
      id: CLI,
      clientName: 'Lobu CLI',
      userId: user.id,
      organizationId: org.id,
    });

    const t0 = new Date('2026-07-01T00:00:00Z');
    // Deliberately give the NON-matching rows the higher score. If the filter is
    // dropped, score ordering surfaces them first and the assertions fail loudly
    // rather than passing by accident on ordering.
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'chatgpt high score row',
      clientId: CHATGPT,
      agentId: AGENT_A,
      score: 99,
      occurredAt: t0,
    });
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'cli low score row',
      clientId: CLI,
      agentId: AGENT_B,
      score: 1,
      occurredAt: new Date(t0.getTime() + 1000),
    });
    await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'unattributed row',
      clientId: null,
      agentId: null,
      score: 50,
      occurredAt: new Date(t0.getTime() + 2000),
    });

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  });

  it('baseline: without a filter the score path returns every row', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title).sort()).toEqual([
      'chatgpt high score row',
      'cli low score row',
      'unattributed row',
    ]);
  });

  it('client_ids scopes score-sorted rows to that client', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', client_ids: [CLI], limit: 100 } as never,
      {} as never,
      ctx
    );
    // Before the fix this returned all three rows, led by the score-99 ChatGPT
    // row — the exact "asked for one client, got everything" failure.
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('agent_id scopes score-sorted rows to that agent (pre-existing hole)', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', agent_id: AGENT_B, limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('total count matches the filtered rows, not the unfiltered set', async () => {
    // Rows and count come from two separate queries sharing one filter builder.
    // If only the row query were fixed, has_more/pagination would still lie.
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', client_ids: [CHATGPT], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
