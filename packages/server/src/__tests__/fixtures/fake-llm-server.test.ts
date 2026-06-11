import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FakeServerHandle,
  startFakeLlmServer,
} from './fake-llm-server';

let server: FakeServerHandle;

beforeAll(async () => {
  server = await startFakeLlmServer();
});

afterAll(async () => {
  await server.close();
});

describe('fake-llm-server', () => {
  it('exposes /v1/models with the configured model list', async () => {
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; object: string }>;
    };
    expect(body.data[0]?.id).toBe('fake-llm-1');
    expect(body.data[0]?.object).toBe('model');
  });

  it('returns a 503 with a clear error when no reply has been queued', async () => {
    server.reset();
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/no scripted reply queued/);
  });

  it('returns a non-streaming chat completion that consumes one queued reply', async () => {
    server.reset();
    server.enqueueReply('hi from the fake');
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-llm-1',
        messages: [{ role: 'user', content: 'say hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      model: string;
    };
    expect(body.model).toBe('fake-llm-1');
    expect(body.choices[0]?.message).toEqual({
      role: 'assistant',
      content: 'hi from the fake',
    });
    expect(body.choices[0]?.finish_reason).toBe('stop');

    // Second call after consuming → 503 again.
    const second = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
    });
    expect(second.status).toBe(503);
  });

  it('streams an SSE response that mirrors the canned reply chunked + a final [DONE] event', async () => {
    server.reset();
    server.enqueueReply({ content: 'streamed hi', finish_reason: 'stop' });
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-llm-1',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/event-stream/);

    const text = await res.text();
    // Three data: chunks plus the [DONE] terminator.
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines.length).toBeGreaterThanOrEqual(3);
    expect(dataLines.at(-1)).toBe('data: [DONE]');

    // Middle chunk carries the actual content delta.
    const contentChunks = dataLines
      .slice(0, -1)
      .map((l) => JSON.parse(l.slice('data: '.length)) as {
        choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
      });
    const reassembled = contentChunks
      .map((c) => c.choices[0]?.delta?.content ?? '')
      .join('');
    expect(reassembled).toBe('streamed hi');
    expect(contentChunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('records every chat-completions request in the history buffer', async () => {
    server.reset();
    server.setReplies(['a', 'b']);
    await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-llm-1',
        messages: [{ role: 'user', content: 'first' }],
      }),
    });
    await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-llm-1',
        messages: [{ role: 'user', content: 'second' }],
      }),
    });
    const history = server.requests();
    expect(history).toHaveLength(2);
    expect(history[0]?.messages[0]?.content).toBe('first');
    expect(history[1]?.messages[0]?.content).toBe('second');
  });

  describe('control plane', () => {
    it('enqueues replies via POST /__control__/enqueue (single)', async () => {
      server.reset();
      const res = await fetch(`${server.url}/__control__/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reply: 'remote-script' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { queued: number };
      expect(body.queued).toBe(1);

      const completion = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-llm-1',
          messages: [{ role: 'user', content: 'go' }],
        }),
      });
      const data = (await completion.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(data.choices[0]?.message.content).toBe('remote-script');
    });

    it('enqueues replies via POST /__control__/enqueue (batch)', async () => {
      server.reset();
      await fetch(`${server.url}/__control__/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replies: ['x', { content: 'y', finish_reason: 'length' }] }),
      });
      expect(server.requests()).toHaveLength(0);

      // Drain via two completions — first reply is "x", second is "y" with length finish.
      const r1 = await (
        await fetch(`${server.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
        })
      ).json() as { choices: Array<{ message: { content: string }; finish_reason: string }> };
      const r2 = await (
        await fetch(`${server.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
        })
      ).json() as { choices: Array<{ message: { content: string }; finish_reason: string }> };

      expect(r1.choices[0]?.message.content).toBe('x');
      expect(r2.choices[0]?.message.content).toBe('y');
      expect(r2.choices[0]?.finish_reason).toBe('length');
    });

    it('GET /__control__/history mirrors server.requests() and POST /__control__/reset clears state', async () => {
      server.reset();
      server.enqueueReply('pre');
      await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-llm-1',
          messages: [{ role: 'user', content: 'h1' }],
        }),
      });

      const histRes = await fetch(`${server.url}/__control__/history`);
      const hist = (await histRes.json()) as Array<{ messages: Array<{ content: string }> }>;
      expect(hist).toHaveLength(1);
      expect(hist[0]?.messages[0]?.content).toBe('h1');

      await fetch(`${server.url}/__control__/reset`, { method: 'POST' });
      expect(server.requests()).toHaveLength(0);
      expect(
        (await (await fetch(`${server.url}/__control__/history`)).json()) as unknown
      ).toEqual([]);
    });
  });

  // ── Provider-integration features ─────────────────────────────────────
  // Auth capture, optional auth enforcement, and OpenAI-format tool_calls.
  // These pin the wire shapes that the openclaw e2e harness drives an agent
  // loop through AND that live-providers/provider-smoke.test.ts asserts
  // against real providers — if the fake drifts from the OpenAI spec, the
  // smoke would be testing a fiction.
  describe('provider-integration features', () => {
    it('captures the Authorization header in request history', async () => {
      server.reset();
      server.enqueueReply('ok');
      await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer injected-by-proxy',
        },
        body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
      });
      expect(server.requests()[0]?.authorization).toBe('Bearer injected-by-proxy');
    });

    it('requireAuth rejects bearer-less requests with 401 without consuming the queue', async () => {
      const authServer = await startFakeLlmServer({ requireAuth: true });
      try {
        authServer.enqueueReply('queued-first');

        const denied = await fetch(`${authServer.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
        });
        expect(denied.status).toBe(401);
        const deniedBody = (await denied.json()) as { error: { code: string } };
        expect(deniedBody.error.code).toBe('invalid_api_key');

        // The 401 must not have consumed the queued reply.
        const ok = await fetch(`${authServer.url}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer k',
          },
          body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
        });
        const okBody = (await ok.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        expect(okBody.choices[0]?.message.content).toBe('queued-first');
      } finally {
        await authServer.close();
      }
    });

    it('emits OpenAI-format tool_calls (non-streaming)', async () => {
      server.reset();
      server.enqueueReply({
        content: '',
        tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }],
      });
      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
      });
      const body = (await res.json()) as {
        choices: Array<{
          message: {
            tool_calls?: Array<{
              id: string;
              type: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason: string;
        }>;
      };
      const choice = body.choices[0]!;
      expect(choice.finish_reason).toBe('tool_calls');
      expect(choice.message.tool_calls).toHaveLength(1);
      const call = choice.message.tool_calls![0]!;
      expect(call.type).toBe('function');
      expect(call.function.name).toBe('get_weather');
      // Arguments are serialized JSON, per the OpenAI spec.
      expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Paris' });
    });

    it('streams tool_calls as indexed deltas then a tool_calls finish', async () => {
      server.reset();
      server.enqueueReply({
        content: '',
        tool_calls: [{ id: 'call_a', name: 'lookup', arguments: '{"q":"x"}' }],
      });
      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-llm-1', messages: [], stream: true }),
      });
      const dataLines = (await res.text())
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice('data: '.length).trim());
      expect(dataLines.at(-1)).toBe('[DONE]');

      const chunks = dataLines.filter((l) => l !== '[DONE]').map(
        (l) =>
          JSON.parse(l) as {
            choices: Array<{
              delta: {
                tool_calls?: Array<{ index: number; function: { name: string } }>;
              };
              finish_reason: string | null;
            }>;
          }
      );
      const toolDelta = chunks.find((c) => c.choices[0]?.delta.tool_calls);
      expect(toolDelta?.choices[0]?.delta.tool_calls?.[0]?.index).toBe(0);
      expect(toolDelta?.choices[0]?.delta.tool_calls?.[0]?.function.name).toBe('lookup');
      expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason).toBe(
        'tool_calls'
      );
    });

    it('plain text replies still default to a stop finish with no tool_calls', async () => {
      server.reset();
      server.enqueueReply('hello');
      const res = await fetch(`${server.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-llm-1', messages: [] }),
      });
      const body = (await res.json()) as {
        choices: Array<{
          message: { content: string; tool_calls?: unknown };
          finish_reason: string;
        }>;
      };
      expect(body.choices[0]?.message.content).toBe('hello');
      expect(body.choices[0]?.message.tool_calls).toBeUndefined();
      expect(body.choices[0]?.finish_reason).toBe('stop');
    });
  });
});
