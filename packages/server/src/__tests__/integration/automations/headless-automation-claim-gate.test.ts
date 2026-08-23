/**
 * Rolling-deploy-safe claim gate for the Automation lane in /api/workers/poll.
 *
 * A daemon build that predates the automation lane mishandles a
 * `run_type='automation'` run — it falls through to the sync path, which
 * finalizes the run row without the Automation-side bookkeeping and wedges the
 * schedule. Nothing stopped such a device from claiming one. The fix: the poll
 * automation lane only matches devices advertising `automations.execute`, which
 * the daemon adds itself on the headless platform (so it is a build signal, not
 * an operator flag) — with the macOS arm preserving the pre-capability
 * exemption for Owletto's bridge, which advertises a fixed capability set with
 * no such string.
 *
 * These tests drive the real poll endpoint with a device-pinned automation:
 *   - headless device WITHOUT automations.execute → no claim (run stays pending)
 *   - headless device WITH automations.execute → claims + payload envelope
 *   - headless automation with no assigned agent → claims, no run-scoped session
 *   - macOS device with capabilities:{} → still claims (exemption)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { verifyWorkerToken } from '@lobu/core';
import type { DbClient } from '../../../db/client';
import { generateSecureToken, hashToken } from '../../../auth/oauth/utils';
import { resolvePublicOrigin } from '../../../utils/public-origin';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { mcpToolsCall, post } from '../../setup/test-helpers';
import { TestWorkspace } from '../../setup/test-mcp-client';

async function createWorkerBoundPat(
  userId: string,
  organizationId: string,
  workerId: string,
  scope = 'device_worker:run'
): Promise<{ token: string }> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 12);
  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${tokenHash}, ${tokenPrefix}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, ${scope}, ${workerId},
      NOW(), NOW()
    )
  `;
  return { token };
}

async function setupDevicePinnedAutomation(opts: {
  workerId: string;
  platform: string;
  capabilities: Record<string, boolean>;
  entityType?: string;
  entityMetadata?: Record<string, unknown>;
}): Promise<{
  sql: ReturnType<typeof getTestDb>;
  dbClient: DbClient;
  workspace: Awaited<ReturnType<typeof TestWorkspace.create>>;
  automationId: number;
  deviceWorkerId: string;
  entityId: number;
  agentId: string;
}> {
  const sql = getTestDb();
  const dbClient = sql as unknown as DbClient;
  const workspace = await TestWorkspace.create({ name: 'Headless Claim Gate Org' });
  const ownerUserId = workspace.users.owner.id;

  const inserted = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
    VALUES (${ownerUserId}, ${opts.workerId}, ${opts.platform}, ${sql.json(opts.capabilities)}, 'Device', ${workspace.org.id})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const deviceWorkerId = String(inserted[0].id);

  const entity = await createTestEntity({
    name: 'Claim Gate Entity',
    entity_type: opts.entityType,
    organization_id: workspace.org.id,
    created_by: ownerUserId,
  });
  if (opts.entityMetadata) {
    await sql`
      UPDATE entities
      SET metadata = ${sql.json(opts.entityMetadata)}
      WHERE id = ${entity.id}
    `;
  }
  const agent = await createTestAgent({
    organizationId: workspace.org.id,
    ownerUserId,
    agentId: 'claim-gate-agent',
    name: 'Claim Gate Agent',
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: 'claim-gate-automation',
    name: 'Claim Gate Automation',
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  await sql`
    UPDATE automations
    SET device_worker_id = ${deviceWorkerId}::uuid,
        agent_kind = 'opencode'
    WHERE id = ${automationId}
  `;

  return {
    sql,
    dbClient,
    workspace,
    automationId,
    deviceWorkerId,
    entityId: entity.id,
    agentId: agent.agentId,
  };
}

async function createPinnedAutomationForEntity(
  ctx: Awaited<ReturnType<typeof setupDevicePinnedAutomation>>,
  entityId: number,
  slug: string
): Promise<number> {
  const created = (await ctx.workspace.owner.automations.create({
    entity_id: entityId,
    slug,
    name: slug,
    prompt: 'Work only on the attached engineering task.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: ctx.agentId,
  })) as { automation_id: string };
  const automationId = Number(created.automation_id);
  await ctx.sql`
    UPDATE automations
    SET device_worker_id = ${ctx.deviceWorkerId}::uuid,
        agent_kind = 'opencode'
    WHERE id = ${automationId}
  `;
  return automationId;
}

function isolatedPollBody(workerId: string) {
  return {
    worker_id: workerId,
    capabilities: {
      'os.shell': true,
      'automations.execute': true,
      'automations.workspace.v1': true,
    },
    agent_kinds: ['opencode'],
  };
}

describe('headless Automation claim gate (automations.execute)', () => {
  // The dispatch path MINTS a worker token, which encrypts. Own the key here
  // rather than inheriting it: a fork that starts without one would otherwise
  // exercise the mint-failure fallback and silently stop asserting the session.
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });

  afterAll(() => {
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  // First test in the file pays the on-demand connector-catalog compile on the
  // trigger path; give it room so the claim gate itself (not cold-start time)
  // decides the outcome.
  it('headless device WITHOUT automations.execute does not claim — run stays pending', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'headless-legacy',
      platform: 'headless',
      capabilities: { 'os.shell': true },
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'headless-legacy'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);
    const { run_id } = (await trig.json()) as { run_id: number };

    // An old daemon (no automations.execute) must NOT be handed the automation
    // run — it would refuse to execute and wedge it.
    const pollRes = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'headless-legacy', capabilities: { 'os.shell': true } },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as { run_id?: number; run_type?: string };
    expect(job.run_id).toBeUndefined();

    const [run] = await ctx.sql`
      SELECT status FROM runs WHERE id = ${run_id}
    `;
    expect(String(run.status)).toBe('pending');
  }, 60_000);

  it('headless device WITH automations.execute claims the run and gets the payload envelope', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'headless-herdr',
      platform: 'headless',
      capabilities: { 'os.shell': true, 'automations.execute': true },
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'headless-herdr'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'headless-herdr',
        capabilities: { 'os.shell': true, 'automations.execute': true },
      },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_id?: number;
      run_type?: string;
      organization_id?: string;
      payload?: {
        automation?: { agent_kind?: string; execution_config?: Record<string, unknown>; prompt?: string };
        context?: { agent_session?: { conversation_id: string; mcp_url: string; token: string; expires_at: number } };
      };
    };
    expect(job.run_type).toBe('automation');
    expect(job.run_id).toBeGreaterThan(0);
    expect(job.organization_id).toBe(ctx.workspace.org.id);
    expect(job.payload?.automation?.agent_kind).toBe('opencode');
    expect(job.payload?.automation?.prompt).toContain('client.automations.completeWindow');
    const agentSession = job.payload?.context?.agent_session;
    expect(agentSession?.conversation_id).toBe(
      `claim-gate-agent_automation_${ctx.automationId}_run_${job.run_id}`
    );
    expect(agentSession?.mcp_url).toBe(
      `${resolvePublicOrigin('http://localhost/api/workers/poll')}/mcp/${encodeURIComponent(ctx.workspace.org.slug)}`
    );
    expect(typeof agentSession?.expires_at).toBe('number');
    expect(agentSession!.expires_at).toBeGreaterThan(Date.now());
    const claims = verifyWorkerToken(agentSession!.token);
    expect(claims).not.toBeNull();
    if (!claims) throw new Error('minted automation worker token did not verify');
    expect(claims.agentId).toBe('claim-gate-agent');
    expect(claims.organizationId).toBe(ctx.workspace.org.id);
    expect(claims.conversationId).toBe(agentSession!.conversation_id);

    const [run] = await ctx.sql`
      SELECT status FROM runs WHERE id = ${job.run_id}
    `;
    expect(String(run.status)).toBe('running');
  });

  it('withholds engineering tasks until the daemon advertises isolated workspaces', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'headless-task-worker',
      platform: 'headless',
      capabilities: {
        'os.shell': true,
        'automations.execute': true,
        'automations.workspace.v1': true,
      },
      entityType: 'engineering-task',
      entityMetadata: { repository: 'lobu-ai/lobu', status: 'open' },
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'headless-task-worker'
    );
    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    const { run_id } = (await trig.json()) as { run_id: number };

    const legacyPoll = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'headless-task-worker',
        capabilities: { 'os.shell': true, 'automations.execute': true },
        agent_kinds: ['opencode'],
      },
    });
    expect((await legacyPoll.json()) as { run_id?: number }).not.toHaveProperty('run_id');

    const isolatedPoll = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'headless-task-worker',
        capabilities: {
          'os.shell': true,
          'automations.execute': true,
          'automations.workspace.v1': true,
        },
        agent_kinds: ['opencode'],
      },
    });
    const job = (await isolatedPoll.json()) as {
      run_id?: number;
      entity_ids?: number[];
      entity?: { id: number; entity_type: string; metadata: Record<string, unknown> };
    };
    expect(job.run_id).toBe(run_id);
    expect(job.entity_ids).toEqual([ctx.entityId]);
    expect(job.entity).toMatchObject({
      id: ctx.entityId,
      entity_type: 'engineering-task',
      metadata: { repository: 'lobu-ai/lobu', status: 'open' },
    });
  });

  it('allows only one active writer across Automations targeting the same task', async () => {
    const workerId = 'headless-one-task-writer';
    const ctx = await setupDevicePinnedAutomation({
      workerId,
      platform: 'headless',
      capabilities: {
        'automations.execute': true,
        'automations.workspace.v1': true,
      },
      entityType: 'engineering-task',
      entityMetadata: { repository: 'lobu-ai/lobu' },
    });
    const secondAutomationId = await createPinnedAutomationForEntity(
      ctx,
      ctx.entityId,
      'same-task-second-automation'
    );
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      workerId
    );
    await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    await post(`/api/workers/me/automations/${secondAutomationId}/trigger`, { token });

    const first = await post('/api/workers/poll', {
      token,
      body: isolatedPollBody(workerId),
    });
    const firstJob = (await first.json()) as { run_id?: number };
    expect(firstJob.run_id).toBeGreaterThan(0);

    const blocked = await post('/api/workers/poll', {
      token,
      body: isolatedPollBody(workerId),
    });
    expect((await blocked.json()) as { run_id?: number }).not.toHaveProperty('run_id');

    await ctx.sql`
      UPDATE runs
      SET status = 'completed', completed_at = current_timestamp
      WHERE id = ${firstJob.run_id}
    `;
    const released = await post('/api/workers/poll', {
      token,
      body: isolatedPollBody(workerId),
    });
    expect(((await released.json()) as { run_id?: number }).run_id).toBeGreaterThan(0);
  });

  it('claims different engineering tasks concurrently', async () => {
    const workerId = 'headless-parallel-tasks';
    const ctx = await setupDevicePinnedAutomation({
      workerId,
      platform: 'headless',
      capabilities: {
        'automations.execute': true,
        'automations.workspace.v1': true,
      },
      entityType: 'engineering-task',
      entityMetadata: { repository: 'lobu-ai/lobu' },
    });
    const secondTask = await createTestEntity({
      name: 'Second engineering task',
      entity_type: 'engineering-task',
      organization_id: ctx.workspace.org.id,
      created_by: ctx.workspace.users.owner.id,
    });
    await ctx.sql`
      UPDATE entities
      SET metadata = ${ctx.sql.json({ repository: 'lobu-ai/lobu' })}
      WHERE id = ${secondTask.id}
    `;
    const secondAutomationId = await createPinnedAutomationForEntity(
      ctx,
      secondTask.id,
      'different-task-automation'
    );
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      workerId
    );
    await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    await post(`/api/workers/me/automations/${secondAutomationId}/trigger`, { token });

    const first = await post('/api/workers/poll', {
      token,
      body: isolatedPollBody(workerId),
    });
    const second = await post('/api/workers/poll', {
      token,
      body: isolatedPollBody(workerId),
    });
    const jobs = [await first.json(), await second.json()] as Array<{
      run_id?: number;
      entity?: { id: number };
    }>;
    expect(jobs.every((job) => job.run_id != null)).toBe(true);
    expect(new Set(jobs.map((job) => job.entity?.id))).toEqual(
      new Set([ctx.entityId, secondTask.id])
    );
  });

  it('automation without an assigned agent still dispatches instructions-only (no run-scoped session)', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'headless-agentless',
      platform: 'headless',
      capabilities: { 'os.shell': true, 'automations.execute': true },
    });
    // Legacy shape: automations existed (and executed) before agent assignment
    // was wired into device dispatch. They must keep dispatching with the
    // instructions prompt + exit-report completion, not fail at claim time.
    await ctx.sql`
      UPDATE automations SET agent_id = NULL WHERE id = ${ctx.automationId}
    `;
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'headless-agentless'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'headless-agentless',
        capabilities: { 'os.shell': true, 'automations.execute': true },
      },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_id?: number;
      run_type?: string;
      error?: string;
      payload?: {
        automation?: { prompt?: string };
        context?: { agent_session?: unknown };
      };
    };
    expect(job.run_type).toBe('automation');
    expect(job.run_id).toBeGreaterThan(0);
    expect(job.payload?.automation?.prompt).toContain('Summarize');
    expect(job.payload?.automation?.prompt).not.toContain(
      'client.automations.completeWindow'
    );
    expect(job.payload?.context?.agent_session).toBeUndefined();

    const [run] = await ctx.sql`
      SELECT status FROM runs WHERE id = ${job.run_id}
    `;
    expect(String(run.status)).toBe('running');
  });

  it('capable macOS daemon receives team-org session and can complete the window over MCP', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-capable',
      platform: 'macos',
      capabilities: { 'automations.execute': true },
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-capable'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);
    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'mac-capable',
        platform: 'macos',
        capabilities: { 'automations.execute': true },
        agent_kinds: ['opencode'],
      },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_id: number;
      payload?: {
        context?: {
          agent_session?: { token: string; mcp_url: string; conversation_id: string };
        };
      };
    };
    const session = job.payload?.context?.agent_session;
    expect(session?.mcp_url).toContain(`/mcp/${ctx.workspace.org.slug}`);
    expect(session?.conversation_id).toBe(
      `claim-gate-agent_automation_${ctx.automationId}_run_${job.run_id}`
    );

    const completion = await mcpToolsCall(
      'run_sdk',
      {
        script: `export default async (_c, client) => {
          const window = await client.knowledge.read({ automation_id: '${ctx.automationId}' });
          return client.automations.completeWindow({
            automation_id: '${ctx.automationId}',
            run_id: ${job.run_id},
            window_token: window.window_token,
            extracted_data: { summary: 'completed by the Mac daemon session' },
            model: 'device-cli:opencode',
          });
        }`,
      },
      { token: session!.token, orgSlug: ctx.workspace.org.slug }
    );
    expect(completion.success).toBe(true);

    const [run] = await ctx.sql`
      SELECT status FROM runs WHERE id = ${job.run_id}
    `;
    expect(String(run.status)).toBe('completed');
  });

  it('capable macOS daemon fails closed when no assigned agent can mint a session', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-agentless',
      platform: 'macos',
      capabilities: { 'automations.execute': true },
    });
    await ctx.sql`UPDATE automations SET agent_id = NULL WHERE id = ${ctx.automationId}`;
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-agentless'
    );
    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'mac-agentless',
        platform: 'macos',
        capabilities: { 'automations.execute': true },
        agent_kinds: ['opencode'],
      },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as { skipped_run_id?: number; error?: string };
    expect(job.skipped_run_id).toBeGreaterThan(0);
    expect(job.error).toContain('no assigned agent');
    const [run] = await ctx.sql`SELECT status FROM runs WHERE id = ${job.skipped_run_id}`;
    expect(String(run.status)).toBe('failed');
  });

  it('macOS daemon cancellation is terminal and idempotent', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-cancelled',
      platform: 'macos',
      capabilities: { 'automations.execute': true },
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-cancelled'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);
    const pollRes = await post('/api/workers/poll', {
      token,
      body: {
        worker_id: 'mac-cancelled',
        platform: 'macos',
        capabilities: { 'automations.execute': true },
        agent_kinds: ['opencode'],
      },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as { run_id?: number };
    expect(job.run_id).toBeGreaterThan(0);

    const report = {
      worker_id: 'mac-cancelled',
      output: 'daemon stopped by supervisor',
      exit_code: 143,
      exit_signal: 'SIGTERM',
      exit_reason: 'cancelled' as const,
    };
    const response = await post(
      `/api/workers/me/runs/${job.run_id}/complete-automation`,
      { token, body: report }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'cancelled',
      reason_code: 'device_daemon_shutdown',
      run_id: job.run_id,
    });

    const [run] = await ctx.sql`
      SELECT status, completed_at, output_tail, exit_code, exit_signal, exit_reason
      FROM runs
      WHERE id = ${job.run_id}
    `;
    expect(String(run.status)).toBe('cancelled');
    expect(run.completed_at).not.toBeNull();
    expect(String(run.output_tail)).toContain('daemon stopped by supervisor');
    expect(Number(run.exit_code)).toBe(143);
    expect(String(run.exit_signal)).toBe('SIGTERM');
    expect(String(run.exit_reason)).toBe('cancelled');

    const duplicate = await post(
      `/api/workers/me/runs/${job.run_id}/complete-automation`,
      { token, body: { ...report, output: 'duplicate report' } }
    );
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({
      ok: true,
      status: 'cancelled',
      idempotent: true,
    });
  });

  it('macOS device with capabilities:{} still claims (pre-capability exemption)', async () => {
    const ctx = await setupDevicePinnedAutomation({
      workerId: 'mac-exempt',
      platform: 'macos',
      capabilities: {},
    });
    const { token } = await createWorkerBoundPat(
      ctx.workspace.users.owner.id,
      ctx.workspace.org.id,
      'mac-exempt'
    );

    const trig = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, { token });
    expect(trig.status).toBe(200);

    // Owletto's bridge advertises a fixed capability set with no
    // automations.execute — it must keep working unchanged.
    const pollRes = await post('/api/workers/poll', {
      token,
      body: { worker_id: 'mac-exempt', capabilities: {} },
    });
    expect(pollRes.status).toBe(200);
    const job = (await pollRes.json()) as {
      run_type?: string;
      run_id?: number;
      payload?: { context?: { agent_session?: unknown } };
    };
    expect(job.run_type).toBe('automation');
    expect(job.run_id).toBeGreaterThan(0);
    // macOS keeps the Owletto dispatch path — no run-scoped agent session.
    expect(job.payload?.context?.agent_session).toBeUndefined();
  });
});
