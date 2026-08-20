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
 * the Automation credited for the write, or no row appears at all.
 *
 * Only the cross-org case is asserted here. A NONEXISTENT id is invisible at
 * this surface: the composite foreign key already rejected the insert and the
 * call site swallows the error, so the row count was zero before this change
 * too. Asserting it here would pass either way — `automation-source-attribution`
 * covers that case where the difference is actually observable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function orgWithAutomationAndWindow(name: string, slug: string) {
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
  return {
    api,
    organizationId: workspace.org.id,
    automationId: Number(created.automation_id),
  };
}

async function reactionRows(organizationId: string) {
  return getTestDb()<{ automation_id: number; window_id: number }>`
    SELECT automation_id, window_id
    FROM automation_reactions
    WHERE organization_id = ${organizationId}
  `;
}

describe('write surfaces refuse an unowned automation_source', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('credits nobody when save_memory declares another org’s Automation', async () => {
    const victim = await orgWithAutomationAndWindow('Surface Victim', 's-victim');
    const attacker = await orgWithAutomationAndWindow('Surface Attacker', 's-attacker');

    // Deliberately the SDK namespace, not `executeTool`: `client.knowledge.save`
    // calls the handler directly, so the dispatch-level verification added in
    // #2952 never runs on this path. The surface has to hold on its own.
    await attacker.api.knowledge.save({
      semantic_type: 'note',
      metadata: {},
      title: 'Borrowed credit',
      content: 'Attributed to an Automation this org does not own.',
      automation_source: { automation_id: victim.automationId, window_id: 1 },
    });

    // The write itself is fine — attribution is a hint, not a permission — but
    // it must land on nobody rather than on the victim's feedback record.
    await expect(reactionRows(attacker.organizationId)).resolves.toEqual([]);
    await expect(reactionRows(victim.organizationId)).resolves.toEqual([]);
  });

});
