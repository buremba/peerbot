/**
 * Regression test: `sort_by: 'score'` must honour the forwarded filters.
 *
 * `get_content` has FOUR filter-application sites, and the
 * `sort_by === 'score' && entity_id` branch runs through its own builder
 * (`buildFilterConditionsAndJoins` in content-scoring.ts). Both it and the
 * handler's filters object enumerate fields explicitly, so anything not listed
 * is silently DROPPED — the query returns unfiltered rows rather than erroring,
 * which is the worst failure shape: a caller asking "what did this client do"
 * gets everything, led by whatever scored highest.
 *
 * THREE filters were missing, i.e. a class not a one-off:
 *   - `client_ids`             — added alongside the filter in this branch
 *   - `agent_id`               — pre-existing
 *   - `analyzed_by_behavior_id`— pre-existing; the handler always passed it
 *
 * Fixtures deliberately give the NON-matching rows the higher score, so a
 * dropped filter surfaces them first and fails loudly rather than passing by
 * accident on ordering. Score sorting derives per-connection scoring formulas
 * from the entity's sources, so unlike the list-path test these fixtures need a
 * real entity + connection.
 *
 * The list and search paths are covered by get-content-client-id-filter.test.ts.
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
const BEHAVIOR_A = 910_001;
const BEHAVIOR_B = 910_002;

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

async function insertAttributedEvent(opts: {
  organizationId: string;
  entityId: number;
  connectionId: number;
  title: string;
  clientId: string | null;
  agentId: string | null;
  score: number;
  occurredAt: Date;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
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
    RETURNING id
  `;
  return Number((row as { id: unknown }).id);
}

describe('getContent > score path honours forwarded filters', () => {
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
    const chatgptEventId = await insertAttributedEvent({
      organizationId: org.id,
      entityId,
      connectionId: connection.id,
      title: 'chatgpt high score row',
      clientId: CHATGPT,
      agentId: AGENT_A,
      score: 99,
      occurredAt: t0,
    });
    const cliEventId = await insertAttributedEvent({
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

    const sql = getTestDb();
    await sql`
      INSERT INTO watcher_window_events (window_id, event_id, watcher_id)
      VALUES
        (${chatgptEventId}, ${chatgptEventId}, ${BEHAVIOR_A}),
        (${cliEventId}, ${cliEventId}, ${BEHAVIOR_B})
    `;

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
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('agent_id scopes score-sorted rows to that agent', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', agent_id: AGENT_B, limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('analyzed_by_behavior_id scopes score-sorted rows to that behavior', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        sort_by: 'score',
        analyzed_by_behavior_id: BEHAVIOR_B,
        limit: 100,
      } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('include_superseded applies the client scope', async () => {
    const result = await getContent(
      {
        entity_id: entityId,
        include_superseded: true,
        client_ids: [CLI],
        limit: 100,
      } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['cli low score row']);
  });

  it('total count matches the filtered rows, not the unfiltered set', async () => {
    const result = await getContent(
      { entity_id: entityId, sort_by: 'score', client_ids: [CHATGPT], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toHaveLength(1);
    expect(result.total).toBe(1);
  });
});
