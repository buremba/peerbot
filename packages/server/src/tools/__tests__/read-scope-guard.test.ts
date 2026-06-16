/**
 * F3: read-tier SDK delegates must re-enforce the mcp:read scope.
 *
 * `executeTool` runs `checkToolAccess` at the REST/MCP boundary, but the SDK
 * delegate path (`client.knowledge.search` / `.get`) calls the handler
 * directly and bypasses that gate. save_content/delete_content already
 * re-enforce `hasRequiredMcpScope('write', ctx.scopes)` in-handler; the read
 * handlers (search / get_content) did NOT, so a query_sdk/run_sdk token minted
 * without read scope could still read.
 *
 * These tests drive the REAL exported `search` / `getContent` handlers and
 * assert:
 *   - a non-system context whose scopes lack mcp:read is rejected (403),
 *   - a system context (userId=null + isAuthenticated) bypasses the scope gate
 *     (watcher reactions carry no user identity),
 *   - a context with mcp:read is allowed through the gate.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { ToolUserError } from '../../utils/errors';
import { initWorkspaceProvider } from '../../workspace';
import { getContent } from '../get_content/handler';
import { search } from '../search';

type SearchCtx = Parameters<typeof search>[2];
type GetContentCtx = Parameters<typeof getContent>[2];

describe('read-tier SDK delegate scope guard (F3)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('search rejects a member token whose scopes lack mcp:read', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Search' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    await expect(
      search(
        { query: 'anything', include_content: false },
        {} as Parameters<typeof search>[1],
        {
          organizationId: org.id,
          userId: user.id,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'oauth',
          scopes: [], // token present but no mcp:* scopes
        } as SearchCtx
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('search rejects a non-mcp scope set (e.g. profile-only token)', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Search 2' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    await expect(
      search(
        { query: 'anything', include_content: false },
        {} as Parameters<typeof search>[1],
        {
          organizationId: org.id,
          userId: user.id,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'oauth',
          scopes: ['profile'],
        } as SearchCtx
      )
    ).rejects.toBeInstanceOf(ToolUserError);
  });

  it('search allows a context bearing mcp:read', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Search OK' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    // Must not throw the scope error. (Empty result is fine — no entities seeded.)
    const result = await search(
      { query: 'anything', include_content: false },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: user.id,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'oauth',
        scopes: ['mcp:read'],
      } as SearchCtx
    );
    expect(Array.isArray(result.matches)).toBe(true);
  });

  it('search bypasses the scope gate for a system context (watcher reaction)', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Search Sys' });

    // System context: userId=null + isAuthenticated=true + no memberRole, no scopes.
    const result = await search(
      { query: 'anything', include_content: false },
      {} as Parameters<typeof search>[1],
      {
        organizationId: org.id,
        userId: null,
        memberRole: null,
        isAuthenticated: true,
        scopes: null,
      } as SearchCtx
    );
    expect(Array.isArray(result.matches)).toBe(true);
  });

  it('getContent (read_knowledge) rejects a member token whose scopes lack mcp:read', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Read' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');

    await expect(
      getContent(
        { limit: 5 },
        {} as Parameters<typeof getContent>[1],
        {
          organizationId: org.id,
          userId: user.id,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'oauth',
          scopes: [],
        } as GetContentCtx
      )
    ).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('getContent bypasses the scope gate for a system context', async () => {
    const org = await createTestOrganization({ name: 'Scope Org Read Sys' });

    const result = await getContent(
      { limit: 5 },
      {} as Parameters<typeof getContent>[1],
      {
        organizationId: org.id,
        userId: null,
        memberRole: null,
        isAuthenticated: true,
        scopes: null,
      } as GetContentCtx
    );
    expect(result).toBeDefined();
  });
});
