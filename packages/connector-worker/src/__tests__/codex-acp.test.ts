import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSessionEntries } from '@lobu/core';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun } from '../daemon/automation.js';
import { type ExecutorClient, WorkerClient } from '../daemon/client.js';
import { CodexAcpTranscript, runCodexAcpTurn } from '../daemon/codex-acp.js';

function fakeAcpAgent(dir: string): { script: string; trace: string } {
  const script = path.join(dir, 'fake-acp-agent.mjs');
  const trace = path.join(dir, 'trace.jsonl');
  writeFileSync(
    script,
    `import fs from 'node:fs';
import readline from 'node:readline';
const trace = process.env.FAKE_ACP_TRACE;
const waiting = new Map();
const record = (value) => fs.appendFileSync(trace, JSON.stringify(value) + '\\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const response = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, value) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  record(message);
  if (message.method === 'initialize') {
    response(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {}, close: {} }
      },
      agentInfo: { name: 'fake-codex-acp', version: '1' }
    });
  } else if (message.method === 'session/new') {
    response(message.id, {
      sessionId: 'acp-new-session',
      modes: { currentModeId: 'read-only', availableModes: [
        { id: 'read-only', name: 'Read-only' },
        { id: 'agent', name: 'Agent' }
      ] },
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default', options: [{ value: 'gpt-test', name: 'GPT Test' }] },
        { id: 'reasoning_effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'high', name: 'High' }] }
      ]
    });
  } else if (message.method === 'session/resume') {
    response(message.id, {
      modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] },
      configOptions: []
    });
  } else if (message.method === 'session/set_mode') {
    response(message.id, {});
  } else if (message.method === 'session/set_config_option') {
    response(message.id, { configOptions: [] });
  } else if (message.method === 'session/prompt') {
    const sessionId = message.params.sessionId;
    if (process.env.FAKE_ACP_WAIT_FOR_CANCEL === '1') {
      waiting.set(sessionId, message.id);
      continue;
    }
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'private chain of thought' }, messageId: 'thought-1' });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read run context', kind: 'read', status: 'in_progress', rawInput: { run_id: 99 } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { ok: true } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP ' }, messageId: 'answer-1' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'finished' }, messageId: 'answer-1' });
    response(message.id, { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  } else if (message.method === 'session/cancel') {
    const id = waiting.get(message.params.sessionId);
    if (id !== undefined) {
      waiting.delete(message.params.sessionId);
      response(id, { stopReason: 'cancelled' });
    }
  } else if (message.method === 'session/close') {
    response(message.id, {});
  }
}
`,
    'utf8'
  );
  return { script, trace };
}

function traceLines(trace: string): Array<Record<string, unknown>> {
  return readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Codex ACP Automation turn', () => {
  test('routes the Mac Automation through ACP and uploads its terminal transcript', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-automation-'));
    const { script, trace } = fakeAcpAgent(dir);
    const checkpoints: unknown[] = [];
    const snapshots: Array<{ bearer: string; status: string; jsonl: string }> = [];
    const client = {
      id: 'macos:test',
      async heartbeat(_runId: number, _progress: unknown, session: unknown) {
        if (session) checkpoints.push(session);
      },
      async completeAutomation() {
        return { ok: true, status: 'completed', run_id: 99 };
      },
      async writeAutomationTranscript(
        _runId: number,
        bearer: string,
        status: string,
        jsonl: string
      ) {
        snapshots.push({ bearer, status, jsonl });
      },
    } as unknown as ExecutorClient;
    const job: PollResponse = {
      run_id: 99,
      run_type: 'automation',
      payload: {
        automation: {
          id: '42',
          name: 'ACP Automation',
          agent_kind: 'codex',
          prompt: 'Do the work.',
        },
        event: { fired_at: new Date().toISOString(), payload: {} },
        context: {
          device: { worker_id: 'macos:test' },
          user: {},
          agent_session: {
            conversation_id: 'agent_automation_42_run_99',
            mcp_url: 'https://lobu.test/mcp/team',
            token: 'run-scoped-token',
            expires_at: Date.now() + 60_000,
          },
        },
      },
    };
    try {
      const outcome = await executeAutomationRun(client, job, {
        requireRunScopedSession: true,
        timeoutMs: 5_000,
        codexAcp: {
          adapterCommand: process.execPath,
          adapterArgs: [script],
          adapterEnv: { FAKE_ACP_TRACE: trace },
          codexPath: '/usr/local/bin/codex',
        },
      });

      expect(outcome.error).toBeUndefined();
      expect(checkpoints).toEqual([
        { protocol: 'acp', agent_kind: 'codex', session_id: 'acp-new-session' },
      ]);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.bearer).toBe('run-scoped-token');
      expect(snapshots[0]?.status).toBe('completed');
      expect(snapshots[0]?.jsonl).toContain('ACP finished');
      expect(readFileSync(trace, 'utf8')).toContain('session/new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('creates a workspace-write session with HTTP MCP, model parity, and a safe transcript', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-'));
    const { script, trace } = fakeAcpAgent(dir);
    const ready: string[] = [];
    try {
      const result = await runCodexAcpTurn({
        adapterCommand: process.execPath,
        adapterArgs: [script],
        adapterEnv: { FAKE_ACP_TRACE: trace },
        codexPath: '/usr/local/bin/codex',
        cwd: dir,
        prompt: 'Finish Automation 99',
        mcp: { url: 'https://lobu.test/mcp/team', bearer: 'run-token' },
        model: 'gpt-test',
        effort: 'high',
        timeoutMs: 5_000,
        onSessionReady: async (sessionId) => ready.push(sessionId),
      });

      expect(result.exitReason).toBe('ok');
      expect(result.output).toBe('ACP finished');
      expect(result.sessionId).toBe('acp-new-session');
      expect(ready).toEqual(['acp-new-session']);

      const calls = traceLines(trace);
      const created = calls.find((line) => line.method === 'session/new') as {
        params: { cwd: string; mcpServers: Array<Record<string, unknown>> };
      };
      expect(created.params.cwd).toBe(dir);
      expect(created.params.mcpServers).toEqual([
        {
          type: 'http',
          name: 'lobu-memory',
          url: 'https://lobu.test/mcp/team',
          headers: [{ name: 'Authorization', value: 'Bearer run-token' }],
        },
      ]);
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'session/set_mode',
        params: { sessionId: 'acp-new-session', modeId: 'agent' },
      }));
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: { sessionId: 'acp-new-session', configId: 'model', value: 'gpt-test' },
      }));
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'session/set_config_option',
        params: { sessionId: 'acp-new-session', configId: 'reasoning_effort', value: 'high' },
      }));

      const parsed = parseSessionEntries(result.transcriptJsonl);
      expect(parsed.sessionId).toBe('acp-new-session');
      expect(JSON.stringify(parsed.entries)).not.toContain('private chain of thought');
      expect(JSON.stringify(parsed.entries)).toContain('Read run context');
      expect(JSON.stringify(parsed.entries)).toContain('ACP finished');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('resumes the exact persisted session without listing local sessions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-resume-'));
    const { script, trace } = fakeAcpAgent(dir);
    try {
      const result = await runCodexAcpTurn({
        adapterCommand: process.execPath,
        adapterArgs: [script],
        adapterEnv: { FAKE_ACP_TRACE: trace },
        codexPath: '/usr/local/bin/codex',
        cwd: dir,
        prompt: 'Continue the run',
        mcp: { url: 'https://lobu.test/mcp/team', bearer: 'run-token' },
        resumeSessionId: 'persisted-session-99',
        timeoutMs: 5_000,
        onSessionReady: async () => {},
      });

      expect(result.sessionId).toBe('persisted-session-99');
      const calls = traceLines(trace);
      expect(calls.some((line) => line.method === 'session/new')).toBe(false);
      expect(calls.some((line) => line.method === 'session/list')).toBe(false);
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'session/resume',
        params: expect.objectContaining({ sessionId: 'persisted-session-99' }),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('cancels the ACP prompt and tears down the adapter tree on shutdown', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-cancel-'));
    const { script, trace } = fakeAcpAgent(dir);
    const controller = new AbortController();
    try {
      const running = runCodexAcpTurn({
        adapterCommand: process.execPath,
        adapterArgs: [script],
        adapterEnv: { FAKE_ACP_TRACE: trace, FAKE_ACP_WAIT_FOR_CANCEL: '1' },
        codexPath: '/usr/local/bin/codex',
        cwd: dir,
        prompt: 'Wait until cancelled',
        mcp: { url: 'https://lobu.test/mcp/team', bearer: 'run-token' },
        timeoutMs: 10_000,
        abortSignal: controller.signal,
        onSessionReady: async () => {},
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(trace) && readFileSync(trace, 'utf8').includes('session/prompt')) break;
        await Bun.sleep(20);
      }
      controller.abort();
      const result = await running;

      expect(result.exitReason).toBe('cancelled');
      expect(traceLines(trace).some((line) => line.method === 'session/cancel')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('classifies an ACP deadline separately from daemon cancellation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-timeout-'));
    const { script, trace } = fakeAcpAgent(dir);
    try {
      const result = await runCodexAcpTurn({
        adapterCommand: process.execPath,
        adapterArgs: [script],
        adapterEnv: { FAKE_ACP_TRACE: trace, FAKE_ACP_WAIT_FOR_CANCEL: '1' },
        codexPath: '/usr/local/bin/codex',
        cwd: dir,
        prompt: 'Wait until the deadline',
        mcp: { url: 'https://lobu.test/mcp/team', bearer: 'run-token' },
        timeoutMs: 50,
        onSessionReady: async () => {},
      });

      expect(result.exitReason).toBe('timeout');
      expect(result.error).toContain('timed out');
      expect(traceLines(trace).some((line) => line.method === 'session/cancel')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('each finalize round uploads a byte-exact prefix extension', async () => {
    const transcript = new CodexAcpTranscript('/workspace');
    transcript.setSession('acp-multi-round');
    transcript.appendTurn('first prompt', [
      { kind: 'assistant', messageId: 'm1', text: 'round one' },
    ]);
    const firstUpload = transcript.toJsonl();
    // The server's snapshot upsert only accepts a continuation that extends the
    // stored bytes exactly, so the frozen session header must not drift.
    await Bun.sleep(1_100);
    transcript.appendTurn('finalize nudge', [
      { kind: 'assistant', messageId: 'm2', text: 'round two' },
    ]);
    const secondUpload = transcript.toJsonl();

    expect(secondUpload.startsWith(firstUpload)).toBe(true);
    expect(secondUpload).toContain('round two');
  });

  test('a rejected resume surfaces the adapter error, not a serialization throw', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lobu-codex-acp-resume-fail-'));
    const script = path.join(dir, 'rejecting-agent.mjs');
    writeFileSync(
      script,
      `import readline from 'node:readline';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'rejecting-agent', version: '1' }
    } });
  } else if (message.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'no such session' } });
  }
}
`,
      'utf8'
    );
    try {
      const result = await runCodexAcpTurn({
        adapterCommand: process.execPath,
        adapterArgs: [script],
        codexPath: '/usr/local/bin/codex',
        cwd: dir,
        prompt: 'Continue a session the agent lost',
        mcp: { url: 'https://lobu.test/mcp/team', bearer: 'run-token' },
        resumeSessionId: 'session-the-agent-forgot',
        timeoutMs: 5_000,
        onSessionReady: async () => {},
      });

      expect(result.exitReason).toBe('crash');
      expect(result.error).toContain('no such session');
      expect(result.transcriptJsonl).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('WorkerClient uploads with the run token, never the device PAT', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: 1 });
    }) as typeof fetch;
    try {
      const client = new WorkerClient({
        apiUrl: 'https://lobu.test/',
        workerId: 'macos:test',
        authToken: 'device-pat-must-not-cross',
        capabilities: { 'automations.execute': true },
      });
      await client.writeAutomationTranscript(
        99,
        'run-scoped-token',
        'completed',
        '{"type":"session","id":"acp"}\n'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toEqual([
      {
        url: 'https://lobu.test/worker/transcript/snapshot',
        authorization: 'Bearer run-scoped-token',
        body: {
          runId: 99,
          terminalStatus: 'completed',
          snapshotJsonl: '{"type":"session","id":"acp"}\n',
        },
      },
    ]);
  });
});
