/**
 * Integration test for the device `agent_kinds` advertisement and the
 * automation claim lane that gates on it (POST /api/workers/poll).
 *
 * A device-pinned Automation names the local CLI it needs in
 * `approved_input.agent_kind`. Before this gate the automation lane was
 * capability-blind, so a device with no executor for that kind still claimed
 * the run and then failed it locally with "no local agent executor configured"
 * — indistinguishable, from the UI, from a broken Automation.
 *
 * Verifies:
 *   - poll persists the advertised kinds onto device_workers, and a later poll
 *     that omits the field does not erase them.
 *   - advertised kind matches the run's agent_kind → claimed.
 *   - advertised kinds don't include it → not claimed, run stays pending, and
 *     the same device claims it once it advertises the kind.
 *   - advertising nothing at all (a client that does not send the field)
 *     stays unrestricted; advertising `[]` claims nothing.
 *   - a run naming no agent_kind is claimable by an advertising device, but not
 *     by one advertising `[]`.
 *   - GET /api/me/devices reports the advertised kinds, keeping null distinct
 *     from [].
 */

import type { Context } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import { listDeviceWorkers } from '../../../worker-api/device-management';
import { generateSecureToken, hashToken } from '../../../auth/oauth/utils';
import { parsePgTextArray } from '../../../db/client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestAgent, createTestEntity } from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';
import { TestWorkspace } from '../../setup/test-mcp-client';

/** Mint a PAT bound to a device worker_id, as the Mac app / daemon holds. */
async function createWorkerBoundPat(
  userId: string,
  organizationId: string,
  workerId: string
): Promise<string> {
  const sql = getTestDb();
  const token = `owl_pat_${generateSecureToken(24)}`;
  await sql`
    INSERT INTO personal_access_tokens (
      token_hash, token_prefix, user_id, organization_id, name, scope, worker_id,
      created_at, updated_at
    ) VALUES (
      ${hashToken(token)}, ${token.substring(0, 12)}, ${userId}, ${organizationId},
      ${`Test worker PAT (${workerId})`}, 'device_worker:run', ${workerId},
      NOW(), NOW()
    )
  `;
  return token;
}

interface GateCtx {
  sql: ReturnType<typeof getTestDb>;
  organizationId: string;
  userId: string;
  workerId: string;
  token: string;
  deviceWorkerId: string;
  automationId: number;
}

/**
 * Register a device worker plus an Automation pinned to it. `agentKind: null`
 * leaves the pin without a named CLI, which the device resolves against its own
 * default.
 */
async function setup(opts: {
  workerId: string;
  agentKind: string | null;
}): Promise<GateCtx> {
  const sql = getTestDb();
  const workspace = await TestWorkspace.create({ name: 'Agent Kinds Org' });
  const userId = workspace.users.owner.id;
  const organizationId = workspace.org.id;

  const inserted = (await sql`
    INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
    VALUES (${userId}, ${opts.workerId}, 'macos', ${sql.json({})}, 'Mac Test', ${organizationId})
    RETURNING id
  `) as unknown as Array<{ id: string }>;
  const deviceWorkerId = String(inserted[0].id);

  const entity = await createTestEntity({
    name: 'Gate Entity',
    organization_id: organizationId,
    created_by: userId,
  });
  const agent = await createTestAgent({
    organizationId,
    ownerUserId: userId,
    agentId: 'gate-agent',
    name: 'Gate Agent',
  });
  const automation = (await workspace.owner.automations.create({
    entity_id: entity.id,
    slug: 'gate-automation',
    name: 'Gate Automation',
    prompt: 'Summarize {{entities}}.',
    triggers: [{ kind: 'schedule', cron: '0 9 * * *' }],
    agent_id: agent.agentId,
  })) as { automation_id: string };
  const automationId = Number(automation.automation_id);

  // AutomationCreateInput doesn't expose device_worker_id / agent_kind; set
  // them directly, as manual-trigger.test.ts does.
  await sql`
    UPDATE automations
    SET device_worker_id = ${deviceWorkerId}::uuid,
        agent_kind = ${opts.agentKind}
    WHERE id = ${automationId}
  `;

  const token = await createWorkerBoundPat(userId, organizationId, opts.workerId);
  return { sql, organizationId, userId, workerId: opts.workerId, token, deviceWorkerId, automationId };
}

/** Queue a pending run via the manual-trigger endpoint the device owns. */
async function trigger(ctx: GateCtx): Promise<number> {
  const res = await post(`/api/workers/me/automations/${ctx.automationId}/trigger`, {
    token: ctx.token,
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { run_id: number };
  return json.run_id;
}

/** Poll as the device. `agentKinds: undefined` omits the field entirely. */
async function poll(
  ctx: GateCtx,
  agentKinds?: string[]
): Promise<{ run_id?: number; run_type?: string; next_poll_seconds?: number }> {
  const body: Record<string, unknown> = { worker_id: ctx.workerId, capabilities: {} };
  if (agentKinds !== undefined) body.agent_kinds = agentKinds;
  const res = await post('/api/workers/poll', { token: ctx.token, body });
  expect(res.status).toBe(200);
  return (await res.json()) as { run_id?: number; run_type?: string };
}

/** Invoke the session-authenticated devices listing without the auth plumbing. */
async function callListDevices(
  userId: string
): Promise<Array<{ worker_id: string; agent_kinds: string[] | null }>> {
  const res = await listDeviceWorkers({
    var: { user: { id: userId } },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>);
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    devices: Array<{ worker_id: string; agent_kinds: string[] | null }>;
  };
  return json.devices;
}

async function runStatus(ctx: GateCtx, runId: number): Promise<string> {
  const [row] = await ctx.sql`SELECT status FROM runs WHERE id = ${runId}`;
  return String(row.status);
}

describe('device agent_kinds advertisement + automation claim gate', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('persists advertised kinds, and a later poll omitting them does not erase them', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-persist', agentKind: 'claude-code' });

    await poll(ctx, ['claude-code', ' pi ', 'claude-code', '']);
    const [afterAdvertise] = await ctx.sql`
      SELECT agent_kinds FROM device_workers WHERE id = ${ctx.deviceWorkerId}::uuid
    `;
    // Trimmed, de-duplicated, blanks dropped.
    // The driver returns text[] as a raw '{a,b}' literal, hence parsePgTextArray.
    expect(parsePgTextArray(afterAdvertise.agent_kinds)).toEqual(['claude-code', 'pi']);

    // A downgraded client omits the field; COALESCE must keep what the
    // capable client already told us.
    await poll(ctx);
    const [afterOmit] = await ctx.sql`
      SELECT agent_kinds FROM device_workers WHERE id = ${ctx.deviceWorkerId}::uuid
    `;
    expect(parsePgTextArray(afterOmit.agent_kinds)).toEqual(['claude-code', 'pi']);
  });

  it('claims a run whose agent_kind the device advertised', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-match', agentKind: 'claude-code' });
    const runId = await trigger(ctx);

    const job = await poll(ctx, ['claude-code', 'pi']);
    expect(job.run_type).toBe('automation');
    expect(job.run_id).toBe(runId);
    expect(await runStatus(ctx, runId)).toBe('running');
  });

  it('withholds a run whose agent_kind the device cannot run, then hands it over once advertised', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-miss', agentKind: 'claude-code' });
    const runId = await trigger(ctx);

    const miss = await poll(ctx, ['pi']);
    expect(miss.run_id).toBeUndefined();
    expect(await runStatus(ctx, runId)).toBe('pending');

    // The user installs the CLI; the next poll's discovery sweep picks it up
    // and the same still-pending run is claimed — nothing had to be re-queued.
    const hit = await poll(ctx, ['pi', 'claude-code']);
    expect(hit.run_id).toBe(runId);
    expect(await runStatus(ctx, runId)).toBe('running');
  });

  it('claims nothing when the device advertises an empty kind set', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-empty', agentKind: 'claude-code' });
    const runId = await trigger(ctx);

    const job = await poll(ctx, []);
    expect(job.run_id).toBeUndefined();
    expect(await runStatus(ctx, runId)).toBe('pending');

    const [row] = await ctx.sql`
      SELECT agent_kinds FROM device_workers WHERE id = ${ctx.deviceWorkerId}::uuid
    `;
    // Advertised-none is stored as [], not NULL — that's what makes it a gate
    // rather than a legacy no-op.
    expect(row.agent_kinds).not.toBeNull();
    expect(parsePgTextArray(row.agent_kinds)).toEqual([]);
  });

  it('leaves a device that never advertised unrestricted', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-legacy', agentKind: 'claude-code' });
    const runId = await trigger(ctx);

    const job = await poll(ctx);
    expect(job.run_id).toBe(runId);
    expect(await runStatus(ctx, runId)).toBe('running');

    const [row] = await ctx.sql`
      SELECT agent_kinds FROM device_workers WHERE id = ${ctx.deviceWorkerId}::uuid
    `;
    expect(row.agent_kinds).toBeNull();
  });

  it('reports advertised kinds on GET /api/me/devices, null distinct from []', async () => {
    const advertised = await setup({ workerId: 'mac-kinds-listed', agentKind: 'claude-code' });
    await poll(advertised, ['claude-code']);

    // A second device on the same user that has only ever polled without the
    // field — the listing must not flatten it to "runs nothing".
    await advertised.sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, label, organization_id)
      VALUES (${advertised.userId}, 'mac-kinds-silent', 'macos', ${advertised.sql.json({})},
              'Silent Mac', ${advertised.organizationId})
    `;

    const listed = await callListDevices(advertised.userId);
    const byWorker = new Map(listed.map((d) => [d.worker_id, d.agent_kinds]));
    expect(byWorker.get('mac-kinds-listed')).toEqual(['claude-code']);
    expect(byWorker.get('mac-kinds-silent')).toBeNull();
  });

  it('withholds an unnamed-agent_kind run from a device that advertises nothing runnable', async () => {
    // The empty set is the one case where "no agent_kind" is not permissive:
    // the device would resolve it against its own default, and it has none.
    const ctx = await setup({ workerId: 'mac-kinds-empty-unnamed', agentKind: null });
    const runId = await trigger(ctx);

    const job = await poll(ctx, []);
    expect(job.run_id).toBeUndefined();
    expect(await runStatus(ctx, runId)).toBe('pending');
  });

  it('claims a run that names no agent_kind even when the device advertises kinds', async () => {
    const ctx = await setup({ workerId: 'mac-kinds-unpinned', agentKind: null });
    const runId = await trigger(ctx);

    const job = await poll(ctx, ['pi']);
    expect(job.run_id).toBe(runId);
    expect(await runStatus(ctx, runId)).toBe('running');
  });
});
