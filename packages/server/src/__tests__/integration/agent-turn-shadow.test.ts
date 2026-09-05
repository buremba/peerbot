/**
 * The shadow producer end to end: a selected agent's message produces an
 * `agent_turn` run, only a fleet worker that advertises the lane can claim it,
 * and the turn is reported back on the lane's own completion route. This is the
 * seam that makes the isolate turn lane REACHABLE — the executor suite proves
 * the turn runs, this proves a real message reaches it and comes back.
 */
import {
  AgentTurnPollPayloadSchema,
  PollResponseSchema,
} from '@lobu/core/contracts/worker/protocol';
import type { MessagePayload } from '@lobu/core';
import { Value } from '@sinclair/typebox/value';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enqueueAgentTurnShadow } from '../../gateway/orchestration/agent-turn-shadow';
import type { AgentSettingsStore } from '../../gateway/auth/settings/agent-settings-store';
import type { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import type { ModelProviderModule } from '../../gateway/modules/module-system';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestPAT,
  createTestUser,
} from '../setup/test-fixtures';
import { post } from '../setup/test-helpers';

const SHADOW_ENV = 'LOBU_ISOLATE_TURN_SHADOW_AGENTS';
const PUBLIC_ORIGIN = 'https://gateway.test.invalid';
const AGENT_ID = 'shadow-agent';

/**
 * A provider module shaped like the real Claude one: a Lobu id that differs
 * from its upstream slug, so the model-prefix strip is actually exercised.
 */
function claudeModule(overrides: Partial<ModelProviderModule> = {}): ModelProviderModule {
  return {
    providerId: 'claude',
    sdkCompat: 'anthropic',
    getUpstreamConfig: () => ({
      slug: 'anthropic',
      upstreamBaseUrl: 'https://api.anthropic.com',
      apiKeyHeader: 'x-api-key' as const,
    }),
    getProxyBaseUrlMappings: (
      proxyUrl: string,
      agentId?: string,
      context?: { organizationId?: string; userId?: string }
    ) => ({
      ANTHROPIC_BASE_URL: `${proxyUrl}/anthropic/a/${agentId}/o/${context?.organizationId}/u/${context?.userId}`,
    }),
    buildCredentialPlaceholder: () => 'lobu_secret_11111111-2222-3333-4444-555555555555',
    ...overrides,
  } as unknown as ModelProviderModule;
}

function catalogFor(module: ModelProviderModule | undefined): ProviderCatalogService {
  return {
    getInstalledModules: async () => (module ? [module] : []),
    findProviderForModel: async () => module,
  } as unknown as ProviderCatalogService;
}

const settingsStore = {
  getSettings: async () => ({
    identityMd: 'I am the shadow agent.',
    soulMd: 'Answer briefly.',
    userMd: '',
  }),
} as unknown as AgentSettingsStore;

function messageFor(organizationId: string): MessagePayload {
  return {
    userId: 'user-shadow',
    conversationId: 'conv-shadow',
    messageId: 'msg-shadow',
    channelId: 'api_user-shadow',
    agentId: AGENT_ID,
    organizationId,
    botId: 'bot-shadow',
    platform: 'api',
    messageText: 'what is the shadow lane?',
    platformMetadata: {},
    agentOptions: { model: 'claude/claude-opus-4-8' },
  } as MessagePayload;
}

async function shadowRuns() {
  const sql = getTestDb();
  return (await sql`
    SELECT id, run_type, status, approval_status, organization_id, action_input
    FROM runs
    WHERE run_type = 'agent_turn'
    ORDER BY id
  `) as unknown as Array<{
    id: number;
    run_type: string;
    status: string;
    approval_status: string;
    organization_id: string;
    action_input: Record<string, unknown>;
  }>;
}

async function pollFleet(workerId: string, capabilities: Record<string, boolean>) {
  return post('/api/workers/poll', {
    body: { worker_id: workerId, capabilities },
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

async function postAsFleet(path: string, body: Record<string, unknown>) {
  return post(path, {
    body,
    token: 'test-fleet-token',
    env: { WORKER_API_TOKEN: 'test-fleet-token' },
  });
}

/** Enqueue a shadow turn and claim it, as the fleet worker would. */
async function claimedShadowRun(workerId: string): Promise<number> {
  const org = await createTestOrganization();
  await enqueueAgentTurnShadow(messageFor(org.id), {
    agentSettings: settingsStore,
    catalog: catalogFor(claudeModule()),
    publicOrigin: PUBLIC_ORIGIN,
  });
  const response = await pollFleet(workerId, { agent_turn: true });
  const body = await response.json();
  return body.run_id as number;
}

async function runRow(runId: number) {
  const sql = getTestDb();
  const [row] = (await sql`
    SELECT status, error_message, exit_reason, output_tail, action_input
    FROM runs WHERE id = ${runId}
  `) as unknown as Array<{
    status: string;
    error_message: string | null;
    exit_reason: string | null;
    output_tail: string | null;
    action_input: { turn?: unknown; result?: Record<string, unknown> };
  }>;
  return row;
}

describe('agent turn shadow producer', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

  it('produces a claimable, schema-valid envelope with the credential lifted off the turn', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    });

    const rows = await shadowRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_type: 'agent_turn',
      status: 'pending',
      approval_status: 'auto',
      organization_id: org.id,
    });

    const envelope = rows[0].action_input as {
      turn: Record<string, unknown>;
      credential: string;
    };
    // The poll response is built straight off this, so it must satisfy the
    // payload contract before any worker ever sees it.
    expect(Value.Check(AgentTurnPollPayloadSchema, { turn: envelope.turn })).toBe(true);

    expect(envelope.turn).toMatchObject({
      agent_id: AGENT_ID,
      conversation_id: 'conv-shadow',
      message_id: 'msg-shadow',
      message_text: 'what is the shadow lane?',
      shadow: true,
      provider: {
        api: 'anthropic-messages',
        provider: 'anthropic',
        // Lobu stores "claude/…"; the upstream only knows the bare id.
        model_id: 'claude-opus-4-8',
        base_url: `${PUBLIC_ORIGIN}/api/proxy/anthropic/a/${AGENT_ID}/o/${org.id}/u/user-shadow`,
      },
      // Deny-all: the gateway proxy and nothing else.
      allowed_hosts: ['gateway.test.invalid'],
    });
    expect(envelope.turn.system_prompt).toBe(
      '## Agent Identity\n\nI am the shadow agent.\n\n## Agent Instructions\n\nAnswer briefly.'
    );
    expect(envelope.turn.messages).toEqual([]);

    // The credential rides OUTSIDE the turn so the poll can lift it onto the
    // response's `credentials` and the worker can conceal it before the guest
    // ever sees a provider key.
    expect(envelope.credential).toBe('lobu_secret_11111111-2222-3333-4444-555555555555');
    expect(JSON.stringify(envelope.turn)).not.toContain('lobu_secret_');
  });

  it('arms no turn marker and journals no run input', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    });

    const sql = getTestDb();
    // Both are keyed (deploymentName, messageId) and both are first-writer-wins,
    // so a shadow that wrote either would let the observational lane terminate
    // or replay the real turn.
    const [markers] = (await sql`
      SELECT count(*)::int AS n FROM runs WHERE queue_name = 'internal:turn_timeout'
    `) as unknown as Array<{ n: number }>;
    expect(markers.n).toBe(0);
    const [journal] = (await sql`
      SELECT count(*)::int AS n FROM agent_run_input WHERE message_id = 'msg-shadow'
    `) as unknown as Array<{ n: number }>;
    expect(journal.n).toBe(0);
  });

  it('a fleet worker that advertises the lane claims it and receives the turn plus the credential', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    });
    const [run] = await shadowRuns();

    const response = await pollFleet('fleet-agent-turn', { agent_turn: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Value.Check(PollResponseSchema, body)).toBe(true);
    expect(body.run_id).toBe(run.id);
    expect(body.run_type).toBe('agent_turn');
    expect(body.organization_id).toBe(org.id);
    expect(body.payload.turn.provider.model_id).toBe('claude-opus-4-8');
    expect(body.credentials).toEqual({
      provider: 'anthropic',
      accessToken: 'lobu_secret_11111111-2222-3333-4444-555555555555',
    });

    const sql = getTestDb();
    const [claimed] = (await sql`
      SELECT status, claimed_by FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string; claimed_by: string }>;
    expect(claimed).toEqual({ status: 'running', claimed_by: 'fleet-agent-turn' });
  });

  it('a fleet worker without the capability leaves the run pending', async () => {
    const org = await createTestOrganization();
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    });
    const [run] = await shadowRuns();

    // An older daemon advertises no `agent_turn`. If it could claim the row it
    // would fall through `executeRun`'s default arm into `executeSyncRun`.
    const response = await pollFleet('fleet-old-daemon', { db_egress_hardening: true });
    const body = await response.json();
    expect(body.run_id).toBeUndefined();

    const sql = getTestDb();
    const [still] = (await sql`
      SELECT status FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string }>;
    expect(still.status).toBe('pending');
  });

  it('a user-scoped device worker cannot claim an agent turn', async () => {
    const org = await createTestOrganization();
    const user = await createTestUser();
    await addUserToOrganization(user.id, org.id, 'owner');
    await enqueueAgentTurnShadow(messageFor(org.id), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    });
    const [run] = await shadowRuns();

    const sql = getTestDb();
    await sql`
      INSERT INTO device_workers (user_id, worker_id, platform, capabilities, organization_id)
      VALUES (${user.id}, 'device-agent-turn', 'macos', ${sql.json([])}, ${org.id})
    `;
    const pat = await createTestPAT(user.id, org.id, { scope: 'device_worker:run' });
    const response = await post('/api/workers/poll', {
      token: pat.token,
      body: {
        worker_id: 'device-agent-turn',
        platform: 'macos',
        capabilities: { agent_turn: true },
      },
    });
    const body = await response.json();
    expect(body.run_id).toBeUndefined();

    const [still] = (await sql`
      SELECT status FROM runs WHERE id = ${run.id}
    `) as unknown as Array<{ status: string }>;
    expect(still.status).toBe('pending');
  });

  it('produces nothing when the agent is not selected, has no model, or runs an unsupported protocol', async () => {
    const org = await createTestOrganization();
    const deps = {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      publicOrigin: PUBLIC_ORIGIN,
    };

    process.env[SHADOW_ENV] = 'some-other-agent';
    await enqueueAgentTurnShadow(messageFor(org.id), deps);
    expect(await shadowRuns()).toHaveLength(0);

    process.env[SHADOW_ENV] = AGENT_ID;
    const noModel = messageFor(org.id);
    noModel.agentOptions = {};
    await enqueueAgentTurnShadow(noModel, deps);
    expect(await shadowRuns()).toHaveLength(0);

    // An attachment-only message: both providers reject an empty user turn, so
    // enqueueing one would only ever produce a failed run.
    const noText = messageFor(org.id);
    noText.messageText = '   ';
    await enqueueAgentTurnShadow(noText, deps);
    expect(await shadowRuns()).toHaveLength(0);

    // Google speaks a protocol whose pi-ai adapter is not fetch-native, so it
    // cannot be bundled for the isolate and must not produce a shadow.
    await enqueueAgentTurnShadow(messageFor(org.id), {
      ...deps,
      catalog: catalogFor(claudeModule({ sdkCompat: 'google' })),
    });
    expect(await shadowRuns()).toHaveLength(0);

    // No public origin means no URL a fleet worker could reach the proxy on.
    await enqueueAgentTurnShadow(messageFor(org.id), { ...deps, publicOrigin: undefined });
    expect(await shadowRuns()).toHaveLength(0);

    // `*` selects every agent — the operator's blanket switch.
    process.env[SHADOW_ENV] = '*';
    await enqueueAgentTurnShadow(messageFor(org.id), deps);
    expect(await shadowRuns()).toHaveLength(1);
  });
});


describe('agent turn completion', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    delete process.env.WORKER_API_TOKEN;
    process.env[SHADOW_ENV] = AGENT_ID;
  });

  afterEach(() => {
    delete process.env[SHADOW_ENV];
  });

  it('records the transcript on the run row and is idempotent on a retry', async () => {
    const workerId = 'fleet-complete';
    const runId = await claimedShadowRun(workerId);

    const transcript = [
      { role: 'user', content: 'what is the shadow lane?' },
      { role: 'assistant', content: [{ type: 'text', text: 'an observational copy' }] },
    ];
    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'an observational copy',
      stop_reason: 'stop',
      usage: { input: 11, output: 7 },
      transcript,
      exit_reason: 'ok',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'completed' });

    const row = await runRow(runId);
    expect(row.status).toBe('completed');
    expect(row.exit_reason).toBe('ok');
    expect(row.output_tail).toBe('an observational copy');
    expect(row.error_message).toBe(null);
    // The turn envelope survives alongside the result, so the shadow stays
    // diffable against what the subprocess lane answered.
    expect(row.action_input.turn).toBeDefined();
    expect(row.action_input.result).toEqual({
      text: 'an observational copy',
      stop_reason: 'stop',
      usage: { input: 11, output: 7 },
      transcript,
    });

    // A retry (worker reconnect, at-least-once delivery) must not re-transition.
    const retry = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'a late duplicate report',
    });
    expect(await retry.json()).toEqual({
      ok: true,
      status: 'completed',
      idempotent: true,
    });
    expect((await runRow(runId)).status).toBe('completed');
  });

  it('fails the run when the worker reports a failed turn', async () => {
    const workerId = 'fleet-fail';
    const runId = await claimedShadowRun(workerId);

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'failed',
      error: 'the provider refused the request',
      exit_reason: 'error_message',
    });
    expect(await response.json()).toEqual({ ok: true, status: 'failed' });

    const row = await runRow(runId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('the provider refused the request');
    expect(row.exit_reason).toBe('error_message');
  });

  it('refuses a worker that did not claim the run', async () => {
    const runId = await claimedShadowRun('fleet-claimant');

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: 'fleet-impostor',
      status: 'completed',
      text: 'not mine to report',
    });
    // Not this worker's run: reported as already-settled rather than applied.
    expect(await response.json()).toMatchObject({ idempotent: true });
    expect((await runRow(runId)).status).toBe('running');
  });

  it('refuses to record a reply for a turn that did not declare itself observational', async () => {
    const workerId = 'fleet-authoritative';
    const runId = await claimedShadowRun(workerId);
    // Strip the flag the producer sets. This is the deploy-skew shape the guard
    // exists for: a producer that starts marking turns authoritative before the
    // reply path exists would otherwise have every reply recorded and dropped.
    const sql = getTestDb();
    await sql`
      UPDATE runs
      SET action_input = jsonb_set(action_input, '{turn,shadow}', 'false'::jsonb)
      WHERE id = ${runId}
    `;

    const response = await postAsFleet('/api/workers/complete-agent-turn', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      text: 'a reply nobody would deliver',
    });
    expect(response.status).toBe(409);
    const row = await runRow(runId);
    expect(row.status).toBe('running');
    expect(row.action_input.result).toBeUndefined();
  });

  it('the generic complete route refuses an agent turn and leaves it running', async () => {
    const workerId = 'fleet-generic';
    const runId = await claimedShadowRun(workerId);

    // A daemon that predates the lane would finalize the turn with sync
    // semantics, dropping the transcript and the reply. The reaper terminalizes
    // it instead.
    const response = await postAsFleet('/api/workers/complete', {
      run_id: runId,
      worker_id: workerId,
      status: 'completed',
      items_collected: 0,
    });
    expect(response.status).toBe(409);
    expect((await runRow(runId)).status).toBe('running');
  });
});
