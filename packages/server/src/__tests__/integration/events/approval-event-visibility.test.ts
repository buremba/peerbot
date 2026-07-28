/**
 * Interaction events (approvals, suggestions) must stay visible to organization
 * members while a connection's ACL graph is fresh.
 *
 * The generic resource gate (`authz/resource-visibility`) hides an enforced
 * connection's events unless the requester is `member_of` a resource entity in
 * `events.entity_ids`. Agent-emitted interaction events (an operation's
 * "pending approval" card) are stamped with the connection they act THROUGH but
 * carry no resource entity link — so the gate hid them from org admins too, and
 * the approval permalink (`/{org}/memory?run_ids=…`)
 * rendered "No results found" with no way to approve. Interaction rows are
 * workflow state addressed to the org's authenticated humans, not
 * connector-synced resource content, so the fresh-ACL gate passes them through
 * without weakening its headless or stale-ACL boundaries.
 *
 * Also pins the second defect on the same rows: `insertEvent` persisted
 * `occurred_at` NULL when the caller supplied no timestamp, which breaks
 * date-feed ordering and terminates keyset pagination.
 */

import {
  type GithubRepoInput,
  githubAclSource,
  githubReposToResources,
} from '@lobu/connectors/github-identity';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAccessGraph } from '../../../authz/access-graph';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { clearEntityLinkRulesCache } from '../../../utils/entity-link-upsert';
import { insertEvent } from '../../../utils/insert-event';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

function ctxFor(
  orgId: string,
  userId: string | null,
  memberRole: string | null = userId ? 'owner' : null
): ToolContext {
  return {
    organizationId: orgId,
    userId,
    memberRole,
    isAuthenticated: !!userId,
    tokenType: userId ? 'oauth' : 'anonymous',
    scopedToOrg: !userId,
    allowCrossOrg: !!userId,
    scopes: userId ? ['mcp:read'] : undefined,
  } as ToolContext;
}

async function listEventIdsForRun(
  ctx: ToolContext,
  runId: number
): Promise<Set<number>> {
  const result = (await getContent(
    { run_ids: [runId], limit: 50 } as never,
    {} as never,
    ctx
  )) as { content?: Array<{ id: number }> };
  return new Set((result.content ?? []).map((c) => c.id));
}

describe('interaction events on ACL-enforced connections (approval permalink path)', () => {
  beforeAll(async () => {
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    clearEntityLinkRulesCache();
  });

  async function createPendingRun(orgId: string, connectionId: number): Promise<number> {
    const sql = getTestDb();
    const rows = await sql`
      INSERT INTO runs (
        organization_id, run_type, status, approval_status, connection_id, connector_key, action_key
      ) VALUES (
        ${orgId}, 'action', 'pending', 'pending', ${connectionId}, 'github', 'create_issue'
      )
      RETURNING id
    `;
    return Number(rows[0].id);
  }

  function insertApprovalEvent(orgId: string, connectionId: number, runId: number, origin: string) {
    return insertEvent({
      entityIds: [],
      organizationId: orgId,
      originId: origin,
      title: 'Create Issue — pending approval',
      semanticType: 'operation',
      connectorKey: 'github',
      connectionId,
      runId,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });
  }

  async function setupEnforcedWorkspace() {
    const org = await createTestOrganization({ name: 'Acme Approvals' });
    const alice = await createTestUser({
      name: 'Alice',
      email: 'alice-approvals@example.com',
    });
    await addUserToOrganization(alice.id, org.id, 'owner');

    const conn = await createTestConnection({
      organization_id: org.id,
      connector_key: 'github',
      visibility: 'org',
      createDefaultFeed: false,
    });

    const repos: GithubRepoInput[] = [
      { fullName: 'acme/repo-a', collaborators: [{ login: 'bob', id: 102 }] },
    ];
    await buildAccessGraph({
      organizationId: org.id,
      connectionId: String(conn.id),
      connectorKey: githubAclSource.key,
      resourceNamespace: githubAclSource.resourceNamespace,
      memberIdentities: githubAclSource.memberIdentities,
      resources: githubReposToResources(repos),
    });

    return { org, alice, conn };
  }

  it('an org member sees the pending-approval event via run_ids even though it has no resource link', async () => {
    const { org, alice, conn } = await setupEnforcedWorkspace();
    const runId = await createPendingRun(org.id, conn.id);
    const event = await insertApprovalEvent(org.id, conn.id, runId, `run_${runId}_pending`);

    // The approval permalink reads exactly this: run_ids-scoped list as the
    // signed-in member. Pre-fix the resource gate dropped the row (0 results).
    const visible = await listEventIdsForRun(ctxFor(org.id, alice.id), runId);
    expect(visible.has(event.id)).toBe(true);
  });

  it('the approval stays visible to a member when the ACL graph goes STALE (a stalled sync must not wedge approvals)', async () => {
    const { org, alice, conn } = await setupEnforcedWorkspace();
    const runId = await createPendingRun(org.id, conn.id);

    const event = await insertApprovalEvent(org.id, conn.id, runId, `run_${runId}_pending`);

    const sql = getTestDb();
    await sql`
      UPDATE authz_source_acl_state
      SET last_synced_at = current_timestamp - interval '90 minutes'
      WHERE organization_id = ${org.id} AND connection_id = ${String(conn.id)}
    `;

    const visible = await listEventIdsForRun(ctxFor(org.id, alice.id), runId);
    expect(visible.has(event.id)).toBe(true);
  });

  it('a plain non-interaction event with no resource link stays gated (exemption is interaction-only)', async () => {
    const { org, alice, conn } = await setupEnforcedWorkspace();
    const runId = await createPendingRun(org.id, conn.id);

    const event = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: `synced_${runId}`,
      title: 'repo A issue: quarterly metrics',
      content: 'synced connector content without a resource link',
      semanticType: 'message',
      connectorKey: 'github',
      connectionId: conn.id,
      runId,
    });

    // interaction_type='none' rows keep the enforced-connection membership
    // requirement — the exemption must not become a general bypass.
    const visible = await listEventIdsForRun(ctxFor(org.id, alice.id), runId);
    expect(visible.has(event.id)).toBe(false);
  });

  it('a headless caller cannot read the interaction event on an enforced connection', async () => {
    const { org, conn } = await setupEnforcedWorkspace();
    const runId = await createPendingRun(org.id, conn.id);
    const event = await insertApprovalEvent(org.id, conn.id, runId, `headless_${runId}`);

    const visible = await listEventIdsForRun(ctxFor(org.id, null), runId);
    expect(visible.has(event.id)).toBe(false);
  });

  it('an authenticated non-member cannot read the interaction event', async () => {
    const { org, conn } = await setupEnforcedWorkspace();
    const outsider = await createTestUser({
      name: 'Outsider',
      email: 'outsider-approvals@example.com',
    });
    const runId = await createPendingRun(org.id, conn.id);
    const event = await insertApprovalEvent(org.id, conn.id, runId, `outsider_${runId}`);

    const visible = await listEventIdsForRun(ctxFor(org.id, outsider.id, null), runId);
    expect(visible.has(event.id)).toBe(false);
  });

  it('insertEvent stamps occurred_at when the caller supplies none', async () => {
    const { org, conn } = await setupEnforcedWorkspace();

    const event = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'occurred-at-default-probe',
      title: 'no timestamp supplied',
      semanticType: 'operation',
      connectionId: conn.id,
      interactionType: 'approval',
      interactionStatus: 'pending',
    });

    const sql = getTestDb();
    const rows = await sql`SELECT occurred_at FROM events WHERE id = ${event.id}`;
    expect(rows[0]?.occurred_at).not.toBeNull();
  });

  it('an occurredAt-less upsert of identical state stays "unchanged" despite the stamped default', async () => {
    const { org, conn } = await setupEnforcedWorkspace();

    const params = {
      entityIds: [],
      organizationId: org.id,
      originId: 'occurred-at-dedup-probe',
      title: 'idempotent upsert',
      semanticType: 'operation' as const,
      connectionId: conn.id,
    };
    const first = await insertEvent(params, { onConflictUpdate: true });
    expect(first.change).toBe('inserted');

    // The auto-stamped occurred_at of the first insert must not read as a
    // semantic change on the identical re-upsert — that would supersede the
    // row on every re-sync.
    const second = await insertEvent(params, { onConflictUpdate: true });
    expect(second.change).toBe('unchanged');
    expect(second.id).toBe(first.id);
  });
});
