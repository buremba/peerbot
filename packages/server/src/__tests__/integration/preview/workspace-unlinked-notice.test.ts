/**
 * `workspaceUnlinkedNotice` — the reply a tenant's own OAuth-installed Slack bot
 * sends in a channel that isn't bound to an agent yet. It must be actionable:
 * list the org's agents, deep-link each to its Behaviors page (where a channel
 * is added as a Listen source), and give the CLI `/lobu link` path. It must
 * degrade gracefully when the public origin isn't configured or the org has no
 * agents, and never turn into a dead drop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceUnlinkedNotice } from '../../../preview/slack';
import { __resetPublicOriginCachesForTests } from '../../../utils/public-origin';
import { cleanupTestDatabase } from '../../setup/test-db';
import { createTestAgent, createTestOrganization } from '../../setup/test-fixtures';

const ORIGIN_ENV = 'PUBLIC_GATEWAY_URL';

// getConfiguredPublicOrigin() memoizes PUBLIC_GATEWAY_URL on first read, so every
// case that changes the env must reset the cache to be observed.
function setOrigin(value: string | undefined) {
  if (value === undefined) delete process.env[ORIGIN_ENV];
  else process.env[ORIGIN_ENV] = value;
  __resetPublicOriginCachesForTests();
}

describe('workspaceUnlinkedNotice', () => {
  let savedOrigin: string | undefined;

  beforeEach(async () => {
    await cleanupTestDatabase();
    savedOrigin = process.env[ORIGIN_ENV];
  });

  afterEach(() => {
    setOrigin(savedOrigin);
  });

  it('returns null for non-slack platforms', async () => {
    const org = await createTestOrganization();
    expect(await workspaceUnlinkedNotice('telegram', org.id)).toBeNull();
  });

  it('lists agents and deep-links each Behaviors page when the public origin is set', async () => {
    setOrigin('https://app.lobu.ai/lobu');
    const org = await createTestOrganization({ slug: 'acme' });
    await createTestAgent({ organizationId: org.id, agentId: 'planner', name: 'Planner' });
    await createTestAgent({ organizationId: org.id, agentId: 'builder', name: 'Builder' });

    const notice = await workspaceUnlinkedNotice('slack', org.id);
    expect(notice).not.toBeNull();
    const text = notice as string;

    // getConfiguredPublicOrigin() returns the URL *origin* (scheme+host), so the
    // /lobu gateway mount is dropped — the SPA lives at the bare origin. We build
    // `${origin}/${slug}/agents/${id}/behaviors`.
    expect(text).toContain('https://app.lobu.ai/acme/agents/planner/behaviors');
    expect(text).toContain('https://app.lobu.ai/acme/agents/builder/behaviors');
    expect(text).toContain('Planner');
    expect(text).toContain('Builder');
    // The CLI path is always offered too.
    expect(text).toContain('lobu run');
    expect(text).toContain('/lobu link');
  });

  it('lists agents by name (no URLs) when the public origin is not configured', async () => {
    setOrigin(undefined);
    const org = await createTestOrganization({ slug: 'acme' });
    await createTestAgent({ organizationId: org.id, agentId: 'planner', name: 'Planner' });

    const text = (await workspaceUnlinkedNotice('slack', org.id)) as string;
    expect(text).toContain('Planner');
    expect(text).not.toContain('/agents/planner/behaviors');
    expect(text).toContain('lobu run'); // CLI path still present
  });

  it('falls back to the CLI-only notice when the org has no agents', async () => {
    setOrigin('https://app.lobu.ai');
    const org = await createTestOrganization();

    const text = (await workspaceUnlinkedNotice('slack', org.id)) as string;
    expect(text).toContain('lobu run');
    expect(text).toContain('/lobu link');
    // No agent-list section.
    expect(text).not.toContain('Behaviors page');
  });

  it('never throws / dead-drops for an unknown org (returns the CLI-only notice)', async () => {
    setOrigin('https://app.lobu.ai');
    const text = (await workspaceUnlinkedNotice('slack', 'org_does_not_exist')) as string;
    expect(text).not.toBeNull();
    expect(text).toContain('/lobu link');
  });
});
