import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../../db/client';
import { AUTOMATION_RUN_SOURCE } from '../../../gateway/automation-run-session';
import type { Env } from '../../../index';
import {
  fingerprintAutomationSources,
  handleAutomationMode,
} from '../../../tools/get_content/automation-mode';
import { getContent } from '../../../tools/get_content/handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestAgent,
  createTestConnection,
  createTestEntity,
  createTestEvent,
  ownerToolContext,
} from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

const env = { JWT_SECRET: 'test-jwt-secret-for-testing-only' } as Env;
const since = '2026-07-30';
const until = '2026-07-30';
// Every fixture below is STORED at the instant it is dated: Automation windows
// select on `created_at`, and this suite's subject is connection visibility, not
// the axis. Pinning both keeps the fixed `since`/`until` range meaningful.
const occurredAt = new Date('2026-07-30T12:00:00.000Z');

function contentIds(result: unknown): number[] {
  return ((result as { content: Array<{ id: number }> }).content ?? [])
    .map((item) => Number(item.id))
    .sort((a, b) => a - b);
}

describe('Automation private-connection visibility', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('uses the caller for interactive reads and the Automation author for headless reads and fingerprints', async () => {
    const sql = getTestDb();
    const dbClient = sql as unknown as DbClient;
    const workspace = await TestWorkspace.create({
      name: 'Automation Visibility Principal Org',
    });
    const entity = await createTestEntity({
      name: 'Automation Visibility Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.admin.id,
      name: 'Automation Visibility Agent',
    });
    const created = (await workspace.owner.automations.create({
      entity_id: entity.id,
      slug: 'automation-visibility-principal',
      name: 'Automation Visibility Principal',
      prompt: 'Summarize the visible content.',
      managed_agent_id: agent.agentId,
      sources: [{ name: 'content', query: 'SELECT * FROM events' }],
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    const ownerConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      created_by: workspace.users.owner.id,
      visibility: 'private',
    });
    const adminConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      created_by: workspace.users.admin.id,
      visibility: 'private',
    });
    const ownerPrivate = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: ownerConnection.id,
      connector_key: 'slack',
      content: 'Owner private content',
      occurred_at: occurredAt,
      created_at: occurredAt,
    });
    // Fingerprint before the admin's private event exists, so the baseline can
    // only come from the Automation author's own private connection.
    const fingerprint = await fingerprintAutomationSources({
      sql: dbClient,
      automationId: automationId,
      windowStart: '2026-07-30T00:00:00.000Z',
      windowEnd: '2026-07-31T00:00:00.000Z',
    });
    expect(fingerprint.empty).toBe(false);

    const adminPrivate = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: adminConnection.id,
      connector_key: 'slack',
      content: 'Admin private content',
      occurred_at: occurredAt,
      created_at: occurredAt,
    });
    // An admin-private event must be invisible to the author-principal
    // fingerprint, so the digest has to stay byte-identical.
    expect(
      await fingerprintAutomationSources({
        sql: dbClient,
        automationId: automationId,
        windowStart: '2026-07-30T00:00:00.000Z',
        windowEnd: '2026-07-31T00:00:00.000Z',
      })
    ).toEqual(fingerprint);

    const orgConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      visibility: 'org',
    });
    const orgVisible = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: orgConnection.id,
      connector_key: 'slack',
      content: 'Organization-visible content',
      occurred_at: occurredAt,
      created_at: occurredAt,
    });

    const ownerRead = await workspace.owner.knowledge.read({
      automation_id: automationId,
      since,
      until,
    });
    expect(contentIds(ownerRead)).toEqual([ownerPrivate.id, orgVisible.id].sort((a, b) => a - b));

    const adminRead = await workspace.admin.knowledge.read({
      automation_id: automationId,
      since,
      until,
    });
    expect(contentIds(adminRead)).toEqual([adminPrivate.id, orgVisible.id].sort((a, b) => a - b));

    const automationRunRead = await getContent(
      { automation_id: automationId, since, until },
      env,
      {
        ...ownerToolContext(workspace.org.id, workspace.users.admin.id),
        agentId: agent.agentId,
        // Verified run identity must match the requested Automation.
        actingAutomationId: automationId,
        sourceContext: {
          source: AUTOMATION_RUN_SOURCE,
          conversationId: `${agent.agentId}_automation_${automationId}_run_99`,
        },
      }
    );
    expect(contentIds(automationRunRead)).toEqual(
      [ownerPrivate.id, orgVisible.id].sort((a, b) => a - b)
    );

    const otherCreated = (await workspace.admin.automations.create({
      entity_id: entity.id,
      slug: 'automation-visibility-other',
      name: 'Other Automation',
      prompt: 'Other',
      managed_agent_id: agent.agentId,
      sources: [{ name: 'content', query: 'SELECT * FROM events' }],
    })) as { automation_id: string };
    const otherAutomationId = Number(otherCreated.automation_id);

    await expect(
      getContent(
        { automation_id: otherAutomationId, since, until },
        env,
        {
          ...ownerToolContext(workspace.org.id, workspace.users.admin.id),
          agentId: agent.agentId,
          actingAutomationId: automationId,
          sourceContext: {
            source: AUTOMATION_RUN_SOURCE,
            conversationId: `${agent.agentId}_automation_${automationId}_run_99`,
          },
        }
      )
    ).rejects.toThrow(/own automation_id/);

    const headlessRead = await handleAutomationMode(
      { automation_id: automationId, since, until },
      env,
      dbClient,
      {
        organizationId: workspace.org.id,
        userId: null,
      }
    );
    expect(contentIds(headlessRead)).toEqual(
      [ownerPrivate.id, orgVisible.id].sort((a, b) => a - b)
    );
  });

  it('ordinary-member automation reads exclude workspace-audit rows from content AND total_count', async () => {
    const sql = getTestDb();
    const dbClient = sql as unknown as DbClient;
    const workspace = await TestWorkspace.create({
      name: 'Automation Audit Exclusion Org',
    });
    const entity = await createTestEntity({
      name: 'Automation Audit Exclusion Entity',
      organization_id: workspace.org.id,
      created_by: workspace.users.owner.id,
    });
    const agent = await createTestAgent({
      organizationId: workspace.org.id,
      ownerUserId: workspace.users.admin.id,
      name: 'Automation Audit Exclusion Agent',
    });
    const created = (await workspace.owner.automations.create({
      entity_id: entity.id,
      slug: 'automation-audit-exclusion',
      name: 'Automation Audit Exclusion',
      prompt: 'Summarize the visible content.',
      managed_agent_id: agent.agentId,
      sources: [{ name: 'content', query: 'SELECT * FROM events' }],
    })) as { automation_id: string };
    const automationId = Number(created.automation_id);

    // A genuine workspace-audit row (server-owned discriminator) and an
    // ordinary org-visible event.
    const auditEvent = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connector_key: 'slack',
      content: 'workspace audit lifecycle row',
      occurred_at: occurredAt,
      created_at: occurredAt,
      semantic_type: 'change',
      metadata: { category: 'workspace', _lobu_workspace_audit: true },
    });
    const orgConnection = await createTestConnection({
      organization_id: workspace.org.id,
      connector_key: 'slack',
      visibility: 'org',
    });
    const orgVisible = await createTestEvent({
      entity_id: entity.id,
      organization_id: workspace.org.id,
      connection_id: orgConnection.id,
      connector_key: 'slack',
      content: 'Organization-visible content',
      occurred_at: occurredAt,
      created_at: occurredAt,
    });

    // Ordinary member: automation read content excludes the audit row.
    const memberRead = await getContent(
      { automation_id: automationId, since, until },
      env,
      {
        ...ownerToolContext(workspace.org.id, workspace.users.member.id),
        memberRole: 'member',
      }
    );
    expect(contentIds(memberRead)).toEqual([orgVisible.id]);

    // Owner: sees both.
    const ownerRead = await getContent(
      { automation_id: automationId, since, until },
      env,
      ownerToolContext(workspace.org.id, workspace.users.owner.id)
    );
    expect(contentIds(ownerRead)).toEqual([orgVisible.id, auditEvent.id].sort((a, b) => a - b));

    // total_count agrees with content for the ordinary member (no audit leak).
    const memberTotal = (memberRead as { total_count?: number }).total_count;
    expect(memberTotal).toBe(1);
  });
});
