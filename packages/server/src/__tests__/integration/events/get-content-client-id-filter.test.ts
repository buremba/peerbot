/**
 * Integration test: the `client_id` filter scopes events to one OAuth client.
 *
 * Answers "what did this MCP client do here": events filtered by `client_id`,
 * typically alongside `semantic_type: 'audit'`. `client_id` is a real indexed
 * column on `events` (idx_events_client_id, FK → oauth_clients), NOT a metadata
 * field, so the predicate is a plain column match.
 *
 * Why an integration test and not a unit one: the filter is threaded through two
 * SQL builders that share POSITIONAL parameter slots. `client_id` took slot $12,
 * which shifted every downstream index in the search path (orgScope, exclude,
 * visibility, entity-types, cursor…). A mismatch there typechecks perfectly and
 * fails only against a real Postgres — usually as a wrong-parameter bind rather
 * than an error, i.e. silently wrong rows. Both query paths are exercised:
 *
 *   - list path   (no search_term) — appended condition, params.length-indexed
 *   - search path (search_term)    — fixed $12 slot in a shared WHERE template
 *
 * A client that re-registers gets a NEW oauth_clients row under the same
 * client_name (verified in prod: "Lobu CLI" had 6 ids), so the filter accepts an
 * ARRAY and both shapes are covered.
 *
 * Vitest CI gap note (mirrors neighbors): runs locally / in the CI integration
 * job against the pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

/** Register an oauth_clients row so the events FK is satisfiable. */
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

/** Insert one audit-shaped event attributed to `clientId` (or none). */
async function insertAuditEvent(opts: {
  organizationId: string;
  title: string;
  clientId: string | null;
  occurredAt: Date;
}): Promise<number> {
  const sql = getTestDb();
  const [row] = await sql`
    INSERT INTO events (
      organization_id, origin_id, title, payload_type, payload_text,
      semantic_type, client_id, occurred_at, created_at
    ) VALUES (
      ${opts.organizationId},
      ${`client-filter-${opts.title}-${opts.occurredAt.getTime()}`},
      ${opts.title}, 'text', ${opts.title},
      'audit', ${opts.clientId}, ${opts.occurredAt}, NOW()
    )
    RETURNING id
  `;
  return Number((row as { id: unknown }).id);
}

describe('getContent > client_id scopes events to one OAuth client', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;

  // Two ids for the SAME logical client, as happens on re-registration.
  const CHATGPT = 'mcp_client_test_chatgpt';
  const CLI_A = 'mcp_client_test_cli_a';
  const CLI_B = 'mcp_client_test_cli_b';

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Client Filter Org' });
    user = await createTestUser({ email: 'client-filter@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    for (const [id, name] of [
      [CHATGPT, 'ChatGPT'],
      [CLI_A, 'Lobu CLI'],
      [CLI_B, 'Lobu CLI'],
    ] as const) {
      await registerClient({
        id,
        clientName: name,
        userId: user.id,
        organizationId: org.id,
      });
    }

    const t0 = new Date('2026-07-01T00:00:00Z');
    await insertAuditEvent({
      organizationId: org.id,
      title: 'chatgpt searched memory',
      clientId: CHATGPT,
      occurredAt: t0,
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'cli ran query first registration',
      clientId: CLI_A,
      occurredAt: new Date(t0.getTime() + 1000),
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'cli ran query second registration',
      clientId: CLI_B,
      occurredAt: new Date(t0.getTime() + 2000),
    });
    await insertAuditEvent({
      organizationId: org.id,
      title: 'server side activity with no client',
      clientId: null,
      occurredAt: new Date(t0.getTime() + 3000),
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

  it('list path: a single client id returns only that client’s events', async () => {
    const result = await getContent(
      { client_ids: [CHATGPT], semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title)).toEqual(['chatgpt searched memory']);
  });

  it('list path: an array matches every registration of one client', async () => {
    const result = await getContent(
      { client_ids: [CLI_A, CLI_B], semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content.map((c) => c.title).sort()).toEqual([
      'cli ran query first registration',
      'cli ran query second registration',
    ]);
  });

  it('list path: omitting client_id returns every event, client-attributed or not', async () => {
    const result = await getContent(
      { semantic_type: 'audit', limit: 100 } as never,
      {} as never,
      ctx
    );
    // The null-client row must NOT be filtered out when no client is requested.
    expect(result.content.length).toBe(4);
    expect(result.content.map((c) => c.title)).toContain(
      'server side activity with no client'
    );
  });

  it('search path: client_id still scopes when a search_term shifts the param slots', async () => {
    // The search path binds client_id at fixed slot $12 and pushes orgScope to
    // $13. If those indexes drift, this returns the wrong rows rather than
    // erroring — which is exactly what makes it worth asserting.
    const result = await getContent(
      { query: "query", client_ids: [CLI_A, CLI_B], limit: 100 } as never,
      {} as never,
      ctx
    );
    const titles = result.content.map((c) => c.title);
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title).toContain('cli ran query');
    }
    expect(titles).not.toContain('chatgpt searched memory');
  });

  it('search path: a client with no matching text returns nothing, not everything', async () => {
    // Guards the failure mode where a mis-bound slot makes the predicate a
    // no-op: ChatGPT has no event containing "query".
    const result = await getContent(
      { query: "query", client_ids: [CHATGPT], limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toEqual([]);
  });
});
