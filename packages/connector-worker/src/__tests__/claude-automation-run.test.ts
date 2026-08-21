import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachClaudeAutomation } from '../daemon/claude-attachments.js';
import { createAttachedClaudeRun } from '../daemon/claude-automation-run.js';
import { executeAutomationRun } from '../daemon/automation.js';
import { WorkerHttpError, type ExecutorClient } from '../daemon/client.js';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';

const cleanup: Array<() => Promise<void> | void> = [];

async function liveSession() {
  const root = mkdtempSync('/private/tmp/lac-');
  const socketPath = path.join(root, 'claude.sock');
  let handler: (content: string) => void = () => undefined;
  let live = true;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    live = false;
  };
  const pid = 5432;
  const procStart = 'Fri Aug 21 00:01:00 2026';
  const sessionId = 'attached-session';
  writeFileSync(
    path.join(root, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart,
      peerProtocol: 1,
      kind: 'interactive',
      messagingSocketPath: socketPath,
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    path.join(root, `${pid}.fixture.key`),
    JSON.stringify({ peerToken: 'claude-peer-token', procStart }),
    { mode: 0o600 }
  );
  cleanup.push(async () => {
    await close();
    rmSync(root, { recursive: true, force: true });
  });
  class FakeSocket extends EventEmitter {
    private readonly chunks: string[] = [];
    constructor() {
      super();
      queueMicrotask(() => this.emit('connect'));
    }
    setTimeout() { return this; }
    write(data: string, callback: (error?: Error) => void) {
      this.chunks.push(data.trim());
      queueMicrotask(() => callback());
      return true;
    }
    end(callback: () => void) {
      const frames = this.chunks.map((line) => JSON.parse(line));
      handler(frames[1].message.content);
      queueMicrotask(callback);
      return this;
    }
    destroy() { return this; }
  }
  return {
    root,
    close,
    procStart,
    sessionId,
    processStart: () => (live ? procStart : null),
    socketStat: () => ({ isSocket: () => live, uid: process.getuid?.() ?? 0 }),
    connect: () => new FakeSocket() as unknown as Socket,
    onMessage: (next: (content: string) => void) => {
      handler = next;
    },
  };
}

function onMessages(
  session: Awaited<ReturnType<typeof liveSession>>,
  handler: (content: string) => void
): void {
  session.onMessage(handler);
}

function finishInvocation(content: string): { helperPath: string; completionId: string } {
  const helperPath = content.match(/\/[^'\n]*\/lobu-run/)?.[0] ?? '';
  const completionId = content.match(/finish '([a-f0-9]{48})'/)?.[1] ?? '';
  expect(helperPath).not.toBe('');
  expect(completionId).toHaveLength(48);
  return { helperPath, completionId };
}

afterEach(async () => {
  for (const entry of cleanup.splice(0).reverse()) await entry();
});

describe('private attached-Claude run helper', () => {
  test('rejects non-absolute, unavailable, and shebang-unsafe Node runtimes', () => {
    const access = {
      wiring: { url: 'https://gateway.test/mcp', bearer: 'run-token' },
      env: {
        LOBU_API_TOKEN: 'run-token',
        LOBU_MEMORY_URL: 'https://gateway.test/mcp',
      },
    };
    for (const nodeExecutable of [
      'node',
      `/private/tmp/lobu-missing-node-${process.pid}`,
      '/bin/node\ninjected',
    ]) {
      expect(() =>
        createAttachedClaudeRun('session', access, {
          cliEntrypoint: process.argv[1]!,
          nodeExecutable,
        })
      ).toThrow();
    }
  });

  test('keeps credentials out of the prompt and returns bounded finish stdin as output', async () => {
    const session = await liveSession();
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'lobu-helper-cli-test-'));
    cleanup.push(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    const cli = path.join(fixtureRoot, 'fake-cli.js');
    const envLog = path.join(fixtureRoot, 'env.json');
    writeFileSync(
      cli,
      `require('node:fs').writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({ token: process.env.LOBU_API_TOKEN, url: process.env.LOBU_MEMORY_URL, worker: process.env.WORKER_API_TOKEN ?? null, args: process.argv.slice(2) }));\n`
    );

    const attached = createAttachedClaudeRun(
      session.sessionId,
      {
        wiring: { url: 'https://gateway.test/mcp', bearer: 'run-secret-token' },
        env: {
          LOBU_API_TOKEN: 'run-secret-token',
          LOBU_MEMORY_URL: 'https://gateway.test/mcp',
        },
      },
      {
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        cliEntrypoint: cli,
        nodeExecutable: process.execPath,
        pollIntervalMs: 10,
      }
    );
    let injected = '';
    let helperPath = '';
    let runDir = '';
    onMessages(session, (content) => {
      injected = content;
      const invocation = finishInvocation(content);
      helperPath = invocation.helperPath;
      runDir = path.dirname(helperPath);
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(statSync(helperPath).mode & 0o777).toBe(0o700);

      execFileSync(helperPath, ['memory', 'exec', 'script'], {
        env: { ...process.env, PATH: '' },
      });
      expect(JSON.parse(readFileSync(envLog, 'utf8'))).toEqual({
        token: 'run-secret-token',
        url: 'https://gateway.test/mcp',
        worker: null,
        args: ['memory', 'exec', 'script'],
      });

      execFileSync(helperPath, ['finish', invocation.completionId], {
        env: { ...process.env, PATH: '' },
        input: 'final result for ChatGPT',
      });
    });
    const result = await attached.run('EXACT EXISTING PROMPT', 2000);
    expect(result.exitReason).toBe('ok');
    expect(result.output).toBe('final result for ChatGPT');
    expect(injected).toContain('EXACT EXISTING PROMPT');
    expect(injected).toContain('externally delivered Lobu Automation');
    expect(injected).toContain('final user-visible result on stdin');
    expect(injected).not.toContain('run-secret-token');
    expect(injected).not.toContain('claude-peer-token');

    attached.cleanup();
    expect(() => statSync(runDir)).toThrow();
  });

  test('a timed-out turn\'s late finish never answers the next attempt', async () => {
    const session = await liveSession();
    const attached = createAttachedClaudeRun(
      session.sessionId,
      {
        wiring: { url: 'https://gateway.test/mcp', bearer: 'run-token' },
        env: {
          LOBU_API_TOKEN: 'run-token',
          LOBU_MEMORY_URL: 'https://gateway.test/mcp',
        },
      },
      {
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        cliEntrypoint: process.argv[1]!,
        pollIntervalMs: 10,
      }
    );

    // Attempt 1 times out while its Claude turn keeps running — Lobu cannot
    // cancel that turn, so it still holds the helper it was handed.
    let orphanedHelper = '';
    let orphanedCompletionId = '';
    onMessages(session, (content) => {
      const invocation = finishInvocation(content);
      orphanedHelper = invocation.helperPath;
      orphanedCompletionId = invocation.completionId;
    });
    const first = await attached.run('first prompt', 300);
    expect(first.exitReason).toBe('timeout');
    expect(orphanedHelper).not.toBe('');

    // The orphan finally reports, after attempt 2 has already been injected.
    onMessages(session, (content) => {
      const current = finishInvocation(content);
      expect(current.helperPath).toBe(orphanedHelper);
      expect(current.completionId).not.toBe(orphanedCompletionId);
      execFileSync(orphanedHelper, ['finish', orphanedCompletionId], {
        input: 'stale attempt-1 answer',
      });
      setTimeout(() => {
        execFileSync(current.helperPath, ['finish', current.completionId], {
          input: 'current attempt answer',
        });
      }, 50);
    });
    const second = await attached.run('second prompt', 700);
    expect(second.output).toBe('current attempt answer');
    expect(second.exitReason).toBe('ok');
    attached.cleanup();
  });

  test('caps oversized finish output and marks it truncated', async () => {
    const session = await liveSession();
    const attached = createAttachedClaudeRun(
      session.sessionId,
      {
        wiring: { url: 'https://gateway.test/mcp', bearer: 'run-token' },
        env: {
          LOBU_API_TOKEN: 'run-token',
          LOBU_MEMORY_URL: 'https://gateway.test/mcp',
        },
      },
      {
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        cliEntrypoint: process.argv[1]!,
        pollIntervalMs: 10,
      }
    );
    onMessages(session, (content) => {
      const invocation = finishInvocation(content);
      execFileSync(invocation.helperPath, ['finish', invocation.completionId], {
        input: Buffer.alloc(4 * 1024 * 1024 + 1, 97),
      });
    });
    const result = await attached.run('prompt', 3000);
    expect(result.output.endsWith('[result truncated]')).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(4 * 1024 * 1024 + 32);
    attached.cleanup();
  });
});

function automationJob(): PollResponse {
  return {
    run_id: 77,
    run_type: 'automation',
    payload: {
      automation: {
        id: '7',
        name: 'Attached test',
        agent_kind: 'claude-code',
        prompt: 'perform attached work',
      },
      event: { fired_at: '2026-08-21T00:00:00Z', payload: {} },
      context: {
        device: { worker_id: 'worker-1' },
        user: { user_id: 'user-1' },
        agent_session: {
          conversation_id: 'agent_automation_7_run_77',
          mcp_url: 'https://gateway.test/mcp',
          token: 'run-scoped-bearer',
          expires_at: Date.now() + 60_000,
        },
      },
    },
  };
}

function fakeClient(replies: Array<Record<string, unknown>> = [{ status: 'completed' }]) {
  const completions: Array<Record<string, unknown>> = [];
  const client = {
    id: 'worker-1',
    mcpWiring: { url: 'https://daemon.test/mcp', bearer: 'daemon-token' },
    async heartbeat() {},
    async completeAutomation(_runId: number, request: Record<string, unknown>) {
      completions.push(request);
      return replies.shift() ?? { status: 'completed' };
    },
  } as unknown as ExecutorClient;
  return { client, completions };
}

async function routingFiles(sessionId?: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'lobu-routing-test-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const attachmentsFile = path.join(root, 'attachments.json');
  if (sessionId) await attachClaudeAutomation('7', sessionId, attachmentsFile);
  const spawnMarker = path.join(root, 'spawned');
  const fakeClaude = path.join(root, 'claude');
  writeFileSync(fakeClaude, `#!/bin/sh\necho spawned > ${JSON.stringify(spawnMarker)}\necho subprocess-result\n`);
  chmodSync(fakeClaude, 0o755);
  return { attachmentsFile, spawnMarker, fakeClaude };
}

describe('executeAutomationRun attached routing', () => {
  test('hands off once, returns finish output, and never spawns', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    let deliveries = 0;
    onMessages(session, (content) => {
      deliveries += 1;
      expect(content).not.toContain('run-scoped-bearer');
      const invocation = finishInvocation(content);
      execFileSync(invocation.helperPath, ['finish', invocation.completionId], {
        input: 'attached answer',
      });
    });
    const { client, completions } = fakeClient();
    const result = await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 2000,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(result.error).toBeUndefined();
    expect(deliveries).toBe(1);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.output).toBe('attached answer');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('reinjects finalize nudges into the same exact session without spawning', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    const prompts: string[] = [];
    onMessages(session, (content) => {
      prompts.push(content);
      const invocation = finishInvocation(content);
      execFileSync(invocation.helperPath, ['finish', invocation.completionId], {
        input: `answer ${prompts.length}`,
      });
    });
    const { client, completions } = fakeClient([
      { status: 'resume', attempt: 1, max_attempts: 2, nudge: 'finish the window' },
      { status: 'completed' },
    ]);
    await executeAutomationRun(
      client,
      automationJob(),
      { timeoutMs: 2000, heartbeatIntervalMs: 60_000 },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('FINALIZE NUDGE');
    expect(prompts[1]).toContain('finish the window');
    expect(completions.map((entry) => entry.output)).toEqual(['answer 1', 'answer 2']);
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('an attached offline session fails clearly and never spawns', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    await session.close();
    const { client, completions } = fakeClient();
    const result = await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 500,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(result.error).toContain('offline');
    expect(String(completions[0]!.error)).toContain('offline');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('socket injection failure is reported and never falls back to spawning', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    class ErrorSocket extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('error', new Error('write refused')));
      }
      setTimeout() { return this; }
      destroy() { return this; }
    }
    const { client, completions } = fakeClient();
    const result = await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 500,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: () => new ErrorSocket() as unknown as Socket,
        pollIntervalMs: 10,
      }
    );
    expect(result.error).toContain('socket injection failed');
    expect(String(completions[0]!.error)).toContain('write refused');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('an attached run times out without spawning or falling back', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    onMessages(session, () => undefined);
    const { client, completions } = fakeClient();
    await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 50,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(completions[0]!.exit_reason).toBe('timeout');
    expect(String(completions[0]!.error)).toContain('did not signal completion');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('session disappearance after handoff is reported without fallback', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    onMessages(session, () => {
      void session.close();
    });
    const { client, completions } = fakeClient();
    await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 2000,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(completions[0]!.exit_reason).toBe('crash');
    expect(String(completions[0]!.error)).toContain('went offline');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('a terminal 409 heartbeat ends the wait and still uses normal exit delivery', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    onMessages(session, () => undefined);
    const completions: Array<Record<string, unknown>> = [];
    const client = {
      id: 'worker-1',
      mcpWiring: { url: 'https://daemon.test/mcp', bearer: 'daemon-token' },
      async heartbeat() {
        throw new WorkerHttpError(409, '/heartbeat', 'run is terminal');
      },
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        completions.push(request);
        return { status: 'completed', idempotent: true };
      },
    } as unknown as ExecutorClient;
    await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 2000,
        heartbeatIntervalMs: 10,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]!.exit_reason).toBe('ok');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('a terminal heartbeat signal is scoped to one finalize attempt', async () => {
    const session = await liveSession();
    const files = await routingFiles(session.sessionId);
    const prompts: string[] = [];
    onMessages(session, (content) => {
      prompts.push(content);
      if (prompts.length === 2) {
        const invocation = finishInvocation(content);
        setTimeout(() => {
          execFileSync(invocation.helperPath, ['finish', invocation.completionId], {
            input: 'second-attempt result',
          });
        }, 75);
      }
    });
    const completions: Array<Record<string, unknown>> = [];
    let heartbeatCalls = 0;
    const client = {
      id: 'worker-1',
      mcpWiring: { url: 'https://daemon.test/mcp', bearer: 'daemon-token' },
      async heartbeat() {
        heartbeatCalls += 1;
        if (heartbeatCalls === 1) {
          throw new WorkerHttpError(409, '/heartbeat', 'terminal');
        }
      },
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        completions.push(request);
        return completions.length === 1
          ? { status: 'resume', attempt: 1, max_attempts: 2, nudge: 'retry finalize' }
          : { status: 'completed' };
      },
    } as unknown as ExecutorClient;
    await executeAutomationRun(
      client,
      automationJob(),
      { timeoutMs: 2000, heartbeatIntervalMs: 10 },
      {
        attachmentsFile: files.attachmentsFile,
        sessionsDir: session.root,
        processStart: session.processStart,
        socketStat: session.socketStat,
        connect: session.connect,
        pollIntervalMs: 10,
      }
    );
    expect(prompts).toHaveLength(2);
    expect(completions[1]!.output).toBe('second-attempt result');
    expect(() => statSync(files.spawnMarker)).toThrow();
  });

  test('an unattached Automation keeps the existing subprocess path', async () => {
    const files = await routingFiles();
    const { client, completions } = fakeClient();
    await executeAutomationRun(
      client,
      automationJob(),
      {
        timeoutMs: 2000,
        heartbeatIntervalMs: 60_000,
        binaryOverrides: { 'claude-code': files.fakeClaude },
      },
      { attachmentsFile: files.attachmentsFile }
    );
    expect(readFileSync(files.spawnMarker, 'utf8')).toContain('spawned');
    expect(completions[0]!.output).toContain('subprocess-result');
  });
});
