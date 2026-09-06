/**
 * Long-conversation parity for the isolate lane.
 *
 * The lane used to send the last twelve messages and nothing else. On a long
 * conversation that silently lost the beginning: the model answered as if the
 * earlier turns had never happened, and nothing in the transcript or the logs
 * said so. The subprocess lane never had that failure because pi compacted
 * against the model's own context window.
 *
 * These tests pin the replacement on both sides of the decision:
 *
 *  - the budget comes from the model's REAL window, so the same conversation
 *    compacts on a small model and does not on a large one;
 *  - what is dropped is SUMMARIZED through the gateway's existing shared LLM
 *    transport, and the summary reaches the turn ahead of the recent window;
 *  - when the summarizer is unavailable the turn still runs, and the outcome is
 *    honest rather than silently identical to the summarized one.
 *
 * The summarizer is exercised through a real provider row and a stubbed
 * `/chat/completions`, so the org-scoped credential hop is real; only the
 * upstream is canned.
 */
import {
  __resetEncryptionKeyCacheForTests,
  type MessagePayload,
} from '@lobu/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSettingsStore } from '../../gateway/auth/settings/agent-settings-store';
import type { ProviderCatalogService } from '../../gateway/auth/provider-catalog';
import type { ModelProviderModule } from '../../gateway/modules/module-system';
import { enqueueAgentTurnShadow } from '../../gateway/orchestration/agent-turn-shadow';
import {
  resolveModelCapability,
  UNKNOWN_MODEL_CAPABILITY,
} from '../../gateway/inference/model-capability';
import { createInferenceProvider } from '../../lobu/stores/provider-secrets';
import { getDb } from '../../db/client';
import { cleanupTestDatabase, getTestDb } from '../setup/test-db';
import { createTestOrganization } from '../setup/test-fixtures';

const SHADOW_ENV = 'LOBU_ISOLATE_TURN_SHADOW_AGENTS';
const GATEWAY_URL = 'https://gateway.test.invalid/lobu';
const AGENT_ID = 'compaction-agent';
const CONVERSATION_ID = 'conv-compaction';

/**
 * Two REAL registry models with very different windows, so "the budget follows
 * the model" is proven against pi-ai's own numbers rather than a stub. If a
 * future pi-ai drops either id the resolver falls back and these assertions
 * fail loudly, which is the correct signal — not something to paper over.
 */
const BIG_WINDOW_MODEL = 'claude-sonnet-4-5-20250929';
const SMALL_WINDOW_MODEL = 'gpt-4o-mini';

let summarizerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let summaryReply: string | null = 'The user and the assistant agreed to migrate the billing job to the new queue, chose Postgres advisory locks over Redis, and left the dashboard rename outstanding.';
const realFetch = global.fetch;

function installFetchStub(): void {
  summarizerCalls = [];
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/chat/completions')) {
      summarizerCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      if (summaryReply === null) {
        return new Response('upstream exploded', { status: 500, statusText: 'Server Error' });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: summaryReply } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function claudeModule(): ModelProviderModule {
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
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) =>
      context?.workerToken ?? 'lobu-proxy',
  } as unknown as ModelProviderModule;
}

function openAiModule(): ModelProviderModule {
  return {
    providerId: 'openai',
    sdkCompat: 'openai',
    getUpstreamConfig: () => ({ slug: 'openai', upstreamBaseUrl: 'https://api.openai.com' }),
    getProxyBaseUrlMappings: (
      proxyUrl: string,
      agentId?: string,
      context?: { organizationId?: string; userId?: string }
    ) => ({
      OPENAI_BASE_URL: `${proxyUrl}/openai/a/${agentId}/o/${context?.organizationId}/u/${context?.userId}`,
    }),
    buildCredentialPlaceholder: (_agentId: string, context?: { workerToken?: string }) =>
      context?.workerToken ?? 'lobu-proxy',
  } as unknown as ModelProviderModule;
}

function catalogFor(module: ModelProviderModule): ProviderCatalogService {
  return {
    getInstalledModules: async () => [module],
    findProviderForModel: async () => module,
  } as unknown as ProviderCatalogService;
}

const settingsStore = {
  getSettings: async () => ({ identityMd: 'I am the agent.', soulMd: '', userMd: '' }),
} as unknown as AgentSettingsStore;

function messageFor(organizationId: string, modelRef: string): MessagePayload {
  return {
    userId: 'user-compaction',
    conversationId: CONVERSATION_ID,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    channelId: 'api_user-compaction',
    agentId: AGENT_ID,
    organizationId,
    botId: 'bot-compaction',
    platform: 'api',
    messageText: 'where did we land on the queue migration?',
    platformMetadata: {},
    agentOptions: { model: modelRef },
  } as MessagePayload;
}

/**
 * A transcript of `pairs` user/assistant exchanges, each roughly `charsEach`
 * characters, oldest first. The first exchange carries a distinctive fact so a
 * test can tell "the beginning survived in the summary" from "the beginning is
 * simply gone".
 */
function seedTranscript(pairs: number, charsEach: number): string {
  const at = new Date(Date.now() - 60_000).toISOString();
  const entry = (id: string, message: Record<string, unknown>) =>
    JSON.stringify({ type: 'message', id, parentId: null, timestamp: at, message });
  const lines = [
    JSON.stringify({ type: 'session', version: 3, id: 'prior', timestamp: at, cwd: '/w' }),
  ];
  for (let i = 0; i < pairs; i++) {
    const marker = i === 0 ? 'ORIGINAL-DECISION advisory locks over Redis. ' : '';
    lines.push(entry(`u${i}`, { role: 'user', content: `${marker}${'question '.repeat(Math.ceil(charsEach / 9))}`, timestamp: 1 }));
    lines.push(
      entry(`a${i}`, {
        role: 'assistant',
        content: [{ type: 'text', text: `${'answer '.repeat(Math.ceil(charsEach / 7))}` }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: 1,
      })
    );
  }
  lines.push('');
  return lines.join('\n');
}

async function storeTranscript(organizationId: string, snapshot: string): Promise<void> {
  const sql = getTestDb();
  const at = new Date(Date.now() - 60_000).toISOString();
  const [prior] = await sql<{ id: number }>`
    INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
    VALUES ('chat_message', 'completed', ${organizationId}, ${at}, ${at}, ${at})
    RETURNING id
  `;
  await sql`
    INSERT INTO agent_transcript_snapshot
      (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
    VALUES (${organizationId}, ${AGENT_ID}, ${CONVERSATION_ID}, ${prior.id},
            ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed', ${at})
  `;
}

/** An org with a real, default OpenAI-compatible provider row for the summarizer. */
async function orgWithSummarizer() {
  const org = await createTestOrganization();
  const created = await createInferenceProvider({
    organizationId: org.id,
    slug: 'openai',
    kind: 'openai',
    apiKey: 'sk-compaction-test',
    capabilities: { text: { model: 'gpt-4o-mini' } },
  });
  if ('error' in created) throw new Error(`create failed: ${created.error}`);
  await getDb()`
    UPDATE inference_providers SET is_default = true
    WHERE organization_id = ${org.id} AND slug = 'openai'
  `;
  return org;
}

interface TurnEnvelopeShape {
  messages: Array<Record<string, unknown>>;
  provider: { context_window?: number; max_tokens?: number; model_id: string };
}

async function latestTurn(): Promise<TurnEnvelopeShape> {
  const sql = getTestDb();
  const rows = (await sql`
    SELECT action_input FROM runs WHERE run_type = 'agent_turn' ORDER BY id DESC LIMIT 1
  `) as unknown as Array<{ action_input: { turn: TurnEnvelopeShape } }>;
  if (rows.length === 0) throw new Error('no agent_turn run was produced');
  return rows[0]!.action_input.turn;
}

/** The text of a message, however its content is shaped. */
function textOf(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

let savedShadowEnv: string | undefined;

beforeAll(() => {
  process.env.LOBU_ENCRYPTION_KEY ||= 'a'.repeat(64);
  __resetEncryptionKeyCacheForTests();
});

beforeEach(() => {
  savedShadowEnv = process.env[SHADOW_ENV];
  process.env[SHADOW_ENV] = '*';
  summaryReply =
    'The user and the assistant agreed to migrate the billing job to the new queue, chose Postgres ORIGINAL-DECISION advisory locks over Redis, and left the dashboard rename outstanding.';
  installFetchStub();
});

afterEach(async () => {
  global.fetch = realFetch;
  if (savedShadowEnv === undefined) delete process.env[SHADOW_ENV];
  else process.env[SHADOW_ENV] = savedShadowEnv;
  await getTestDb()`DELETE FROM runs WHERE run_type = 'agent_turn'`;
});

afterAll(async () => {
  global.fetch = realFetch;
  await cleanupTestDatabase();
});

describe('agent turn history: the model window decides, and what falls off is summarized', () => {
  /**
   * The window is resolved, not assumed. This is the assertion that fails if
   * anyone reintroduces a hardcoded 200_000: pi-ai's registry knows these two
   * models have materially different windows, and the producer must report each
   * model's own.
   */
  it('resolves each model real context window from the registry, and floors an unknown one', () => {
    const big = resolveModelCapability('anthropic', BIG_WINDOW_MODEL);
    const small = resolveModelCapability('openai', SMALL_WINDOW_MODEL);
    expect(big.fromRegistry).toBe(true);
    expect(small.fromRegistry).toBe(true);
    expect(big.contextWindow).toBeGreaterThan(0);
    expect(small.contextWindow).toBeGreaterThan(0);

    // A model pi-ai has never heard of falls to the documented floor rather
    // than to an optimistic guess.
    const unknown = resolveModelCapability('anthropic', 'not-a-real-model-id-9999');
    expect(unknown).toEqual(UNKNOWN_MODEL_CAPABILITY);
    expect(unknown.fromRegistry).toBe(false);
    expect(unknown.contextWindow).toBe(128_000);
  });

  /**
   * A conversation that comfortably fits is NOT compacted: no summarizer call,
   * every message present, the whole beginning verbatim. Without this, a test
   * that only proves "long conversations compact" would also pass if the
   * producer compacted everything unconditionally.
   */
  it('sends a short conversation whole and never calls the summarizer', async () => {
    const org = await orgWithSummarizer();
    await storeTranscript(org.id, seedTranscript(3, 200));

    await enqueueAgentTurnShadow(messageFor(org.id, `claude/${BIG_WINDOW_MODEL}`), {
      agentSettings: settingsStore,
      catalog: catalogFor(claudeModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const turn = await latestTurn();
    expect(summarizerCalls).toHaveLength(0);
    expect(turn.messages).toHaveLength(6);
    expect(turn.messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);
    // The oldest message survived verbatim, marker and all.
    expect(textOf(turn.messages[0]!)).toContain('ORIGINAL-DECISION');
    // And the window it was fitted to is the model's own, on the wire.
    expect(turn.provider.context_window).toBe(
      resolveModelCapability('anthropic', BIG_WINDOW_MODEL).contextWindow
    );
    expect(turn.provider.max_tokens).toBe(
      resolveModelCapability('anthropic', BIG_WINDOW_MODEL).maxTokens
    );
  });

  /**
   * The core case. The SAME conversation that fits a large model overflows a
   * small one, so it must compact there — and the compaction must PRESERVE the
   * beginning as a summary rather than drop it.
   */
  it('summarizes the overflow on a small-window model and keeps the recent window verbatim', async () => {
    const org = await orgWithSummarizer();
    // 400 pairs of ~700 chars ≈ 140k estimated tokens — more than double
    // gpt-4o-mini's 64k history budget, and ~720 KB, comfortably inside the
    // 1 MB snapshot read so the READ is not what does the truncating.
    await storeTranscript(org.id, seedTranscript(400, 700));

    await enqueueAgentTurnShadow(messageFor(org.id, `openai/${SMALL_WINDOW_MODEL}`), {
      agentSettings: settingsStore,
      catalog: catalogFor(openAiModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const turn = await latestTurn();

    // The summarizer ran exactly once, through the org's own provider row.
    expect(summarizerCalls).toHaveLength(1);
    expect(summarizerCalls[0]!.url).toContain('/chat/completions');
    // It was asked to compact, and it was fed the DROPPED prefix — including
    // the oldest exchange, which is the part that would otherwise vanish.
    const sent = summarizerCalls[0]!.body as {
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
    };
    expect(sent.messages[0]!.role).toBe('system');
    expect(sent.messages[0]!.content).toContain('compact');
    expect(sent.max_tokens).toBeGreaterThan(0);

    // The turn opens on the summary, and the summary carries the old decision.
    const first = turn.messages[0]!;
    expect(first.role).toBe('user');
    expect(textOf(first)).toContain('summarized');
    expect(textOf(first)).toContain('ORIGINAL-DECISION');

    // The rest is the recent window, verbatim and well-formed: it follows the
    // summary, it is far shorter than the full transcript, and it ends on the
    // most recent assistant reply rather than mid-exchange.
    expect(turn.messages.length).toBeGreaterThan(1);
    expect(turn.messages.length).toBeLessThan(800);
    expect(turn.messages[turn.messages.length - 1]!.role).toBe('assistant');
    // Verbatim, not summarized: recent assistant text is the seeded filler.
    expect(textOf(turn.messages[turn.messages.length - 1]!)).toContain('answer');

    // And the wire reports the SMALL model's window, not a 200k assumption.
    const small = resolveModelCapability('openai', SMALL_WINDOW_MODEL);
    expect(turn.provider.context_window).toBe(small.contextWindow);
    expect(small.contextWindow).toBeLessThan(200_000);
  });

  /**
   * The honesty case. When the summarizer fails, the turn must still run — but
   * it must not look identical to a successful compaction, or an operator can
   * never tell a summarized conversation from a truncated one.
   */
  it('still runs the turn when the summarizer fails, with no fabricated summary', async () => {
    const org = await orgWithSummarizer();
    summaryReply = null; // the stubbed upstream 500s
    await storeTranscript(org.id, seedTranscript(400, 700));

    await enqueueAgentTurnShadow(messageFor(org.id, `openai/${SMALL_WINDOW_MODEL}`), {
      agentSettings: settingsStore,
      catalog: catalogFor(openAiModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const turn = await latestTurn();
    // It tried.
    expect(summarizerCalls.length).toBeGreaterThan(0);
    // The turn exists and carries the recent window.
    expect(turn.messages.length).toBeGreaterThan(0);
    expect(turn.messages[0]!.role).toBe('user');
    // But NO summary was invented: the lead message is real conversation, not
    // a compaction marker.
    expect(textOf(turn.messages[0]!)).not.toContain('summarized');
    expect(textOf(turn.messages[0]!)).not.toContain('End of summary');
  });

  /**
   * An org with no provider row cannot summarize at all. The turn must survive
   * that too — the shadow producer is best-effort and a missing enrichment
   * credential must never cost a turn.
   */
  it('runs the turn when the org has no summarizer credential at all', async () => {
    const org = await createTestOrganization();
    await storeTranscript(org.id, seedTranscript(400, 700));

    await enqueueAgentTurnShadow(messageFor(org.id, `openai/${SMALL_WINDOW_MODEL}`), {
      agentSettings: settingsStore,
      catalog: catalogFor(openAiModule()),
      gatewayUrl: GATEWAY_URL,
    });

    const turn = await latestTurn();
    // No provider row → the resolver never reaches an upstream.
    expect(summarizerCalls).toHaveLength(0);
    expect(turn.messages.length).toBeGreaterThan(0);
    expect(textOf(turn.messages[0]!)).not.toContain('summarized');
  });

  /**
   * One org's transcript must never be summarized through another org's
   * provider. The summarizer target is resolved from the turn's own
   * organization, so an org with no row gets no call even while a neighbouring
   * org has one.
   */
  it('never borrows another org provider to summarize', async () => {
    await orgWithSummarizer(); // a neighbour with a perfectly good row
    const bare = await createTestOrganization();
    await storeTranscript(bare.id, seedTranscript(400, 700));

    await enqueueAgentTurnShadow(messageFor(bare.id, `openai/${SMALL_WINDOW_MODEL}`), {
      agentSettings: settingsStore,
      catalog: catalogFor(openAiModule()),
      gatewayUrl: GATEWAY_URL,
    });

    expect(summarizerCalls).toHaveLength(0);
  });
});
