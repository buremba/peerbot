/**
 * Ownership gate on direct agent entity writes.
 *
 * The human<->agent feedback loop protects human-owned entity fields via
 * `entities.field_controls` on the automation PROMOTION path, but the direct
 * `manage_entity` update path used to do a plain merge that silently clobbered
 * human-owned fields. After the fix, EVERY non-human `manage_entity update`
 * runs an ownership-aware `source:'automation'` merge: unowned fields write
 * normally, owned fields are BLOCKED and queued as a human approval, and the
 * tool result reports what happened so the agent can tell the user.
 *
 * These contracts pin that ownership gate end-to-end through `executeTool` (the real
 * access-controlled path) so the post-commit approval proposal is exercised.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { AuthContext } from '../../../tools/execute';
import { executeTool } from '../../../tools/execute';
import { manageEntity } from '../../../tools/admin/manage_entity';
import { proposeEntityDelete } from '../../../tools/admin/entity-field-approval';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
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

/** Trusted in-process context used only by the durable reaction executor. */
function reactionCtx(
	orgId: string,
	automationId: number,
	runId: number,
): ToolContext {
	return {
		organizationId: orgId,
		userId: null,
		memberRole: null,
		agentId: null,
		actingAutomationId: automationId,
		actingRunId: runId,
		isAutomationReaction: true,
		sourceContext: { source: "automation-run" },
		isAuthenticated: true,
		clientId: null,
		scopes: null,
		tokenType: "session",
		scopedToOrg: true,
		allowCrossOrg: false,
		grantedOrganizationIds: null,
		directSearchFederation: false,
	};
}

async function manageEntityUpdate(
  ctx: AuthContext,
  entityId: number,
  metadata: Record<string, unknown>,
  opts?: {
    affirm_fields?: string[];
    automation_source?: { automation_id: number; run_id: number };
  }
) {
  return executeTool(
    'manage_entity',
    {
      action: 'update',
      entity_id: entityId,
      metadata,
      ...(opts?.affirm_fields ? { affirm_fields: opts.affirm_fields } : {}),
      ...(opts?.automation_source ? { automation_source: opts.automation_source } : {}),
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
    approval_attribution?: 'agent' | 'automation';
  }>;
}

/** Seed an Automation plus a real parent run for attribution/lifecycle tests. */
async function seedAutomationAndRun(
	workspace: TestWorkspace,
	suffix: string,
	status: "running" | "completed" = "running",
) {
  const entity = await createTestEntity({
    name: `Gate Reaction Entity ${suffix}`,
    organization_id: workspace.org.id,
    created_by: workspace.users.owner.id,
  });
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId: workspace.users.owner.id,
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: `gate-automation-${suffix}`,
    name: `Gate Automation ${suffix}`,
    prompt: 'Analyze inputs.',
    agent_id: agent.agentId,
  })) as { automation_id: string };
  const [run] = await getTestDb()`
    INSERT INTO runs (
      organization_id, run_type, automation_id, status, approval_status,
      created_by_user_id, created_at, completed_at
    ) VALUES (
      ${workspace.org.id}, 'automation', ${Number(automation.automation_id)},
      ${status}, 'auto', ${workspace.users.owner.id}, NOW(),
      ${status === "completed" ? new Date() : null}
    )
    RETURNING id
  `;
  const runId = Number(run.id);
  return {
    entity,
    automationId: Number(automation.automation_id),
    runId,
    agentId: agent.agentId,
  };
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
    // The default agentCtx binds 'test-agent-1' (and one test 'restricted-agent').
    // Prod binds an agentId only for an existing agent (codex-17), and the gate's
    // existence check now enforces it — so seed the rows these ctxs assume.
    for (const agentId of ['test-agent-1', 'restricted-agent']) {
      await createTestAgent({
        organizationId: workspace.org.id,
        agentId,
        ownerUserId: workspace.users.owner.id,
      });
    }
  });

  it('blocks an agent overwrite of a human-owned field and queues an approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    // Human claims ownership of `severity` by setting it.
    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });

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

  it('attributes an active caller-declared source to the agent-owned Automation', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;
    const {
      entity: reactionEntity,
      automationId,
      runId,
      agentId,
    } = await seedAutomationAndRun(workspace, 'reaction');

    // Human owns the field first.
    await manageEntityUpdate(humanCtx(org, user), reactionEntity.id, {
      severity: 'high',
    });

		// The explicit source names an Automation owned by this agent, so the tag is
		// honored while its causal parent is still active.
    const result = await manageEntityUpdate(
      agentCtx(org, user, agentId),
      reactionEntity.id,
      { severity: 'critical' },
      { automation_source: { automation_id: automationId, run_id: runId } }
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
    expect(Number((run.action_input as { automation_id: number }).automation_id)).toBe(automationId);

    // The card attribution flows through as 'automation' so the SPA labels it
    // "An automation proposes…" instead of "An agent proposes…".
    expect(result.approval_attribution).toBe('automation');
  });

	it("queues a trusted reaction entity review artifact after its source run completed", async () => {
		const org = workspace.org.id;
		const user = workspace.users.owner.id;
		const {
			entity: target,
			automationId,
			runId,
		} = await seedAutomationAndRun(
			workspace,
			"completed-reaction",
			"completed",
		);

		await manageEntityUpdate(humanCtx(org, user), target.id, {
			severity: "high",
		});
		const result = (await manageEntity(
			{
				action: "update",
				entity_id: target.id,
				metadata: { severity: "critical" },
			},
			TEST_ENV,
			reactionCtx(org, automationId, runId),
		)) as {
			approval_queued?: boolean;
			approval_attribution?: "agent" | "automation";
		};

		expect(result.approval_queued).toBe(true);
		expect(result.approval_attribution).toBe("automation");
		const [proposal] = await getTestDb()`
      SELECT automation_id, parent_run_id, run_metadata
      FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
		expect(Number(proposal.automation_id)).toBe(automationId);
		expect(Number(proposal.parent_run_id)).toBe(runId);
		expect(
			(proposal.run_metadata as Record<string, unknown> | null)
				?.automation_review_artifact,
		).toBe(true);
	});

	it("queues a trusted reaction delete review artifact after its source run completed", async () => {
		const org = workspace.org.id;
		const { entity: target, automationId, runId } =
			await seedAutomationAndRun(workspace, "completed-delete-reaction", "completed");

		const result = (await manageEntity(
			{ action: "delete", entity_id: target.id },
			TEST_ENV,
			reactionCtx(org, automationId, runId),
		)) as { approval_queued?: boolean; approval_run_id?: number };

		expect(result.approval_queued).toBe(true);
		const [proposal] = await getTestDb()`
      SELECT automation_id, parent_run_id, run_metadata, action_input
      FROM runs
      WHERE id = ${result.approval_run_id ?? -1}
    `;
		expect(Number(proposal.automation_id)).toBe(automationId);
		expect(Number(proposal.parent_run_id)).toBe(runId);
		expect((proposal.action_input as { operation: string }).operation).toBe("delete");
		expect(
			(proposal.run_metadata as Record<string, unknown> | null)
				?.automation_review_artifact,
		).toBe(true);
	});

	it("upgrades a reused delete proposal into a trusted reaction review artifact", async () => {
		const org = workspace.org.id;
		const { entity: target, automationId, runId } =
			await seedAutomationAndRun(workspace, "reused-delete-reaction");
		const ctx = reactionCtx(org, automationId, runId);
		const proposal = {
			entity_id: target.id,
			force_delete_tree: false,
			current: {
				id: target.id,
				entity_type: "entity",
				name: "Reused delete target",
				metadata: {},
			},
			automation_id: automationId,
		};
		const first = await proposeEntityDelete(ctx, proposal, runId);
		await getTestDb()`
      UPDATE runs SET status = 'completed', completed_at = NOW() WHERE id = ${runId}
    `;
		const reused = await proposeEntityDelete(ctx, proposal, runId, {
			automationReviewArtifact: true,
		});
		expect(reused.runId).toBe(first.runId);
		const [row] = await getTestDb()`
      SELECT run_metadata FROM runs WHERE id = ${first.runId}
    `;
		expect(
			(row.run_metadata as Record<string, unknown> | null)
				?.automation_review_artifact,
		).toBe(true);
	});

	it("rejects a late caller-declared source after its parent completed", async () => {
		const org = workspace.org.id;
		const user = workspace.users.owner.id;
		const {
			entity: target,
			automationId,
			runId,
			agentId,
		} = await seedAutomationAndRun(
			workspace,
			"completed-declaration",
			"completed",
		);
		await manageEntityUpdate(humanCtx(org, user), target.id, {
			severity: "high",
		});

		await expect(
			manageEntityUpdate(
				agentCtx(org, user, agentId),
				target.id,
				{ severity: "critical" },
				{ automation_source: { automation_id: automationId, run_id: runId } },
			),
		).rejects.toThrow(/parent run .* no longer active/i);
	});

  it("ignores a caller-supplied automation_source that is NOT the acting agent's own automation", async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;
    // An automation owned by a DIFFERENT agent than the one making the call.
    const {
      entity: target,
      automationId,
      runId,
    } = await seedAutomationAndRun(workspace, 'foreign');

    await manageEntityUpdate(humanCtx(org, user), target.id, {
      severity: 'high',
    });

    // A restricted agent tags the foreign automation, trying to escape its own
    // envelope. The tag must be IGNORED → the write is attributed to the agent,
    // not the automation (ownerAgentId can't be nulled out via a foreign tag).
    const result = await manageEntityUpdate(
      agentCtx(org, user, 'restricted-agent'),
      target.id,
      { severity: 'critical' },
      { automation_source: { automation_id: automationId, run_id: runId } }
    );

    expect(result.approval_attribution).toBe('agent');
    const [proposal] = await getTestDb()`
      SELECT automation_id, parent_run_id
      FROM runs
      WHERE organization_id = ${org}
        AND run_type = 'internal'
        AND action_key = 'entity_field_change'
        AND approval_status = 'pending'
    `;
    expect(proposal.automation_id).toBeNull();
    expect(proposal.parent_run_id).toBeNull();
  });

  it('collapses an identical repeated agent edit into a single pending approval', async () => {
    const org = workspace.org.id;
    const user = workspace.users.owner.id;

    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });

    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });
    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });

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

    await manageEntityUpdate(humanCtx(org, user), entity.id, {
      severity: 'high',
    });
    await manageEntityUpdate(agentCtx(org, user), entity.id, {
      severity: 'critical',
    });

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
