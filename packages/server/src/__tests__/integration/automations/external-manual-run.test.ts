import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { createAutomationRun } from '../../../runs/queue-service';
import { handleCompleteWindow } from '../../../tools/admin/manage_automations/complete-window';
import type { ToolContext } from '../../../tools/registry';
import { generateWindowToken } from '../../../utils/jwt';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEntity, createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    task_key: { type: 'string' },
    action: { type: 'string' },
  },
  required: ['task_key', 'action'],
  additionalProperties: true,
};

const TASK_OUTPUTS = {
  tasks: {
    entity: 'task',
    key: ['task_key'],
    name: ['action'],
  },
};

const EDITED_OUTPUTS = {
  findings: {
    entity: 'task',
    key: ['task_key'],
    name: ['action'],
  },
};

const TEST_ENV: Env = {
  ENVIRONMENT: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: 'test-jwt-secret-for-testing-only',
  BETTER_AUTH_SECRET: 'test-auth-secret-for-testing-only',
};

describe('external manual Automation execution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('triggers without the gateway, reads the queued run after a version edit, and persists keyed output', async () => {
    const sql = getTestDb();
    const workspace = await TestWorkspace.create({ name: 'External Automation Org' });
    const parent = await createTestEntity({
      name: 'Task Board',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });

    await sql`
      INSERT INTO entity_types (
        organization_id, slug, name, metadata_schema, created_at, updated_at
      ) VALUES (
        ${workspace.org.id}, 'task', 'Task', ${sql.json(TASK_SCHEMA)}, NOW(), NOW()
      )
    `;

    const created = (await workspace.owner.automations.create({
      entity_id: parent.id,
      slug: 'external-task-builder',
      name: 'External Task Builder',
      prompt: 'Extract durable tasks.',
      sources: [
        {
          name: 'signals',
          query: 'SELECT id, payload_text, occurred_at FROM events WHERE false',
        },
      ],
      outputs: TASK_OUTPUTS,
      agent_id: null,
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    // Vitest has no embedded Lobu gateway. An agentless manual run must still
    // materialize and remain pending for the external MCP completion path.
    const triggered = (await workspace.owner.automations.trigger({
      automation_id: created.automation_id,
    })) as { run_id: number; status: string };
    expect(triggered.status).toBe('pending');

    const [queued] = await sql<{
      status: string;
      approved_input: Record<string, unknown>;
    }>`
      SELECT status, approved_input
      FROM runs
      WHERE id = ${triggered.run_id}
    `;
    expect(queued.status).toBe('pending');
    const queuedVersionId = Number(queued.approved_input.version_id);
    const queuedWindowStart = String(queued.approved_input.window_start);
    const queuedWindowEnd = String(queued.approved_input.window_end);
    expect(queuedVersionId).toBeGreaterThan(0);

    // A workspace event-window run stores exact durable pointers in its run
    // snapshot. The caller should not have to repeat content_ids when reading
    // that run later.
    const triggerOccurredAt = new Date(
      (Date.parse(queuedWindowStart) + Date.parse(queuedWindowEnd)) / 2
    );
    const triggerEvent = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'A durable workspace signal for the task builder.',
      occurred_at: triggerOccurredAt,
    });
    const workspaceSignal = {
      kind: 'event',
      source: 'workspace',
      event_id: triggerEvent.id,
      event_type: 'observation',
      delivery_id: `workspace-event:${triggerEvent.id}`,
      occurred_at: triggerOccurredAt.toISOString(),
      root_event_ids: [triggerEvent.id],
      causal_automation_ids: [99],
      depth: 1,
    };
    await sql`
      UPDATE runs
      SET approved_input = approved_input
        || jsonb_build_object('dispatch_source', 'event')
        || jsonb_build_object('trigger_signal', ${sql.json(workspaceSignal)}::jsonb)
        || jsonb_build_object('trigger_signals', ${sql.json([workspaceSignal])}::jsonb)
      WHERE id = ${triggered.run_id}
    `;

    // Change the live Automation to an incompatible output name after the run
    // is queued. The run-bound read must keep the original version and schema.
    await workspace.owner.automations.createVersion({
      automation_id: created.automation_id,
      prompt: 'Extract findings instead.',
      outputs: EDITED_OUTPUTS,
    });
    const [edited] = await sql<{ current_version_id: number }>`
      SELECT current_version_id
      FROM automations
      WHERE id = ${automationId}
    `;
    expect(Number(edited.current_version_id)).not.toBe(queuedVersionId);

    const read = (await workspace.owner.knowledge.read({
      automation_id: automationId,
      run_id: triggered.run_id,
      limit: 25,
    })) as {
      window_token?: string;
      window_start?: string;
      window_end?: string;
      content: Array<{ id?: number }>;
      extraction_schema?: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
    };
    expect(read.window_start).toBe(queuedWindowStart);
    expect(read.window_end).toBe(queuedWindowEnd);
    expect(read.extraction_schema?.required).toContain('tasks');
    expect(read.extraction_schema?.properties?.tasks).toBeDefined();
    expect(read.extraction_schema?.properties?.findings).toBeUndefined();
    expect(read.content.map((item) => Number(item.id))).toContain(triggerEvent.id);
    if (!read.window_token) throw new Error('run-bound read returned no window token');

    const unrelatedEvent = await createTestEvent({
      entity_id: parent.id,
      organization_id: workspace.org.id,
      content: 'Not part of the queued run trigger snapshot.',
      occurred_at: triggerOccurredAt,
    });
    await expect(
      workspace.owner.knowledge.read({
        automation_id: automationId,
        run_id: triggered.run_id,
        content_ids: [unrelatedEvent.id],
      })
    ).rejects.toThrow(/does not include trigger content id/);

    const other = (await workspace.owner.automations.create({
      entity_id: parent.id,
      slug: 'other-external-automation',
      name: 'Other External Automation',
      prompt: 'Do something else.',
      sources: [
        {
          name: 'signals',
          query: 'SELECT id, payload_text, occurred_at FROM events WHERE false',
        },
      ],
    })) as { automation_id: string };
    await expect(
      workspace.owner.knowledge.read({
        automation_id: Number(other.automation_id),
        run_id: triggered.run_id,
      })
    ).rejects.toThrow(/does not belong to Automation/);

    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: triggered.run_id,
        window_token: read.window_token,
        extracted_data: {
          tasks: [{ task_key: 'invalid-before-claim' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/extracted_data does not match/);
    const [stillPendingAfterInvalid] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${triggered.run_id}
    `;
    expect(stillPendingAfterInvalid).toEqual({
      status: 'pending',
      claimed_by: null,
    });

    const identitylessContext: ToolContext = {
      organizationId: workspace.org.id,
      userId: null,
      memberRole: 'owner',
      agentId: null,
      isAuthenticated: true,
      clientId: null,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType: 'session',
      scopedToOrg: true,
      allowCrossOrg: false,
      executionMode: 'live',
    };
    await expect(
      handleCompleteWindow(
        {
          action: 'complete_window',
          automation_id: created.automation_id,
          run_id: triggered.run_id,
          window_token: read.window_token,
          extracted_data: {
            tasks: [{ task_key: 'identityless', action: 'Must not persist' }],
          },
          model: 'chatgpt/test',
        } as never,
        TEST_ENV,
        identitylessContext
      )
    ).rejects.toThrow(/requires an authenticated MCP client or user/);
    const [stillUnclaimed] = await sql<{ status: string; claimed_by: string | null }>`
      SELECT status, claimed_by FROM runs WHERE id = ${triggered.run_id}
    `;
    expect(stillUnclaimed).toEqual({ status: 'pending', claimed_by: null });

    const completion = (await workspace.owner.automations.completeWindow({
      automation_id: created.automation_id,
      run_id: triggered.run_id,
      window_token: read.window_token,
      extracted_data: {
        tasks: [{ task_key: 'invoice-review', action: 'Review invoice' }],
      },
      model: 'chatgpt/test',
    })) as { action: string; run_id: number };
    expect(completion.action).toBe('complete_window');
    expect(completion.run_id).toBe(triggered.run_id);

    const [completed] = await sql<{
      status: string;
      claimed_by: string | null;
      model_used: string | null;
    }>`
      SELECT status, claimed_by, model_used
      FROM runs
      WHERE id = ${triggered.run_id}
    `;
    expect(completed).toEqual({
      status: 'completed',
      claimed_by: `user:${workspace.users.owner.id}`,
      model_used: 'chatgpt/test',
    });

    // A token minted for run A must not authorize run B even when both runs
    // deliberately cover the same Automation period.
    const secondRun = await createAutomationRun({
      organizationId: workspace.org.id,
      automationId,
      agentId: null,
      windowStart: queuedWindowStart,
      windowEnd: queuedWindowEnd,
      dispatchSource: 'manual',
    });
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: read.window_token,
        extracted_data: {
          findings: [{ task_key: 'wrong-run', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/window_token belongs to Automation run/);
    const [stillPending] = await sql<{ status: string }>`
      SELECT status FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(stillPending.status).toBe('pending');

    const legacyToken = await generateWindowToken(
      {
        automation_id: automationId,
        window_start: queuedWindowStart,
        window_end: queuedWindowEnd,
        granularity: 'weekly',
        content_count: 0,
        content_ids: [],
      },
      TEST_ENV
    );
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: legacyToken,
        extracted_data: {
          findings: [{ task_key: 'legacy-token', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/requires a run-bound window_token/);
    const [stillPendingAfterLegacyToken] = await sql<{
      status: string;
      claimed_by: string | null;
    }>`
      SELECT status, claimed_by FROM runs WHERE id = ${secondRun.runId}
    `;
    expect(stillPendingAfterLegacyToken).toEqual({
      status: 'pending',
      claimed_by: null,
    });

    const secondRead = (await workspace.owner.knowledge.read({
      automation_id: automationId,
      run_id: secondRun.runId,
      limit: 25,
    })) as { window_token?: string };
    if (!secondRead.window_token) throw new Error('second run returned no window token');
    await sql`
      UPDATE runs
      SET status = 'running',
          claimed_by = 'mcp:other-client',
          claimed_at = NOW()
      WHERE id = ${secondRun.runId}
    `;
    await expect(
      workspace.owner.automations.completeWindow({
        automation_id: created.automation_id,
        run_id: secondRun.runId,
        window_token: secondRead.window_token,
        extracted_data: {
          findings: [{ task_key: 'other-claim', action: 'Must not persist' }],
        },
        model: 'chatgpt/test',
      })
    ).rejects.toThrow(/already claimed by another executor/);

    const promoted = await sql<{
      parent_id: number | null;
      metadata: Record<string, unknown>;
    }>`
      SELECT e.parent_id, e.metadata
      FROM entity_identities ei
      JOIN entities e ON e.id = ei.entity_id
      WHERE ei.organization_id = ${workspace.org.id}
        AND ei.namespace = 'automation_key'
        AND e.deleted_at IS NULL
    `;
    expect(promoted).toHaveLength(1);
    expect(Number(promoted[0].parent_id)).toBe(parent.id);
    expect(promoted[0].metadata).toMatchObject({
      task_key: 'invoice-review',
      action: 'Review invoice',
      automation_id: automationId,
      run_id: triggered.run_id,
    });
  });
});
