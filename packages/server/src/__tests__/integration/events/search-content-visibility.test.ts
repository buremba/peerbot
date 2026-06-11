/**
 * Integration test: connection-visibility enforcement on the `search_memory`
 * recall path (`search()` with include_content).
 *
 * Regression for a private-connection content leak: `fetchContentSnippets`
 * in tools/search.ts called `searchContentByText` WITHOUT a `visibility_scope`,
 * so the connection-visibility clause (`buildConnectionVisibilityClause`) was
 * skipped entirely — it short-circuits to an empty fragment when
 * `visibility_scope.organizationId` is undefined. Because `search_memory` is
 * publicly readable (tool-access.ts: `search_memory: null`) and
 * `include_content` defaults to true, any org member — or an anonymous reader
 * of a public workspace — could recall content ingested through another
 * member's `private` connection. `get_content` already passed visibility_scope
 * on every branch; this pins the same boundary on the recall path.
 *
 * NOTE: vitest is not yet wired into CI for this package (see CLAUDE memory
 * "vitest CI gap"); runs locally against the dev Postgres as a regression
 * record. Uses explicit embeddings so the score/recall candidate path is
 * deterministic without depending on a live embedding service.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { search } from '../../../tools/search';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

const EMBEDDING_DIM = 768;

function axisVec(axis: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[axis] = 1;
  return v;
}

describe('search_memory recall > connection visibility enforced', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let aliceUser: Awaited<ReturnType<typeof createTestUser>>;
  let bobUser: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;

  let orgEventId: number;
  let alicePrivateEventId: number;
  let bobPrivateEventId: number;

  function ctxFor(userId: string | null, authed: boolean): ToolContext {
    return {
      organizationId: org.id,
      userId,
      memberRole: authed ? 'owner' : null,
      isAuthenticated: authed,
      tokenType: authed ? 'oauth' : 'anonymous',
      scopedToOrg: !authed,
      allowCrossOrg: authed,
      scopes: authed ? ['mcp:read'] : undefined,
    } as ToolContext;
  }

  // search() needs a query, entity_id, or embedding. Forwarding the embedding
  // exercises fetchContentSnippets' bounded recall candidate path the same way
  // production does, with deterministic similarity (all targets share axis 0).
  async function recall(ctx: ToolContext) {
    const result = await search(
      {
        query: 'recall-visibility-probe',
        query_embedding: axisVec(0),
        include_content: true,
        content_limit: 50,
      } as never,
      {} as never,
      ctx
    );
    return new Set((result.content ?? []).map((c) => c.id));
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Recall Visibility Org' });
    aliceUser = await createTestUser({ email: 'alice-recall@example.com' });
    bobUser = await createTestUser({ email: 'bob-recall@example.com' });
    await addUserToOrganization(aliceUser.id, org.id, 'owner');
    await addUserToOrganization(bobUser.id, org.id, 'owner');

    entity = await createTestEntity({ name: 'Recall Entity', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'recall-vis-connector',
      name: 'Recall Vis',
      organization_id: org.id,
    });

    const orgConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'org',
      created_by: aliceUser.id,
      display_name: 'Org-visible',
    });
    const alicePrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: aliceUser.id,
      display_name: 'Alice private',
    });
    const bobPrivConn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'recall-vis-connector',
      entity_ids: [entity.id],
      visibility: 'private',
      created_by: bobUser.id,
      display_name: 'Bob private',
    });

    orgEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: orgConn.id,
        content: 'org-visible recall target',
        embedding: axisVec(0),
      })
    ).id;
    alicePrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: alicePrivConn.id,
        content: 'alice private recall target',
        embedding: axisVec(0),
      })
    ).id;
    bobPrivateEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        connection_id: bobPrivConn.id,
        content: 'bob private recall target',
        embedding: axisVec(0),
      })
    ).id;
  });

  it('an org member does NOT recall another member private-connection content', async () => {
    const ids = await recall(ctxFor(bobUser.id, true));
    // Bob sees org-visible content and his own private content...
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(bobPrivateEventId)).toBe(true);
    // ...but NOT Alice's private connection content (the leak).
    expect(ids.has(alicePrivateEventId)).toBe(false);
  });

  it('the owning member DOES recall their own private-connection content', async () => {
    const ids = await recall(ctxFor(aliceUser.id, true));
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(alicePrivateEventId)).toBe(true);
    expect(ids.has(bobPrivateEventId)).toBe(false);
  });

  it('an anonymous public-workspace reader recalls only org-visible content', async () => {
    const ids = await recall(ctxFor(null, false));
    expect(ids.has(orgEventId)).toBe(true);
    expect(ids.has(alicePrivateEventId)).toBe(false);
    expect(ids.has(bobPrivateEventId)).toBe(false);
  });
});
