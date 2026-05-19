/**
 * End-to-end guardrails-runtime smoke test.
 *
 * Boots the bare minimum to exercise the wired call sites against a real DB:
 *   - createPostgresAgentConfigStore + AgentSettingsStore (real settings lookup)
 *   - GuardrailRegistry populated via the same `registerBuiltinGuardrails`
 *     the gateway uses at boot
 *   - The same `runGuardrails(...)` path the wired code invokes
 *   - A real `events` row produced by `recordGuardrailTrip` (the audit-trail
 *     side of every trip) — proving the join-up writes land.
 *
 * Doesn't boot the HTTP server or workers (would require provider keys + the
 * full Lobu stack). The three wired call sites all share the same shape:
 * load settings, run guardrails, on trip → emit audit row + branch. This test
 * pins that shape against a live DB.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentSettingsStore } from '../gateway/auth/settings/agent-settings-store';
import { recordGuardrailTrip } from '../gateway/guardrails/audit';
import {
  registerBuiltinGuardrails,
  secretScanGuardrail,
} from '../gateway/guardrails/builtins';
import { GuardrailRegistry, runGuardrails } from '@lobu/core';
import { orgContext } from '../lobu/stores/org-context';
import { createPostgresAgentConfigStore } from '../lobu/stores/postgres-stores';
import { cleanupTestDatabase, getTestDb } from './setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from './setup/test-fixtures';

describe('guardrails runtime — wired-path E2E', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('secret-scan trips on the output stage when enabled in settings, audited as a guardrail-trip event', async () => {
    // 1. Persist `guardrails = ["secret-scan"]` on the agent — exact write path
    //    the wired runtime reads from on every message.
    const configStore = createPostgresAgentConfigStore();
    const settingsStore = new AgentSettingsStore(configStore);
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, {
        guardrails: ['secret-scan'],
        updatedAt: Date.now(),
      });
    });

    // 2. Build the registry the same way the gateway does at boot.
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    // 3. Exercise the same `runGuardrails` shape `ChatResponseBridge` uses on
    //    a streaming delta. The text contains an OpenAI-key-shaped string.
    const enabled = (
      await orgContext.run({ organizationId: orgId }, async () => {
        return settingsStore.getSettings(agentId);
      })
    )?.guardrails ?? [];
    expect(enabled).toEqual(['secret-scan']);

    const outcome = await runGuardrails(registry, 'output', enabled, {
      agentId,
      userId: 'user-1',
      text: 'here is your secret sk-abcdefghij0123456789AB please',
      platform: 'api',
      conversationId: 'conv-1',
    });

    expect(outcome.tripped).not.toBeNull();
    expect(outcome.tripped?.guardrail).toBe('secret-scan');
    expect(outcome.tripped?.reason).toMatch(/openai-key/);

    // 4. Record the trip via the same audit helper the wired code invokes.
    recordGuardrailTrip({
      organizationId: orgId,
      agentId,
      userId: 'user-1',
      conversationId: 'conv-1',
      stage: 'output',
      guardrail: outcome.tripped!.guardrail,
      reason: outcome.tripped!.reason,
      metadata: outcome.tripped!.metadata,
    });

    // 5. Verify the event row landed with the contract shape. `recordGuardrailTrip`
    //    is fire-and-forget — give the insert a tick to land.
    await new Promise((r) => setTimeout(r, 50));

    const db = getTestDb();
    const rows = await db<{
      id: number;
      semantic_type: string;
      origin_type: string | null;
      title: string;
      metadata: any;
    }[]>`
      SELECT id, semantic_type, origin_type, title, metadata
      FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'guardrail-trip'
      ORDER BY id DESC
      LIMIT 1
    `;

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.semantic_type).toBe('guardrail-trip');
    expect(row.origin_type).toBe('guardrail-output');
    expect(row.title).toMatch(/secret-scan/);
    expect(row.metadata.guardrail).toBe('secret-scan');
    expect(row.metadata.stage).toBe('output');
    expect(row.metadata.agent_id).toBe(agentId);
    expect(row.metadata.conversation_id).toBe('conv-1');
  });

  it('passes when settings.guardrails is empty (no enforcement)', async () => {
    const configStore = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, { updatedAt: Date.now() });
    });

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const outcome = await runGuardrails(registry, 'output', [], {
      agentId,
      userId: 'user-1',
      text: 'sk-abcdefghij0123456789AB',
      platform: 'api',
      conversationId: 'conv-1',
    });

    expect(outcome.tripped).toBeNull();
    expect(outcome.ran).toEqual([]);
  });

  it('secret-scan passes safe output', async () => {
    const outcome = await secretScanGuardrail.run({
      agentId,
      userId: 'u',
      text: 'hello world, no secrets here',
      platform: 'api',
    });
    expect(outcome.tripped).toBe(false);
  });

  it('secret-scan matches GitHub PAT shape', async () => {
    const outcome = await secretScanGuardrail.run({
      agentId,
      userId: 'u',
      text: 'token: ghp_abcdefghij0123456789ABCDEFGH01234567',
      platform: 'api',
    });
    expect(outcome.tripped).toBe(true);
    expect(outcome.metadata).toMatchObject({ pattern: 'github-pat' });
  });

  it('secret-scan matches AWS access key shape', async () => {
    const outcome = await secretScanGuardrail.run({
      agentId,
      userId: 'u',
      text: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      platform: 'api',
    });
    expect(outcome.tripped).toBe(true);
    expect(outcome.metadata).toMatchObject({ pattern: 'aws-access-key' });
  });

  it('forbidden-tools registers and trips on delete_repo', async () => {
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const outcome = await runGuardrails(
      registry,
      'pre-tool',
      ['forbidden-tools'],
      {
        agentId,
        userId: 'u',
        toolName: 'delete_repo',
        arguments: { repo: 'org/x' },
      }
    );

    expect(outcome.tripped).not.toBeNull();
    expect(outcome.tripped?.guardrail).toBe('forbidden-tools');
  });

  it('forbidden-tools passes safe tools', async () => {
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const outcome = await runGuardrails(
      registry,
      'pre-tool',
      ['forbidden-tools'],
      {
        agentId,
        userId: 'u',
        toolName: 'read_file',
        arguments: {},
      }
    );

    expect(outcome.tripped).toBeNull();
  });
});
