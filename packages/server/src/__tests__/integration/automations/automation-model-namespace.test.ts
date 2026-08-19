/**
 * `execution_config.model` is ONE stored field with TWO resolution namespaces
 * (see the comment on `getAutomationModelOverride`): a device-pinned Automation
 * hands the ref verbatim to a local CLI as `--model`, while a server-dispatched
 * one resolves it against the org's `inference_providers`. Nothing checked which
 * lane a ref belonged to, so both directions failed silently at run time. In
 * prod on 2026-08-19 both happened within eight minutes:
 *
 *   15:01  #71 (device)  opencode: ProviderModelNotFoundError deepseek/deepseek-v4-flash
 *   15:09  #5  (server)  OpenRouter 400: opencode-go/deepseek-v4-flash is not a valid model ID
 *
 * The server can only police the lane whose registry it holds. A provider-
 * qualified ref on the SERVER lane must name a live `inference_providers.slug`;
 * the device lane is left alone because the CLI's provider registry lives on
 * the user's machine and the server cannot see it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestAgent,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

describe('execution_config.model namespace guard', () => {
  let owner: TestApiClient;
  let orgId: string;
  let agentId: string;
  let deviceWorkerId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Model Namespace Org' });
    const user = await createTestUser({ email: 'model-namespace@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    orgId = org.id;
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
    const agent = await createTestAgent({
      organizationId: org.id,
      ownerUserId: user.id,
    });
    agentId = agent.agentId;

    const sql = getTestDb();
    // One live provider, exactly as an org that has registered `deepseek` would.
    await sql`
      INSERT INTO inference_providers (organization_id, slug, kind, display_name,
        api_key_ref, capabilities, status)
      VALUES (${orgId}, 'deepseek', 'openai-compatible', 'DeepSeek',
        'secret://test', ${sql.json({ text: { model: 'deepseek-v4-flash' } })}, 'active')
    `;
    const [device] = (await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, app_version,
        capabilities, label, organization_id, connector_manifests)
      VALUES (${user.id}, 'mac-model-namespace', 'macos', '15.0.0',
        ${sql.json({})}, 'Test Mac', ${orgId}, ${sql.json({})})
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    deviceWorkerId = device.id;
  });

  it('rejects a CLI-namespace model on a server-dispatched Automation', async () => {
    await expect(
      owner.automations.create({
        slug: 'server-lane-bad-model',
        name: 'Server Lane Bad Model',
        prompt: 'Do a thing.',
        triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
        agent_id: agentId,
        execution_config: { model: 'opencode-go/deepseek-v4-flash' },
      })
    ).rejects.toThrow(/opencode-go/);
  });

  it('still rejects on the server lane when agent_kind is set without a device pin', async () => {
    // agent_kind alone selects a local CLI runtime on the DEVICE lane and is
    // otherwise inert; it must not be read as a device pin that exempts the
    // server lane from the model guard.
    await expect(
      owner.automations.create({
        slug: 'server-lane-agent-kind-only',
        name: 'Server Lane Agent Kind Only',
        prompt: 'Do a thing.',
        triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
        agent_id: agentId,
        agent_kind: 'opencode',
        execution_config: { model: 'opencode-go/deepseek-v4-flash' },
      })
    ).rejects.toThrow(/opencode-go/);
  });

  it('accepts a model naming a registered provider', async () => {
    const created = (await owner.automations.create({
      slug: 'server-lane-good-model',
      name: 'Server Lane Good Model',
      prompt: 'Do a thing.',
      triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
      agent_id: agentId,
      execution_config: { model: 'deepseek/deepseek-v4-flash' },
    })) as { automation_id: string };
    expect(created.automation_id).toBeDefined();
  });

  it('leaves a device-pinned Automation alone — its CLI registry is off-server', async () => {
    const created = (await owner.automations.create({
      slug: 'device-lane-cli-model',
      name: 'Device Lane CLI Model',
      prompt: 'Do a thing.',
      triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
      agent_id: agentId,
      agent_kind: 'opencode',
      device_worker_id: deviceWorkerId,
      execution_config: { model: 'opencode-go/deepseek-v4-flash' },
    })) as { automation_id: string };
    expect(created.automation_id).toBeDefined();
  });

  it("does not second-guess 'auto' or a bare model id", async () => {
    for (const [index, model] of ['auto', 'deepseek-v4-flash'].entries()) {
      const created = (await owner.automations.create({
        slug: `server-lane-unqualified-${index}`,
        name: `Server Lane Unqualified ${index}`,
        prompt: 'Do a thing.',
        triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
        agent_id: agentId,
        execution_config: { model },
      })) as { automation_id: string };
      expect(created.automation_id).toBeDefined();
    }
  });

  it('rejects the same bad ref arriving through update', async () => {
    const created = (await owner.automations.create({
      slug: 'server-lane-update-target',
      name: 'Server Lane Update Target',
      prompt: 'Do a thing.',
      triggers: [{ kind: 'schedule', cron: '0 * * * *' }],
      agent_id: agentId,
    })) as { automation_id: string };

    await expect(
      owner.automations.update({
        automation_id: created.automation_id,
        execution_config: { model: 'opencode-go/deepseek-v4-flash' },
      })
    ).rejects.toThrow(/opencode-go/);
  });
});
