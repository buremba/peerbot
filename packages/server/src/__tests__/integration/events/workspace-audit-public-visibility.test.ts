/**
 * Integration test: workspace-identity audit events (metadata.category=
 * 'workspace') are visible to authenticated members in the All activity feed
 * but are NEVER returned to anonymous public-workspace readers through the
 * public read_knowledge path. These events carry member emails / invitation
 * details, so public exposure is a privacy leak.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('workspace-identity audit events > public-read exclusion', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let alice: Awaited<ReturnType<typeof createTestUser>>;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let workspaceAuditEventId: number;
  let normalEventId: number;

  function authedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: alice.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  }

  function unauthedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: null,
      memberRole: null,
      isAuthenticated: false,
      tokenType: 'anonymous',
      scopedToOrg: true,
      allowCrossOrg: false,
    } as ToolContext;
  }

  async function listIds(ctx: ToolContext): Promise<Set<number>> {
    const result = await getContent(
      { entity_id: entity.id, limit: 100, sort_by: 'date', sort_order: 'desc' } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  async function readExactIds(ctx: ToolContext, ids: number[]): Promise<Set<number>> {
    const result = await getContent(
      { entity_id: entity.id, content_ids: ids, limit: 100 } as never,
      {} as never,
      ctx
    );
    return new Set(result.content.map((c) => c.id));
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Workspace Audit Visibility Org' });
    alice = await createTestUser({ email: 'alice-workspace-audit@example.com' });
    await addUserToOrganization(alice.id, org.id, 'owner');

    entity = await createTestEntity({
      name: 'Workspace Audit Entity',
      organization_id: org.id,
    });

    normalEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        content: 'normal content event',
      })
    ).id;

    // Mirrors what recordWorkspaceChangeEvent emits (minus embeddings, which
    // are not needed for the chronological date-sort list path).
    workspaceAuditEventId = (
      await createTestEvent({
        organization_id: org.id,
        entity_id: entity.id,
        title: 'Invitation sent to new.member@example.com',
        content: 'workspace audit event',
        semantic_type: 'change',
        metadata: {
          category: 'workspace',
          resource_kind: 'invitation',
          resource_id: 'inv_abc',
          op: 'created',
        },
      })
    ).id;
  });

  it('authenticated member sees the workspace audit event in the feed', async () => {
    const ids = await listIds(authedCtx());
    expect(ids.has(workspaceAuditEventId)).toBe(true);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('anonymous public-workspace reader does NOT see the workspace audit event', async () => {
    const ids = await listIds(unauthedCtx());
    expect(ids.has(workspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });

  it('anonymous content_ids exact-ID read excludes workspace audit but keeps ordinary events', async () => {
    const ids = await readExactIds(unauthedCtx(), [
      workspaceAuditEventId,
      normalEventId,
    ]);
    expect(ids.has(workspaceAuditEventId)).toBe(false);
    expect(ids.has(normalEventId)).toBe(true);
  });
});
