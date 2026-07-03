/**
 * Ownership gate on direct agent entity writes.
 *
 * The human<->agent feedback loop protects human-owned entity fields via
 * `entities.field_controls` on the watcher PROMOTION path, but the direct
 * `manage_entity` update path used to do a plain merge that silently clobbered
 * human-owned fields. After the fix, EVERY non-human `manage_entity update`
 * runs an ownership-aware `source:'watcher'` merge: unowned fields write
 * normally, owned fields are BLOCKED and queued as a human approval, and the
 * tool result reports what happened so the agent can tell the user.
 *
 * These contracts pin that behavior end-to-end through `executeTool` (the real
 * access-controlled path) so the post-commit approval proposal is exercised.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createCanvasWindow,
  createTestAgent,
  createTestEntity,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

/** Owner web-session auth context (a real human — claims field ownership). */
function humanCtx(orgId: string, userId: string): AuthContext {
  return {
    organizationId: orgId,
    tokenOrganizationId: orgId,
    userId,
    memberRole: 'owner',
    agentId: null,
    requestedAgentId: null,
    isAuthenticated: true,
    clientId: null,
    scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
    tokenType: 'oauth',
    requestUrl: `http://localhost/api/${orgId}`,
    baseUrl: '',
    scopedToOrg: true,
    allowCrossOrg: false,
  };
}

/** Agent auth context — same org/user but attributed to an agent run. */
function agentCtx(orgId: string, userId: string, agentId = 'test-agent-1'): AuthContext {
  return { ...humanCtx(orgId, userId), agentId, requestedAgentId: agentId };
}

async function manageEntityUpdate(
  ctx: AuthContext,
  entityId: number,
  metadata: Record<string, unknown>,
  opts?: { affirm_fields?: string[]; watcher_source?: { watcher_id: number; window_id: number } }
) {
  return executeTool(
    'manage_entity',
    {
      action: 'update',
      entity_id: entityId,
      metadata,
      ...(opts?.affirm_fields ? { affirm_fields: opts.affirm_fields } : {}),
      ...(opts?.watcher_source ? { watcher_source: opts.watcher_source } : {}),
    },
    TEST_ENV,
    ctx
  ) as Promise<{
    action: 'update';
    applied_fields?: string[];
    blocked_fields?: string[];
    approval_queued?: boolean;
    approval_url?: string;
    approval_run_id?: number;
    approval_fields?: Record<string, unknown>;
    approval_current?: Record<string, unknown>;
    approval_attribution?: 'agent' | 'watcher';
  }>;
}

/** Seed a watcher + canvas window (real FKs for watcher_source / reactions). */
async function seedWatcherAndWindow(workspace: TestWorkspace, suffix: string) {
  const entity = await createTestEntity({
    name: `Gate Reaction Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const watcher = (await workspace.owner.watchers.create({
    entity_id: entity.id,
    slug: `gate-watcher-${suffix}`,
    name: `Gate Watcher ${suffix}`,
    prompt: 'Analyze inputs.',
    agent_id: agent.agentId,
  })) as { watcher_id: string };
  const windowId = await createCanvasWindow({
    watcherId: Number(watcher.watcher_id),
    organizationId: workspace.org.id,
    granularity: 'weekly',
    windowStart: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    windowEnd: new Date(),
    extractedData: { problems: [] },
    createdBy: workspace.users.owner.id,
    entityIds: [entity.id],
  });
  return { entity, watcherId: Number(watcher.watcher_id), windowId };
}

describe('ownership gate on agent entity writes', () => {
  let workspace: TestWorkspace;
  let entity: { id: number };

  beforeEach(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Ownership Gate Org' });
    const created = await createTestEntity({
      name: 'Gate Target Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    entity = { id: created.id };
  });

  it('blocks an agent overwrite of a human-owned field and queues an approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    // Human claims ownership of `severity` by setting it.
    await manageEntityUpdate(humanCtx(org, user), entity.id, { severity: 'high' });

    // Agent tries to overwrite the owned field AND write a fresh unowned field.
    const result = await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
      notes: 'agent-added',
    });

    // Owned field UNCHANGED — the agent did not clobber it.
    const [row] = await getTestDb()`
      SELECT metadata, field_controls FROM entities WHERE id = ${entity.id}
    `;
    const metadata = row.metadata as Record<string, unknown>;
    const controls = row.field_controls as Record<string, unknown>;
    expect(metadata.severity).toBe('high');
    expect(controls.severity).toBeTruthy();

    // Unowned field wrote through.
    expect(metadata.notes).toBe('agent-added');

    // A pending approval run + interaction event exist for the blocked field.
    const [run] = await getTestDb()`
      SELECT id, action_input FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
        AND status = 'pending'
    `;
    expect(run).toBeTruthy();
    const proposal = run.action_input as {
      entity_id: number;
      fields: Record<string, unknown>;
    };
    expect(Number(proposal.entity_id)).toBe(entity.id);
    expect(proposal.fields.severity).toBe('critical');

    const [event] = await getTestDb()`
      SELECT interaction_status FROM events
      WHERE run_id = ${run.id} AND interaction_type = 'approval'
    `;
    expect(event?.interaction_status).toBe('pending');

    // The tool result told the agent what happened.
    expect(result.blocked_fields).toContain('severity');
    expect(result.applied_fields).toContain('notes');
    expect(result.approval_queued).toBe(true);

    // The result carries the bridge fields the worker forwards into a live
    // chat approval card (parity with manage_agents' pending_approval).
    expect(result.approval_run_id).toBe(Number(run.id));
    expect(result.approval_fields?.severity).toBe('critical');
    expect(result.approval_current?.severity).toBe('high');
    expect(result.approval_attribution).toBe('agent');
  });

  it('writes unowned fields without producing an approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    const result = await manageEntityUpdate(agentCtx(org, user), entity.id, {
      domain: 'agent-set.example',
      category: 'SaaS',
    });

    const [row] = await getTestDb()`SELECT metadata FROM entities WHERE id = ${entity.id}`;
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.domain).toBe('agent-set.example');
    expect(metadata.category).toBe('SaaS');

    expect(result.applied_fields).toEqual(expect.arrayContaining(['domain', 'category']));
    expect(result.blocked_fields ?? []).toEqual([]);

    const approvals = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(approvals).toHaveLength(0);
    expect(result.approval_queued).toBeFalsy();
  });

  it('attributes the proposal to the watcher on the reaction path', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;
    const { entity: reactionEntity, watcherId, windowId } = await seedWatcherAndWindow(
      workspace,
      'reaction'
    );

    // Human owns the field first.
    await manageEntityUpdate(humanCtx(org, user), reactionEntity.id, { severity: 'high' });

    // Agent mutation attributed to a watcher reaction.
    const result = await manageEntityUpdate(
      agentCtx(org, user),
      reactionEntity.id,
      { severity: 'critical' },
      { watcher_source: { watcher_id: watcherId, window_id: windowId } }
    );

    const [row] = await getTestDb()`SELECT metadata FROM entities WHERE id = ${reactionEntity.id}`;
    expect((row.metadata as Record<string, unknown>).severity).toBe('high');

    const [run] = await getTestDb()`
      SELECT action_input FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(run).toBeTruthy();
    expect(Number((run.action_input as { watcher_id: number }).watcher_id)).toBe(watcherId);

    // The card attribution flows through as 'watcher' so the SPA labels it
    // "A watcher proposes…" instead of "An agent proposes…".
    expect(result.approval_attribution).toBe('watcher');
  });

  it('collapses an identical repeated agent edit into a single pending approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await manageEntityUpdate(humanCtx(org, user), entity.id, { severity: 'high' });

    await manageEntityUpdate(agentCtx(org, user), entity.id, { severity: 'critical' });
    await manageEntityUpdate(agentCtx(org, user), entity.id, { severity: 'critical' });

    const pending = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending).toHaveLength(1);
  });

  it('applies the field change when the queued proposal is approved', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await manageEntityUpdate(humanCtx(org, user), entity.id, { severity: 'high' });
    await manageEntityUpdate(agentCtx(org, user), entity.id, { severity: 'critical' });

    const [pending] = await getTestDb()`
      SELECT id FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(pending).toBeTruthy();

    const approveRes = (await executeTool(
      'manage_operations',
      { action: 'approve', run_id: Number(pending.id) },
      TEST_ENV,
      humanCtx(org, user)
    )) as { approved?: boolean };
    expect(approveRes.approved).toBe(true);

    const [applied] = await getTestDb()`
      SELECT metadata, field_controls FROM entities WHERE id = ${entity.id}
    `;
    expect((applied.metadata as Record<string, unknown>).severity).toBe('critical');
    // Still human-owned — an approved value remains protected.
    expect((applied.field_controls as Record<string, unknown>).severity).toBeTruthy();
  });

  it('rejects affirm_fields from an agent context (an agent cannot claim ownership)', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await expect(
      manageEntityUpdate(agentCtx(org, user), entity.id, {}, { affirm_fields: ['severity'] })
    ).rejects.toThrow(/affirm_fields/);
  });
});
