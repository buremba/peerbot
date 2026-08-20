/**
 * A caller-declared `automation_source` must not be trusted for provenance.
 *
 * `automation_source` is tool input, so an org member can name any pair of ids.
 * Audit rows stamp `events.automation_id` from it, so an unverified id does two
 * kinds of damage: it misattributes the row — and lets it inherit that
 * Automation's causal chain, which is what bounds a cascade — and, because the
 * column carries a foreign key while audit writes are fire-and-forget, a
 * nonexistent id fails the INSERT and DROPS the audit row with no caller-
 * visible error. The run is the third: paired with someone else's `run_id`,
 * an otherwise-legitimate proposal lands in that Automation's
 * approval card.
 *
 * `notify.ts` already validates the pair against the caller's org; this is the
 * same rule on the attribution path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAutomationAttribution,
  verifiedAutomationSource,
} from '../../../automations/automation-source';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createAutomationResultRun, createTestAgent } from '../../setup/test-fixtures';
import { TestApiClient, TestWorkspace } from '../../setup/test-mcp-client';

async function orgWithAutomation(name: string, slug: string) {
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
    agentId: agent.agentId,
    organizationId: workspace.org.id,
    automationId,
    runId,
  };
}

describe('declared automation_source verification', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('accepts an Automation the caller organization owns', async () => {
    const org = await orgWithAutomation('Owner Org', 'owned');
    await expect(
      verifiedAutomationSource(
        { automationId: org.automationId, runId: org.runId },
        org.organizationId
      )
    ).resolves.toEqual({ automationId: org.automationId, runId: org.runId });
  });

  it('rejects an Automation belonging to another organization', async () => {
    const victim = await orgWithAutomation('Victim Org', 'victim');
    const attacker = await orgWithAutomation('Attacker Org', 'attacker');
    await expect(
      verifiedAutomationSource(
        { automationId: victim.automationId, runId: victim.runId },
        attacker.organizationId
      )
    ).resolves.toBeNull();
  });

  it('rejects an id that does not exist at all', async () => {
    const org = await orgWithAutomation('Ghost Org', 'ghost');
    await expect(
      verifiedAutomationSource(
        { automationId: 2147483000, runId: org.runId },
        org.organizationId
      )
    ).resolves.toBeNull();
  });

  it('passes through an absent declaration untouched', async () => {
    const org = await orgWithAutomation('Empty Org', 'empty');
    await expect(
      verifiedAutomationSource(null, org.organizationId)
    ).resolves.toBeNull();
  });

  it('rejects a run belonging to another Automation in the same organization', async () => {
    const org = await orgWithAutomation('Pair Org', 'pair');
    const created = (await org.api.automations.create({
      slug: 'pair-other',
      prompt: 'Anything.',
      agent_id: org.agentId,
    })) as { automation_id: string };
    const otherRunId = await createAutomationResultRun({
      automationId: Number(created.automation_id),
      organizationId: org.organizationId,
      windowStart: '2026-01-08T00:00:00.000Z',
      windowEnd: '2026-01-15T00:00:00.000Z',
    });

    await expect(
      verifiedAutomationSource(
        { automationId: org.automationId, runId: otherRunId },
        org.organizationId
      )
    ).resolves.toBeNull();
  });
});

describe('resolveAutomationAttribution precedence', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets the trusted session identity win, including its run', async () => {
    const org = await orgWithAutomation('Session Org', 'session');
    const other = await orgWithAutomation('Other Org', 'other');
    await expect(
      resolveAutomationAttribution(
        {
          organizationId: org.organizationId,
          actingAutomationId: org.automationId,
          actingRunId: org.runId,
        },
        { automation_id: other.automationId, run_id: other.runId }
      )
    ).resolves.toEqual({ automationId: org.automationId, runId: org.runId });
  });

  it('gives a runless session no run rather than the declared one', async () => {
    const org = await orgWithAutomation('Windowless Session', 'w-session');
    const other = await orgWithAutomation('Window Donor', 'w-donor');
    await expect(
      resolveAutomationAttribution(
        {
          organizationId: org.organizationId,
          actingAutomationId: org.automationId,
          actingRunId: null,
        },
        { automation_id: other.automationId, run_id: other.runId }
      )
    ).resolves.toEqual({ automationId: org.automationId, runId: null });
  });

  it('honors a declared source the organization owns when off-session', async () => {
    const org = await orgWithAutomation('Declared Org', 'declared');
    await expect(
      resolveAutomationAttribution(
        { organizationId: org.organizationId },
        { automation_id: org.automationId, run_id: org.runId }
      )
    ).resolves.toEqual({ automationId: org.automationId, runId: org.runId });
  });

  it('yields no attribution for a foreign declared source', async () => {
    const victim = await orgWithAutomation('Foreign Victim', 'f-victim');
    const attacker = await orgWithAutomation('Foreign Attacker', 'f-attacker');
    await expect(
      resolveAutomationAttribution(
        { organizationId: attacker.organizationId },
        { automation_id: victim.automationId, run_id: victim.runId }
      )
    ).resolves.toEqual({ automationId: null, runId: null });
  });

  it('drops the run too when the Automation fails verification', async () => {
    const org = await orgWithAutomation('Half Org', 'half');
    await expect(
      resolveAutomationAttribution(
        { organizationId: org.organizationId },
        { automation_id: 2147483000, run_id: org.runId }
      )
    ).resolves.toEqual({ automationId: null, runId: null });
  });

  it('returns nothing when the caller declared nothing and holds no session', async () => {
    const org = await orgWithAutomation('Bare Org', 'bare');
    await expect(
      resolveAutomationAttribution({ organizationId: org.organizationId }, undefined)
    ).resolves.toEqual({ automationId: null, runId: null });
  });
});
