/**
 * The verification has to hold at the WRITE SURFACES, not just in the helper.
 *
 * `manage_entity` merged the trusted session identity with the caller-declared
 * `automation_source` inline at seven places, and `save_content` took the
 * declared pair verbatim with no precedence at all. A unit test on the resolver
 * proves the rule; these prove the surfaces actually go through it, which is
 * the part a future refactor can silently undo.
 *
 * `automation_reactions` is the observable end of that path: a row appears with
 * the Automation credited for the write, or no row appears at all. Each case
 * pairs the forged declaration with an owned one, so a change that disabled
 * reaction tracking outright cannot make these pass by writing nothing.
 *
 * Only the cross-org case is asserted here. A NONEXISTENT id is invisible at
 * this surface: the composite foreign key already rejected the insert and the
 * call site swallows the error, so the row count was zero before this change
 * too. Asserting it here would pass either way — `automation-source-attribution`
 * covers that case where the difference is actually observable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createAutomationResultRun, createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function orgWithAutomationAndRun(name: string, slug: string) {
  const workspace = await TestWorkspace.create({ name });
  const ownerUserId = workspace.users.owner.id;
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: `${slug}-agent`,
  });
  const api = await TestApiClient.for({
    organizationId: workspace.org.id,
    userId: ownerUserId,
    memberRole: 'owner',
  });
  const created = (await api.automations.create({
    slug,
    prompt: 'Anything.',
    agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  const runId = await createAutomationResultRun({
    automationId,
    organizationId: workspace.org.id,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-08T00:00:00.000Z',
    createdBy: ownerUserId,
  });
  return {
    api,
    organizationId: workspace.org.id,
    automationId,
    runId,
  };
}

async function reactionRows(organizationId: string) {
  const rows = await getTestDb()<{
    automation_id: number | string;
    source_run_id: number | string;
  }>`
    SELECT automation_id, source_run_id
    FROM automation_reactions
    WHERE organization_id = ${organizationId}
    ORDER BY id
  `;
  return rows.map((row) => ({
    automation_id: Number(row.automation_id),
    run_id: Number(row.source_run_id),
  }));
}

describe('write surfaces refuse an unowned automation_source', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('keeps only owned credit when save_memory also declares another org’s Automation', async () => {
    const victim = await orgWithAutomationAndRun('Surface Victim', 's-victim');
    const attacker = await orgWithAutomationAndRun('Surface Attacker', 's-attacker');

    await attacker.api.knowledge.save({
      semantic_type: 'note',
      metadata: {},
      title: 'Owned credit',
      content: 'Attributed to this organization’s Automation.',
      automation_source: {
        automation_id: attacker.automationId,
        run_id: attacker.runId,
      },
    });

    await attacker.api.knowledge.save({
      semantic_type: 'note',
      metadata: {},
      title: 'Borrowed credit',
      content: 'Attributed to an Automation this org does not own.',
      automation_source: {
        automation_id: victim.automationId,
        run_id: victim.runId,
      },
    });

    await expect(reactionRows(attacker.organizationId)).resolves.toEqual([
      { automation_id: attacker.automationId, run_id: attacker.runId },
    ]);
    await expect(reactionRows(victim.organizationId)).resolves.toEqual([]);
  });

  it('keeps only owned credit when manage_entity also declares another org’s Automation', async () => {
    const victim = await orgWithAutomationAndRun('Entity Victim', 'e-victim');
    const attacker = await orgWithAutomationAndRun('Entity Attacker', 'e-attacker');
    await attacker.api.entity_schema.createType({ slug: 'company', name: 'Company' });
    await attacker.api.entity_schema.createRelType({ slug: 'related', name: 'Related' });
    const from = (await attacker.api.entities.create({
      type: 'company',
      name: 'From',
    })) as { entity: { id: number } };
    const to = (await attacker.api.entities.create({
      type: 'company',
      name: 'To',
    })) as { entity: { id: number } };
    const borrowedTo = (await attacker.api.entities.create({
      type: 'company',
      name: 'Borrowed To',
    })) as { entity: { id: number } };

    await attacker.api.entities.manage({
      action: 'link',
      from_entity_id: from.entity.id,
      to_entity_id: to.entity.id,
      relationship_type_slug: 'related',
      automation_source: {
        automation_id: attacker.automationId,
        run_id: attacker.runId,
      },
    });

    await attacker.api.entities.manage({
      action: 'link',
      from_entity_id: from.entity.id,
      to_entity_id: borrowedTo.entity.id,
      relationship_type_slug: 'related',
      automation_source: {
        automation_id: victim.automationId,
        run_id: victim.runId,
      },
    });

    await expect(reactionRows(attacker.organizationId)).resolves.toEqual([
      { automation_id: attacker.automationId, run_id: attacker.runId },
    ]);
    await expect(reactionRows(victim.organizationId)).resolves.toEqual([]);
  });
});
