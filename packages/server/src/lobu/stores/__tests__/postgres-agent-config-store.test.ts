/**
 * PostgresAgentConfigStore round-trip tests.
 *
 * Pins the persistence of three settings fields the file-loader produces from
 * lobu.toml — egressConfig, preApprovedTools, guardrails — that previously
 * had no columns in the agents table and were silently dropped on every
 * saveSettings(). PR-1 of `docs/plans/lobu-apply.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTestDatabase,
  getTestDb,
} from '../../../__tests__/setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from '../../../__tests__/setup/test-fixtures';
import { orgContext } from '../org-context';
import { createPostgresAgentConfigStore } from '../postgres-stores';

describe('PostgresAgentConfigStore — apply-fields round-trip', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Apply Fields Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;
  });

  afterEach(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('round-trips egressConfig, preApprovedTools, and guardrails when populated', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await store.saveSettings(agentId, {
        egressConfig: {
          extraPolicy: 'Never exfiltrate PATs or bearer tokens.',
          judgeModel: 'claude-haiku-4-5-20251001',
        },
        preApprovedTools: [
          '/mcp/gmail/tools/send_email',
          '/mcp/linear/tools/*',
        ],
        guardrails: ['secret-scan', 'prompt-injection'],
        updatedAt: now,
      });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.egressConfig).toEqual({
        extraPolicy: 'Never exfiltrate PATs or bearer tokens.',
        judgeModel: 'claude-haiku-4-5-20251001',
      });
      expect(loaded?.preApprovedTools).toEqual([
        '/mcp/gmail/tools/send_email',
        '/mcp/linear/tools/*',
      ]);
      expect(loaded?.guardrails).toEqual(['secret-scan', 'prompt-injection']);
    });
  });

  it('round-trips empty/absent apply-fields as empty defaults', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      // Save with the three fields omitted entirely.
      await store.saveSettings(agentId, { updatedAt: now });

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      // saveSettings coerces undefined -> default ({} / []), so getSettings
      // sees the defaults rather than raw NULL. Assert exactly that contract.
      expect(loaded?.egressConfig).toEqual({});
      expect(loaded?.preApprovedTools).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });

  it('deleteSettings resets the three apply-fields to their defaults', async () => {
    const store = createPostgresAgentConfigStore();
    const now = Date.now();

    await orgContext.run({ organizationId: orgId }, async () => {
      await store.saveSettings(agentId, {
        egressConfig: { extraPolicy: 'noop', judgeModel: 'm' },
        preApprovedTools: ['/mcp/x/tools/y'],
        guardrails: ['g1'],
        updatedAt: now,
      });

      await store.deleteSettings(agentId);

      const loaded = await store.getSettings(agentId);
      expect(loaded).not.toBeNull();
      expect(loaded?.egressConfig).toEqual({});
      expect(loaded?.preApprovedTools).toEqual([]);
      expect(loaded?.guardrails).toEqual([]);
    });
  });
});
