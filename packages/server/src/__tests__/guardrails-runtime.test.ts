/**
 * End-to-end guardrails-runtime test against the actual wired call sites.
 *
 * Each block constructs the real service (ChatResponseBridge / MessageConsumer
 * / McpProxy), wires the same registry + AgentSettingsStore the production
 * gateway uses, and drives the public method that handles the corresponding
 * stage. Assertions cover:
 *
 *   - the block message is delivered (chat target / queue / JSON-RPC reply)
 *   - the `events` row lands with `semantic_type='guardrail-trip'`
 *   - the rolling output buffer catches secrets split across stream chunks
 *   - the audit org id falls back to the connection / agent metadata when the
 *     payload doesn't carry it
 *
 * Tests use `flushPendingGuardrailAudits()` (the production hook) instead of
 * a sleep — fire-and-forget audit writes are explicitly awaitable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guardrail } from '@lobu/core';
import { generateWorkerToken, GuardrailRegistry } from '@lobu/core';
import { AgentSettingsStore } from '../gateway/auth/settings/agent-settings-store';
import { McpProxy } from '../gateway/auth/mcp/proxy';
import { ApiResponseRenderer } from '../gateway/api/response-renderer';
import { ChatResponseBridge } from '../gateway/connections/chat-response-bridge';
import { UnifiedThreadResponseConsumer } from '../gateway/platform/unified-thread-consumer';
import {
  flushPendingGuardrailAudits,
} from '../gateway/guardrails/audit';
import { registerBuiltinGuardrails } from '../gateway/guardrails/builtins';
import { MessageConsumer } from '../gateway/orchestration/message-consumer';
import type { OrchestratorConfig } from '../gateway/orchestration/base-deployment-manager';
import type { BaseDeploymentManager } from '../gateway/orchestration/base-deployment-manager';
import { GrantStore } from '../gateway/permissions/grant-store';
import {
  PostgresSecretStore,
} from '../lobu/stores/postgres-secret-store';
import { orgContext } from '../lobu/stores/org-context';
import { createPostgresAgentConfigStore } from '../lobu/stores/postgres-stores';
import { SecretStoreRegistry } from '../gateway/secrets/index';
import { cleanupTestDatabase, getTestDb } from './setup/test-db';
import {
  createTestAgent,
  createTestOrganization,
} from './setup/test-fixtures';

// ─────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────

interface PostedMessage {
  text?: string;
  iterableChunks?: string[];
}

/**
 * Mock chat target that captures `post(string)` and `post(asyncIterable)`
 * separately so the test can distinguish a streaming chunk from the
 * out-of-band block message.
 */
function createCapturingTarget() {
  const posted: PostedMessage[] = [];
  const target = {
    post: async (arg: unknown) => {
      if (typeof arg === 'string') {
        posted.push({ text: arg });
        return { id: 'msg' };
      }
      if (arg && typeof (arg as any)[Symbol.asyncIterator] === 'function') {
        const chunks: string[] = [];
        for await (const chunk of arg as AsyncIterable<string>) {
          chunks.push(chunk);
        }
        posted.push({ iterableChunks: chunks });
        return { id: 'msg-stream' };
      }
      posted.push({});
      return { id: 'msg-other' };
    },
    startTyping: async () => {},
  };
  return { target, posted };
}

function createManager(target: unknown, agentId: string, orgId: string) {
  return {
    getInstance: () => ({
      connection: {
        agentId,
        organizationId: orgId,
        platform: 'telegram',
      },
      chat: {
        channel: () => target,
        getAdapter: () => undefined,
      },
      conversationState: undefined,
    }),
    has: () => true,
  };
}

async function fetchGuardrailEvents(orgId: string, stage: string) {
  const db = getTestDb();
  return db<{
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
      AND origin_type = ${`guardrail-${stage}`}
    ORDER BY id DESC
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// ChatResponseBridge (output stage)
// ─────────────────────────────────────────────────────────────────────────

describe('ChatResponseBridge — wired output guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails Output Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    const configStore = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, {
        guardrails: ['secret-scan'],
        updatedAt: Date.now(),
      });
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('blocks a delta containing a full secret, posts the block message, audits the trip', async () => {
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId);
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    bridge.setGuardrails(registry, settingsStore);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: {
        connectionId: 'conn-1',
        chatId: '123',
        // agentId omitted on purpose — fallback to connection.agentId
        // organizationId omitted on purpose — fallback to connection.organizationId
      },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleDelta(
        { ...payload, delta: 'here is sk-abcdefghij0123456789AB please' },
        'session-1'
      );
    });

    // The capturing target should have received exactly the block message,
    // not the leaked delta.
    expect(posted).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Message blocked by guardrail'),
      }),
    ]);
    expect(posted[0]?.text).toMatch(/openai-key/);

    await flushPendingGuardrailAudits();

    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
    expect(rows[0]!.metadata.stage).toBe('output');
    expect(rows[0]!.metadata.agent_id).toBe(agentId);
    expect(rows[0]!.metadata.conversation_id).toBe('123');
  });

  it('catches a secret split across two stream chunks via rolling buffer', async () => {
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId);
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    bridge.setGuardrails(registry, settingsStore);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
    };

    // First chunk doesn't contain the full pattern.
    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleDelta({ ...payload, delta: 'leaking sk-a' }, 's');
      // Second chunk, in isolation, doesn't match either. Only the
      // concatenation of (rolling tail + this delta) trips the regex.
      await bridge.handleDelta(
        { ...payload, delta: 'bcdefghij0123456789ABCD done' },
        's'
      );
    });

    const blockPost = posted.find((p) =>
      p.text?.startsWith('Message blocked by guardrail')
    );
    expect(blockPost).toBeDefined();
    expect(blockPost!.text).toMatch(/openai-key/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
  });

  it('isFullReplacement clears the rolling tail before scanning (no false positive across replacement)', async () => {
    // Regression: scanning ran BEFORE the fullReplacement dispose, so the
    // tail still contained the prior delta and the next scan operated on
    // (prior-delta + replacement-text), synthesizing matches that exist
    // in neither piece alone. The fix moves the replacement handling
    // ahead of the scan + tail-update.
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId);
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(
      createPostgresAgentConfigStore()
    );
    bridge.setGuardrails(registry, settingsStore);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
    };

    // Choose two chunks that are individually safe but whose
    // concatenation matches the openai-key regex (`sk-` + 20+ alnum).
    //   prior:        "...ends with sk-a"
    //   replacement:  "bcdefghij0123456789AB starts fresh"
    // Pre-fix: tail = "...sk-a", scanText = tail + replacement → match.
    // Post-fix: replacement clears the tail first → scanText is just the
    // replacement, which does NOT match.
    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleDelta(
        { ...payload, delta: 'first reply ending with sk-a' },
        's-1'
      );
      // Second message arrives as a full replacement. Despite the prior
      // delta still being in the tail, the scan must run only against the
      // replacement text.
      await bridge.handleDelta(
        {
          ...payload,
          delta: 'bcdefghij0123456789AB starts fresh',
          isFullReplacement: true,
        },
        's-2'
      );
    });

    // No block message should have been posted — neither delta on its own
    // contains a secret, and the replacement properly resets the tail.
    const blockPost = posted.find((p) =>
      p.text?.startsWith('Message blocked by guardrail')
    );
    expect(blockPost).toBeUndefined();

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(0);
  });

  it('audits the trip even when platformMetadata.organizationId is missing (connection fallback)', async () => {
    const { target } = createCapturingTarget();
    // Build a manager whose connection carries the org id — this is the
    // canonical fallback for response-bridge audits.
    const manager = {
      getInstance: () => ({
        connection: {
          agentId,
          organizationId: orgId,
          platform: 'telegram',
        },
        chat: {
          channel: () => target,
          getAdapter: () => undefined,
        },
      }),
      has: () => true,
    };
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    bridge.setGuardrails(registry, settingsStore);

    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      // No organizationId in metadata — bridge must resolve via the connection.
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleDelta(
        { ...payload, delta: 'token AKIAIOSFODNN7EXAMPLE leaked' },
        's'
      );
    });

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });

  it('scans payload.finalText at completion for a post-once (Slack) reply with no local stream (cross-replica)', async () => {
    // Under N>1 replicas the terminal row can be claimed by a pod that never
    // saw the delta rows, so the per-delta scan never ran here. The Slack
    // completion path delivers payload.finalText, so it must be scanned at
    // completion or a secret would post unguarded. No handleDelta is called —
    // this mirrors the cross-pod terminal-only delivery.
    const { target, posted } = createCapturingTarget();
    const slackPostMessage = vi.fn(async () => ({ ok: true, ts: '1.1' }));
    const manager = {
      getInstance: () => ({
        connection: { agentId, organizationId: orgId, platform: 'slack' },
        chat: {
          channel: () => target,
          getAdapter: (name: string) =>
            name === 'slack'
              ? { client: { chat: { postMessage: slackPostMessage } } }
              : undefined,
        },
        conversationState: undefined,
      }),
      has: () => true,
    };
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    bridge.setGuardrails(registry, settingsStore);

    const payload = {
      messageId: 'm1',
      channelId: 'slack:C123',
      conversationId: 'slack:C123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'slack',
      platformMetadata: { connectionId: 'conn-1', chatId: 'slack:C123' },
      finalText: 'here is sk-abcdefghij0123456789AB please',
      processedMessageIds: ['m1'],
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleCompletion(payload, 's');
    });

    // The secret must NOT reach Slack; only the block message is posted.
    expect(slackPostMessage).not.toHaveBeenCalled();
    expect(posted).toEqual([
      expect.objectContaining({
        text: expect.stringContaining('Message blocked by guardrail'),
      }),
    ]);
    expect(posted[0]?.text).toMatch(/openai-key/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });

  it('scans finalText at completion for a LIVE-STREAMING (telegram) reply — catches a secret longer than the per-delta window', async () => {
    // Regression: the completion full-text scan was gated on
    // `deliversAtCompletion`, so live-streaming platforms (telegram) only had
    // the bounded per-delta window. A secret LONGER than that window trips no
    // per-delta scan and previously landed in history unscanned. The completion
    // scan now runs for every strategy.
    const { target, posted } = createCapturingTarget();
    const manager = createManager(target, agentId, orgId); // telegram = live-streaming
    const bridge = new ChatResponseBridge(manager as any);

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(
      createPostgresAgentConfigStore()
    );
    bridge.setGuardrails(registry, settingsStore);

    // A JWT well over the 512-char per-delta window — only the full-text
    // completion scan can see it whole. No handleDelta is called.
    const longJwt = `eyJhbGciOiJSUzI1NiJ9.eyJ${'A'.repeat(900)}.${'S'.repeat(342)}`;
    const payload = {
      messageId: 'm1',
      channelId: '123',
      conversationId: '123',
      userId: 'u1',
      teamId: 't1',
      timestamp: 0,
      platform: 'telegram',
      platformMetadata: { connectionId: 'conn-1', chatId: '123' },
      finalText: `your token is ${longJwt}`,
      processedMessageIds: ['m1'],
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await bridge.handleCompletion(payload as any, 's');
    });

    const blockPost = posted.find((p) =>
      p.text?.startsWith('Message blocked by guardrail')
    );
    expect(blockPost).toBeDefined();
    expect(blockPost!.text).toMatch(/jwt/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MessageConsumer (input stage)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sub-class that exposes `handleMessage` for direct invocation. Production
 * paths reach it via the queue subscribe callback in `start()`; for tests
 * we don't need the actual queue/worker startup machinery, just the wired
 * call site.
 */
class TestableMessageConsumer extends MessageConsumer {
  async invokeHandleMessage(job: { id?: string; data: any }): Promise<void> {
    return (this as any).handleMessage(job);
  }
}

/**
 * The shipped built-ins are stage-specific: `secret-scan` is output-stage,
 * `forbidden-tools` is pre-tool. To exercise the wired MessageConsumer
 * input path without falsifying its shape, we register a minimal test-only
 * input guardrail that trips on any message containing "SECRET".
 */
const testInputGuardrail: Guardrail<'input'> = {
  name: 'test-input-tripper',
  stage: 'input',
  async run(ctx) {
    if (ctx.message.includes('SECRET')) {
      return {
        tripped: true,
        reason: 'test-input-tripper saw "SECRET"',
        metadata: { stage: 'input' },
      };
    }
    return { tripped: false };
  },
};

describe('MessageConsumer — wired input guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails Input Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    const configStore = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, {
        guardrails: ['test-input-tripper'],
        updatedAt: Date.now(),
      });
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('rejects a tripping input, pushes block message to the response queue, audits the trip', async () => {
    const sentToQueue: Array<{ queue: string; data: any }> = [];
    const fakeQueue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      send: async (queue: string, data: any) => {
        sentToQueue.push({ queue, data });
        return 'job-id';
      },
      work: async () => {},
      pauseWorker: async () => {},
      resumeWorker: async () => {},
      getQueueStats: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
      }),
      isHealthy: () => true,
    };

    // Stub deployment manager — happy-path branches need it for
    // listDeployments / scaleDeployment / etc, but the trip path
    // short-circuits before any of those are called.
    const fakeDeployments: BaseDeploymentManager = {
      listDeployments: async () => [],
      scaleDeployment: async () => {},
      updateDeploymentActivity: async () => {},
      createWorkerDeployment: async () => {},
      syncNetworkConfigGrants: async () => {},
      deleteDeployment: async () => {},
      validateWorkerImage: async () => {},
      setSecretStore: () => {},
      setGrantStore: () => {},
      setPolicyStore: () => {},
      setProviderCatalogService: () => {},
      setProviderModules: () => {},
      reconcileDeployments: async () => {},
      invalidateGrantSyncCache: () => {},
      clearAllGrantSyncCaches: () => {},
    } as unknown as BaseDeploymentManager;

    const config: OrchestratorConfig = {
      queues: { retryLimit: 1, expireInSeconds: 60 },
      cleanup: { initialDelayMs: 1_000_000, intervalMs: 1_000_000 },
    } as OrchestratorConfig;

    const consumer = new TestableMessageConsumer(config, fakeDeployments);
    // Swap in the fake queue — `MessageConsumer` constructs a RunsQueue
    // by default which would try to connect.
    (consumer as any).queue = fakeQueue;

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    registry.register(testInputGuardrail);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    consumer.setGuardrails(registry, settingsStore);

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.invokeHandleMessage({
        id: '1',
        data: {
          userId: 'u1',
          conversationId: 'conv-1',
          messageId: 'm1',
          channelId: 'c1',
          teamId: 't1',
          agentId,
          organizationId: orgId,
          botId: 'bot',
          platform: 'telegram',
          messageText: 'hello SECRET world',
          platformMetadata: {},
          agentOptions: {},
        },
      });
    });

    // The trip path must NOT enqueue to the worker thread queue and MUST
    // enqueue a single thread_response with the rejection. The notice rides the
    // `error` field (not `content`): routeToRenderer has no plain-`content`
    // branch, so a `content`-only payload is dropped — `error` renders
    // end-to-end (SSE error event + CLI exit 1; platforms post `Error: …`).
    const threadResponses = sentToQueue.filter(
      (q) => q.queue === 'thread_response'
    );
    const workerEnqueues = sentToQueue.filter((q) =>
      q.queue.startsWith('thread_message_')
    );
    expect(workerEnqueues.length).toBe(0);
    expect(threadResponses.length).toBe(1);
    expect(threadResponses[0]!.data.error).toMatch(/Message rejected:/);
    expect(threadResponses[0]!.data.error).toMatch(/SECRET/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'input');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('test-input-tripper');
  });

  it('falls back to agent-metadata orgId when payload omits organizationId', async () => {
    const sentToQueue: Array<{ queue: string; data: any }> = [];
    const fakeQueue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      send: async (queue: string, data: any) => {
        sentToQueue.push({ queue, data });
        return 'job-id';
      },
      work: async () => {},
      pauseWorker: async () => {},
      resumeWorker: async () => {},
      getQueueStats: async () => ({
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
      }),
      isHealthy: () => true,
    };
    const fakeDeployments = {
      listDeployments: async () => [],
    } as unknown as BaseDeploymentManager;

    const consumer = new TestableMessageConsumer(
      { queues: { retryLimit: 1, expireInSeconds: 60 } } as OrchestratorConfig,
      fakeDeployments
    );
    (consumer as any).queue = fakeQueue;

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    registry.register(testInputGuardrail);
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());
    consumer.setGuardrails(registry, settingsStore);

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.invokeHandleMessage({
        id: '1',
        data: {
          userId: 'u1',
          conversationId: 'conv-1',
          messageId: 'm1',
          channelId: 'c1',
          teamId: 't1',
          agentId,
          // organizationId intentionally absent — exercises metadata fallback
          botId: 'bot',
          platform: 'telegram',
          messageText: 'leaking SECRET data',
          platformMetadata: {},
          agentOptions: {},
        },
      });
    });

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'input');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('test-input-tripper');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// McpProxy (pre-tool stage)
// ─────────────────────────────────────────────────────────────────────────

describe('McpProxy — wired pre-tool guardrail', () => {
  let orgId: string;
  let agentId: string;

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({
      name: 'Guardrails Pre-Tool Org',
    });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    const configStore = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, {
        guardrails: ['forbidden-tools'],
        updatedAt: Date.now(),
      });
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('blocks a forbidden tool with generic policy text and audits the trip', async () => {
    // Minimal McpConfigSource that always returns an HTTP server config —
    // we don't need real upstream behavior, only the gate before forwardRequest.
    const fakeConfigService = {
      getHttpServer: async () => ({
        url: 'http://upstream.invalid/mcp',
        type: 'http' as const,
      }),
      getAllHttpServers: async () => new Map(),
    };

    const defaultSecretStore = new PostgresSecretStore();
    const secretStore = new SecretStoreRegistry(defaultSecretStore, {
      secret: defaultSecretStore,
    });
    const grantStore = new GrantStore();
    const settingsStore = new AgentSettingsStore(createPostgresAgentConfigStore());

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const proxy = new McpProxy(fakeConfigService as any, {
      secretStore,
      grantStore,
      agentSettingsStore: settingsStore,
      guardrailRegistry: registry,
    });

    // Mint a real worker token (uses ENCRYPTION_KEY set by global setup).
    const token = generateWorkerToken('u1', 'conv-1', 'deployment-1', {
      channelId: 'c1',
      teamId: 't1',
      agentId,
      organizationId: orgId,
      platform: 'telegram',
    });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'delete_repo', arguments: { repo: 'org/x' } },
    });

    const response = await orgContext.run(
      { organizationId: orgId },
      async () => {
        return proxy.getApp().fetch(
          new Request('http://localhost/test-mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body,
          })
        );
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(42);
    expect(json.result.isError).toBe(true);
    // Generic text — no reason leak.
    expect(json.result.content[0].text).toBe('Tool call blocked by policy.');
    expect(json.result.content[0].text).not.toMatch(/delete_repo/);

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'pre-tool');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('forbidden-tools');
    // Reason is recorded in the audit row even though it's not surfaced
    // to the worker — operators need it.
    expect(rows[0]!.metadata.reason).toMatch(/delete_repo/);
  });

  it('rejects a JSON-RPC BATCH wrapping a forbidden tools/call instead of forwarding it unguarded', async () => {
    // Regression: the pre-tool gate only fired when `jsonRpc.method` was
    // "tools/call". A top-level JSON-RPC array (batch) has `method` undefined,
    // so the whole guardrail + approval block was skipped and the raw batch was
    // forwarded verbatim — a spec-compliant upstream then executes the batched
    // tool call with zero enforcement. The fix rejects any batch containing a
    // tools/call at the proxy (-32600) rather than forwarding it.
    const fakeConfigService = {
      // Unresolvable upstream: if the batch were ever forwarded (pre-fix) the
      // fetch would fail with -32603 "Failed to connect", NOT our -32600. So a
      // -32600 invalid-request response proves the gate rejected it pre-forward.
      getHttpServer: async () => ({
        url: 'http://upstream.invalid/mcp',
        type: 'http' as const,
      }),
      getAllHttpServers: async () => new Map(),
    };

    const defaultSecretStore = new PostgresSecretStore();
    const secretStore = new SecretStoreRegistry(defaultSecretStore, {
      secret: defaultSecretStore,
    });
    const grantStore = new GrantStore();
    const settingsStore = new AgentSettingsStore(
      createPostgresAgentConfigStore()
    );

    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);

    const proxy = new McpProxy(fakeConfigService as any, {
      secretStore,
      grantStore,
      agentSettingsStore: settingsStore,
      guardrailRegistry: registry,
    });

    const token = generateWorkerToken('u1', 'conv-1', 'deployment-1', {
      channelId: 'c1',
      teamId: 't1',
      agentId,
      organizationId: orgId,
      platform: 'telegram',
    });

    // Top-level ARRAY (JSON-RPC batch) wrapping the forbidden tool call.
    const body = JSON.stringify([
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'delete_repo', arguments: { repo: 'org/x' } },
      },
    ]);

    const response = await orgContext.run(
      { organizationId: orgId },
      async () => {
        return proxy.getApp().fetch(
          new Request('http://localhost/test-mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
            },
            body,
          })
        );
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.jsonrpc).toBe('2.0');
    // Rejected at the proxy with an invalid-request error — NOT forwarded.
    expect(json.error?.code).toBe(-32600);
    expect(json.error?.message).toMatch(/Batched tools\/call is not permitted/);
    // The forbidden call never reached an upstream, so no -32603 connect error.
    expect(json.error?.message).not.toMatch(/Failed to connect/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// UnifiedThreadResponseConsumer → ApiResponseRenderer (output stage)
//
// Regression: output guardrails were wired ONLY into ChatResponseBridge, so
// pure API/SSE rows (web SPA + programmatic Agent API) — which route through
// ApiResponseRenderer — streamed secrets/PII to the client uninspected and
// never wrote a guardrail-trip event. These tests drive the real consumer +
// real ApiResponseRenderer over an API row and assert the secret is blocked.
// ─────────────────────────────────────────────────────────────────────────

describe('UnifiedThreadResponseConsumer — wired output guardrail (API path)', () => {
  let orgId: string;
  let agentId: string;

  /** Capturing SSE manager: records every broadcast, owns every session. */
  function createCapturingSse() {
    const events: Array<{ sessionId: string; event: string; payload: any }> =
      [];
    const sse = {
      broadcast: (sessionId: string, event: string, payload: any) => {
        events.push({ sessionId, event, payload });
      },
      hasActiveConnection: () => true,
    };
    return { sse, events };
  }

  function createConsumer(sse: unknown) {
    const renderer = new ApiResponseRenderer(sse as any);
    const queue = {
      start: async () => {},
      stop: async () => {},
      createQueue: async () => {},
      work: async () => {},
      send: async () => 'job-id',
    };
    const platformRegistry = {
      get: () => ({ getResponseRenderer: () => renderer }),
    };
    const consumer = new UnifiedThreadResponseConsumer(
      queue as any,
      platformRegistry as any,
      sse as any
    ) as any;
    const registry = new GuardrailRegistry();
    registerBuiltinGuardrails(registry);
    const settingsStore = new AgentSettingsStore(
      createPostgresAgentConfigStore()
    );
    consumer.setOutputGuardrails(registry, settingsStore);
    return consumer;
  }

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Guardrails API Org' });
    orgId = org.id;
    const agent = await createTestAgent({ organizationId: orgId });
    agentId = agent.agentId;

    const configStore = createPostgresAgentConfigStore();
    await orgContext.run({ organizationId: orgId }, async () => {
      await configStore.saveSettings(agentId, {
        guardrails: ['secret-scan'],
        updatedAt: Date.now(),
      });
    });
  });

  afterAll(async () => {
    const db = getTestDb();
    await db`TRUNCATE agents CASCADE`;
  });

  it('blocks a secret in the terminal finalText, broadcasts the block message instead, audits the trip', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      processedMessageIds: ['m1'],
      finalText: 'your key is sk-abcdefghij0123456789AB please',
      platformMetadata: { agentId, organizationId: orgId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    const complete = events.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    // The SPA repairs its message from finalText on `complete` — it must be the
    // block notice, NOT the leaked secret.
    expect(complete!.payload.finalText).toContain(
      'Message blocked by guardrail'
    );
    expect(complete!.payload.finalText).not.toContain(
      'sk-abcdefghij0123456789AB'
    );

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(1);
    expect(rows[0]!.metadata.guardrail).toBe('secret-scan');
    expect(rows[0]!.metadata.stage).toBe('output');
    expect(rows[0]!.metadata.agent_id).toBe(agentId);
  });

  it('withholds ALL streaming deltas for a guardrail-enabled agent (cross-pod split-secret cannot leak)', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    // Even a delta that LOOKS clean is withheld — a secret could be split across
    // deltas claimed on different replicas, which no per-pod scan would catch.
    // The scanned finalText is delivered at completion instead.
    for (const delta of ['here it is ', 'sk-abcdefghij', '0123456789AB done']) {
      await orgContext.run({ organizationId: orgId }, async () => {
        await consumer.handleThreadResponse({
          id: '1',
          data: {
            messageId: 'm1',
            channelId: 'api:conv-1',
            conversationId: 'conv-1',
            originalMessageId: 'm1',
            userId: 'u1',
            teamId: 'api',
            platform: 'api',
            timestamp: 0,
            delta,
            platformMetadata: { agentId, organizationId: orgId },
          },
        });
      });
    }

    // No delta reaches the client as an `output` event.
    expect(events.filter((e) => e.event === 'output').length).toBe(0);
  });

  it('streams deltas normally for an agent with NO output guardrails', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    // A separate agent with no guardrails configured — streaming is unaffected.
    const plain = await createTestAgent({ organizationId: orgId });

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({
        id: '1',
        data: {
          messageId: 'm2',
          channelId: 'api:conv-2',
          conversationId: 'conv-2',
          originalMessageId: 'm2',
          userId: 'u1',
          teamId: 'api',
          platform: 'api',
          timestamp: 0,
          delta: 'streaming token',
          platformMetadata: { agentId: plain.agentId, organizationId: orgId },
        },
      });
    });

    const outputs = events.filter((e) => e.event === 'output');
    expect(outputs.length).toBe(1);
    expect(outputs[0]!.payload.content).toBe('streaming token');
  });

  it('passes a clean finalText through unchanged (no false block)', async () => {
    const { sse, events } = createCapturingSse();
    const consumer = createConsumer(sse);

    const payload = {
      messageId: 'm1',
      channelId: 'api:conv-1',
      conversationId: 'conv-1',
      userId: 'u1',
      teamId: 'api',
      platform: 'api',
      timestamp: 0,
      processedMessageIds: ['m1'],
      finalText: 'here is a perfectly normal reply with no secrets',
      platformMetadata: { agentId, organizationId: orgId },
    };

    await orgContext.run({ organizationId: orgId }, async () => {
      await consumer.handleThreadResponse({ id: '1', data: payload });
    });

    const complete = events.find((e) => e.event === 'complete');
    expect(complete).toBeDefined();
    expect(complete!.payload.finalText).toBe(
      'here is a perfectly normal reply with no secrets'
    );

    await flushPendingGuardrailAudits();
    const rows = await fetchGuardrailEvents(orgId, 'output');
    expect(rows.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Reset for global test isolation
// ─────────────────────────────────────────────────────────────────────────

afterEach(async () => {
  // Drain anything still in flight so it doesn't leak into the next test.
  await flushPendingGuardrailAudits();
});
