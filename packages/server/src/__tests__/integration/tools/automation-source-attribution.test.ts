/**
 * A caller-declared `automation_source` must not be trusted for provenance.
 *
 * `automation_source` is tool input, so an org member can name any id. Audit
 * rows stamp `events.automation_id` from it, so an unverified id does two
 * kinds of damage: it misattributes the row — and lets it inherit that
 * Automation's causal chain, which is what bounds a cascade — and, because the
 * column carries a foreign key while audit writes are fire-and-forget, a
 * nonexistent id fails the INSERT and DROPS the audit row with no caller-
 * visible error.
 *
 * `notify.ts` already validates this field against the caller's org before
 * anchoring a canvas; this is the same rule on the attribution path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  resolveAutomationAttribution,
  verifiedAutomationSource,
} from '../../../automations/automation-source';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent } from '../../setup/test-fixtures';
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
  return {
    organizationId: workspace.org.id,
    automationId: Number(created.automation_id),
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
        { automationId: org.automationId, windowId: 7 },
        org.organizationId
      )
    ).resolves.toEqual({ automationId: org.automationId, windowId: 7 });
  });

  it('rejects an Automation belonging to another organization', async () => {
    const victim = await orgWithAutomation('Victim Org', 'victim');
    const attacker = await orgWithAutomation('Attacker Org', 'attacker');
    // The id exists, so the foreign key would happily accept it — only the org
    // check stops the attacker attributing its writes to another org's chain.
    await expect(
      verifiedAutomationSource(
        { automationId: victim.automationId, windowId: 1 },
        attacker.organizationId
      )
    ).resolves.toBeNull();
  });

  it('rejects an id that does not exist at all', async () => {
    const org = await orgWithAutomation('Ghost Org', 'ghost');
    // Unverified, this is the id that would fail the FK and silently drop the
    // audit row.
    await expect(
      verifiedAutomationSource(
        { automationId: 2147483000, windowId: 1 },
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
});

describe('resolveAutomationAttribution precedence', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('lets the trusted session identity win, WINDOW INCLUDED', async () => {
    const org = await orgWithAutomation('Session Org', 'session');
    const other = await orgWithAutomation('Other Org', 'other');
    // Every call site's comment claimed the session automation wins, but each
    // one still took the declared WINDOW when the session's was null-ish — the
    // exact retag this precedence exists to stop. The session pair is atomic.
    await expect(
      resolveAutomationAttribution(
        {
          organizationId: org.organizationId,
          actingAutomationId: org.automationId,
          actingWindowId: 42,
        },
        { automation_id: other.automationId, window_id: 99 }
      )
    ).resolves.toEqual({ automationId: org.automationId, windowId: 42 });
  });

  it('gives a windowless session NO window, rather than the declared one', async () => {
    const org = await orgWithAutomation('Windowless Session', 'w-session');
    const other = await orgWithAutomation('Window Donor', 'w-donor');
    // The case the previous assertion missed: with a session window present,
    // `actingWindowId ?? declared.window_id` yields the session's either way. A
    // session carrying an automation but NO window is the only shape that tells
    // the two apart — and it is reachable, since the agent and device lanes set
    // `actingAutomationId` from the auth context with `actingWindowId` null.
    await expect(
      resolveAutomationAttribution(
        {
          organizationId: org.organizationId,
          actingAutomationId: org.automationId,
          actingWindowId: null,
        },
        { automation_id: other.automationId, window_id: 99 }
      )
    ).resolves.toEqual({ automationId: org.automationId, windowId: null });
  });

  it('honors a declared source the organization owns when off-session', async () => {
    const org = await orgWithAutomation('Declared Org', 'declared');
    await expect(
      resolveAutomationAttribution(
        { organizationId: org.organizationId },
        { automation_id: org.automationId, window_id: 5 }
      )
    ).resolves.toEqual({ automationId: org.automationId, windowId: 5 });
  });

  it('yields NO attribution for a foreign declared source', async () => {
    const victim = await orgWithAutomation('Foreign Victim', 'f-victim');
    const attacker = await orgWithAutomation('Foreign Attacker', 'f-attacker');
    await expect(
      resolveAutomationAttribution(
        { organizationId: attacker.organizationId },
        { automation_id: victim.automationId, window_id: 5 }
      )
    ).resolves.toEqual({ automationId: null, windowId: null });
  });

  it('drops the WINDOW too when the Automation fails verification', async () => {
    const org = await orgWithAutomation('Half Org', 'half');
    // A window without its Automation names an approval batch nothing owns, so
    // a half-applied attribution is worse than none.
    await expect(
      resolveAutomationAttribution(
        { organizationId: org.organizationId },
        { automation_id: 2147483000, window_id: 5 }
      )
    ).resolves.toEqual({ automationId: null, windowId: null });
  });

  it('attributes a windowless declaration to the Automation alone', async () => {
    const org = await orgWithAutomation('Windowless Org', 'windowless');
    await expect(
      resolveAutomationAttribution(
        { organizationId: org.organizationId },
        { automation_id: org.automationId }
      )
    ).resolves.toEqual({ automationId: org.automationId, windowId: null });
  });

  it('returns nothing when the caller declared nothing and holds no session', async () => {
    const org = await orgWithAutomation('Bare Org', 'bare');
    await expect(
      resolveAutomationAttribution({ organizationId: org.organizationId }, undefined)
    ).resolves.toEqual({ automationId: null, windowId: null });
  });
});
