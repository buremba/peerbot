/**
 * OpenAI-compatible fake LLM server for end-to-end tests.
 *
 * Why this exists: the Lobu agent loop talks to providers via pi-ai using the
 * OpenAI Chat Completions wire format. Real e2e tests previously needed a
 * paid provider key (ZAI_API_KEY etc.). This fake stands in for any such
 * provider so CI can drive a full agent loop with no external dependency.
 *
 * It speaks just enough of the OpenAI API to satisfy pi-ai:
 *   - `GET  /v1/models`              — list known models
 *   - `POST /v1/chat/completions`    — non-streaming + SSE streaming response
 *
 * Responses are scripted by the test: a queue of canned reply texts is set on
 * the server before each agent run; each completion request consumes one
 * scripted reply, and a request-history buffer lets the test assert which
 * messages the agent actually sent.
 *
 * The fake is intentionally dumb. It does NOT:
 *   - Honor temperature/top_p/etc.
 *   - Implement structured outputs / response_format
 *
 * It DOES (added for provider-integration coverage):
 *   - Record the `Authorization` header of every request, so tests can assert
 *     the gateway's secret-proxy actually injected a credential (the layer most
 *     likely to silently break when a provider's auth scheme changes).
 *   - Optionally enforce auth (`requireAuth: true`) — return 401 when no Bearer
 *     token is present, mirroring a real provider.
 *   - Emit OpenAI-format `tool_calls` when a scripted reply requests them, in
 *     both streaming and non-streaming mode, so the full agent tool-call loop
 *     can be exercised against a deterministic provider.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

export interface FakeChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
}

export interface FakeChatRequest {
  model: string;
  messages: FakeChatMessage[];
  stream?: boolean;
  /** Tool/function schemas the client offered (captured for assertions). */
  tools?: unknown[];
  /**
   * The `Authorization` header the request arrived with, lower-cased key.
   * Captured so tests can assert the secret-proxy injected a credential.
   * `null` when the request carried no Authorization header.
   */
  authorization?: string | null;
  // …other fields are accepted but ignored.
}

/** A single scripted tool call the assistant should emit. */
export interface FakeToolCall {
  /** Tool/function name. */
  name: string;
  /** Arguments object (serialized to JSON) or a raw JSON string. */
  arguments?: Record<string, unknown> | string;
  /** Optional id; defaults to a generated `call_<n>`. */
  id?: string;
}

export interface FakeReply {
  /** Text the assistant returns (may be empty when emitting tool calls). */
  content: string;
  /**
   * Tool calls the assistant should emit. When present (and non-empty) the
   * default finish_reason becomes "tool_calls" and the message carries an
   * OpenAI-format `tool_calls` array.
   */
  tool_calls?: FakeToolCall[];
  /** Optional finish reason override (default: "stop", or "tool_calls"). */
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  /** Optional usage block. Defaults to zeros. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface FakeServerHandle {
  /** Base URL pi-ai should be configured with (no trailing slash). */
  url: string;
  /** Port the server is listening on. */
  port: number;
  /** Queue a reply (FIFO). Tests should queue at least one per expected turn. */
  enqueueReply(reply: string | FakeReply): void;
  /** Replace the queue wholesale. */
  setReplies(replies: Array<string | FakeReply>): void;
  /** Return every chat-completions request the server has received, oldest first. */
  requests(): FakeChatRequest[];
  /** Reset queue + history. */
  reset(): void;
  /** Stop the server. Idempotent. */
  close(): Promise<void>;
}

interface InternalState {
  replies: FakeReply[];
  history: FakeChatRequest[];
}

function normalizeReply(reply: string | FakeReply): FakeReply {
  return typeof reply === 'string' ? { content: reply } : reply;
}

/** Convert scripted tool calls to OpenAI `tool_calls` wire format. */
function toOpenAIToolCalls(calls: FakeToolCall[]): Array<{
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}> {
  return calls.map((call, i) => ({
    id: call.id ?? `call_${i}`,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
    },
  }));
}

function buildCompletion(model: string, reply: FakeReply): unknown {
  const hasToolCalls = !!reply.tool_calls?.length;
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: reply.content,
  };
  if (hasToolCalls) {
    message.tool_calls = toOpenAIToolCalls(reply.tool_calls!);
  }
  return {
    id: `chatcmpl-fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          reply.finish_reason ?? (hasToolCalls ? 'tool_calls' : 'stop'),
      },
    ],
    usage: {
      prompt_tokens: reply.usage?.prompt_tokens ?? 0,
      completion_tokens: reply.usage?.completion_tokens ?? 0,
      total_tokens:
        (reply.usage?.prompt_tokens ?? 0) +
        (reply.usage?.completion_tokens ?? 0),
    },
  };
}

function buildChunk(
  model: string,
  delta: {
    role?: string;
    content?: string;
    tool_calls?: Array<{
      index: number;
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  },
  finish_reason: string | null = null
): string {
  const payload = {
    id: `chatcmpl-fake-stream-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason }],
  };
  return JSON.stringify(payload);
}

/**
 * Start a fake LLM server on an ephemeral port.
 *
 * Bind to 127.0.0.1 by default — keeps the fake invisible to anything off the
 * test host even when the suite runs on a multi-tenant CI runner.
 */
export async function startFakeLlmServer(opts?: {
  hostname?: string;
  port?: number;
  /** Models to advertise in `/v1/models`. Default: ["fake-llm-1"]. */
  models?: string[];
  /**
   * When true, reject chat-completions requests that arrive without a Bearer
   * token with a 401 (mirrors a real provider). Off by default so existing
   * harness wiring that doesn't set a key keeps working.
   */
  requireAuth?: boolean;
}): Promise<FakeServerHandle> {
  const state: InternalState = { replies: [], history: [] };
  const models = opts?.models ?? ['fake-llm-1'];
  const requireAuth = opts?.requireAuth ?? false;

  const app = new Hono();

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'fake',
      })),
    })
  );

  // ─── Control plane ──────────────────────────────────────────────────────
  // Lets tests script replies / inspect history over HTTP without a direct
  // handle to the server object (e.g. when the fake is started by the
  // run-e2e.sh harness and tests run in their own process).

  app.post('/__control__/enqueue', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { reply?: string | FakeReply; replies?: Array<string | FakeReply> }
      | null;
    if (!body) return c.json({ error: 'invalid JSON' }, 400);
    if (Array.isArray(body.replies)) {
      for (const r of body.replies) state.replies.push(normalizeReply(r));
    } else if (body.reply !== undefined) {
      state.replies.push(normalizeReply(body.reply));
    } else {
      return c.json({ error: 'expected `reply` or `replies`' }, 400);
    }
    return c.json({ queued: state.replies.length });
  });

  app.post('/__control__/reset', (c) => {
    state.replies = [];
    state.history = [];
    return c.json({ ok: true });
  });

  app.get('/__control__/history', (c) => c.json(state.history));

  app.post('/v1/chat/completions', async (c) => {
    const authorization = c.req.header('authorization') ?? null;

    if (requireAuth && !authorization?.toLowerCase().startsWith('bearer ')) {
      return c.json(
        {
          error: {
            message:
              'fake-llm-server: missing or malformed Authorization header',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401
      );
    }

    let body: FakeChatRequest;
    try {
      body = (await c.req.json()) as FakeChatRequest;
    } catch {
      return c.json({ error: { message: 'invalid JSON', type: 'fake' } }, 400);
    }
    // Record the auth header alongside the body so tests can assert the
    // secret-proxy injected a credential without exposing it elsewhere.
    state.history.push({ ...body, authorization });

    const reply = state.replies.shift();
    if (!reply) {
      // Don't crash the client — return a clear error so the test sees it.
      return c.json(
        {
          error: {
            message:
              'fake-llm-server: no scripted reply queued — call enqueueReply() before driving the agent',
            type: 'fake',
          },
        },
        503
      );
    }

    if (body.stream) {
      const hasToolCalls = !!reply.tool_calls?.length;
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          data: buildChunk(body.model, { role: 'assistant', content: '' }),
        });
        if (reply.content) {
          await stream.writeSSE({
            data: buildChunk(body.model, { content: reply.content }),
          });
        }
        if (hasToolCalls) {
          // Stream each tool call in its own chunk with an index, as real
          // providers do; await in order so deltas arrive sequentially.
          const calls = toOpenAIToolCalls(reply.tool_calls!);
          for (let index = 0; index < calls.length; index++) {
            await stream.writeSSE({
              data: buildChunk(body.model, {
                tool_calls: [{ index, ...calls[index]! }],
              }),
            });
          }
        }
        await stream.writeSSE({
          data: buildChunk(
            body.model,
            {},
            reply.finish_reason ?? (hasToolCalls ? 'tool_calls' : 'stop')
          ),
        });
        await stream.writeSSE({ data: '[DONE]' });
      });
    }

    return c.json(buildCompletion(body.model, reply));
  });

  return new Promise<FakeServerHandle>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: opts?.hostname ?? '127.0.0.1',
        port: opts?.port ?? 0,
      },
      (info) => {
        const port = info.port;
        const url = `http://${opts?.hostname ?? '127.0.0.1'}:${port}`;
        resolve({
          url,
          port,
          enqueueReply(reply) {
            state.replies.push(normalizeReply(reply));
          },
          setReplies(replies) {
            state.replies = replies.map(normalizeReply);
          },
          requests() {
            return [...state.history];
          },
          reset() {
            state.replies = [];
            state.history = [];
          },
          close() {
            return new Promise<void>((done) => server.close(() => done()));
          },
        });
      }
    );
    server.on('error', reject);
  });
}
