import { afterEach, describe, expect, test } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildDeviceAutomationPrompt } from '@lobu/core/contracts/worker/device-automation';
import {
  deriveInsideClaudeWorkerId,
  detectParentClaudeSession,
  handoffToParentClaude,
  type ParentClaudeSession,
} from '../daemon/parent-claude.js';

const execFileAsync = promisify(execFile);
const cleanupDirs: string[] = [];
const cleanupServers: net.Server[] = [];
const RESULT_CAP_BYTES = 4 * 1024 * 1024;

function runHelper(
  helperPath: string,
  args: string[],
  input: string | Buffer,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal == null) resolve();
      else reject(new Error(stderr.trim() || `helper exited with ${signal ?? code}`));
    });
    child.stdin.end(input);
  });
}

function readHelperConfig(helperPath: string): {
  socketPath: string;
  runId: number;
  nonce: string;
} {
  const source = readFileSync(helperPath, 'utf8');
  const configJson = source.match(/^const config = (.+);$/m)?.[1];
  if (!configJson) throw new Error('helper config not found');
  return JSON.parse(configJson);
}

function rawHelperRequest(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
  });
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  cleanupServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map(close));
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function parentFixture(): Promise<{
  dir: string;
  session: ParentClaudeSession;
  frames: Promise<string>;
}> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lobu-parent-test-'));
  cleanupDirs.push(dir);
  const socketPath = path.join(dir, 'parent.sock');
  let receiveFrames!: (frames: string) => void;
  const frames = new Promise<string>((resolve) => {
    receiveFrames = resolve;
  });
  await listen(
    net.createServer((socket) => {
      socket.setEncoding('utf8');
      let body = '';
      socket.on('data', (chunk) => {
        body += chunk;
      });
      socket.on('end', () => receiveFrames(body));
      // Deliberately send no acknowledgement. Delivery is write-based.
    }),
    socketPath
  );
  chmodSync(socketPath, 0o600);

  const registryPath = path.join(dir, `${process.pid}.json`);
  writeFileSync(
    registryPath,
    JSON.stringify({
      pid: process.pid,
      sessionId: 'claude-session-test',
      kind: 'interactive',
      messagingSocketPath: socketPath,
    }),
    { mode: 0o600 }
  );
  return {
    dir,
    frames,
    session: {
      pid: process.pid,
      sessionId: 'claude-session-test',
      socketPath,
      messagingToken: 'parent-messaging-token',
      registryPath,
    },
  };
}

describe('detectParentClaudeSession', () => {
  test('accepts the real 0644 registry mode but rejects group-writable metadata', async () => {
    const fixture = await parentFixture();
    const env = {
      CLAUDE_PID: String(process.pid),
      CLAUDE_CODE_SESSION_ID: fixture.session.sessionId,
      CLAUDE_CODE_MESSAGING_SOCKET: fixture.session.socketPath,
      CLAUDE_CODE_MESSAGING_TOKEN: fixture.session.messagingToken,
    };
    // Claude currently publishes this registry as 0644; ownership and exact
    // record matching carry the trust check while the socket itself is 0600.
    chmodSync(fixture.session.registryPath, 0o644);

    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: true,
      session: fixture.session,
    });

    chmodSync(fixture.session.registryPath, 0o664);
    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: false,
      reason: 'Claude session registry did not match an interactive parent',
    });

    chmodSync(fixture.session.registryPath, 0o644);
    writeFileSync(
      fixture.session.registryPath,
      JSON.stringify({
        pid: process.pid,
        sessionId: fixture.session.sessionId,
        kind: 'background',
        messagingSocketPath: fixture.session.socketPath,
      }),
      { mode: 0o600 }
    );
    expect(detectParentClaudeSession({ env, sessionsDir: fixture.dir })).toEqual({
      ok: false,
      reason: 'Claude session registry did not match an interactive parent',
    });
  });

  test('rejects missing inherited metadata instead of discovering another session', () => {
    expect(detectParentClaudeSession({ env: {} })).toEqual({
      ok: false,
      reason: 'missing inherited Claude session metadata',
    });
  });
});

describe('deriveInsideClaudeWorkerId', () => {
  test('is stable within one parent session and distinct across sessions', () => {
    const first = deriveInsideClaudeWorkerId({ CLAUDE_CODE_SESSION_ID: 'session-a' });
    expect(first).toBe(deriveInsideClaudeWorkerId({ CLAUDE_CODE_SESSION_ID: 'session-a' }));
    expect(first).not.toBe(deriveInsideClaudeWorkerId({ CLAUDE_CODE_SESSION_ID: 'session-b' }));
    expect(first).toMatch(/^headless:claude:[a-f0-9]{24}$/);
  });
});

describe('handoffToParentClaude', () => {
  test('needs no parent ack and keeps the run bearer in an owner-only helper channel', async () => {
    const fixture = await parentFixture();
    const verifierPath = path.join(fixture.dir, 'verifier.sock');
    let receiveAccess!: (value: Record<string, unknown>) => void;
    const access = new Promise<Record<string, unknown>>((resolve) => {
      receiveAccess = resolve;
    });
    await listen(
      net.createServer((socket) => {
        socket.setEncoding('utf8');
        let body = '';
        socket.on('data', (chunk) => {
          body += chunk;
        });
        socket.on('end', () => receiveAccess(JSON.parse(body)));
      }),
      verifierPath
    );
    const verifierSource = `
      const net = require('node:net');
      const socket = net.createConnection(${JSON.stringify(verifierPath)}, () => {
        socket.end(JSON.stringify({
          token: process.env.LOBU_API_TOKEN,
          memoryUrl: process.env.LOBU_MEMORY_URL,
          workerToken: process.env.WORKER_API_TOKEN ?? null,
          args: process.argv.slice(1),
        }));
      });
    `;
    const bearer = 'run-scoped-secret-bearer';
    const memoryUrl = 'https://gateway.test/mcp/test';
    const standardPrompt = buildDeviceAutomationPrompt(
      {
        automation: { id: '77', prompt: 'Read the window and finish it' },
        event: { fired_at: '2026-08-21T00:00:00.000Z', payload: {} },
        context: { device: {}, user: {} },
      },
      77
    );
    const started = Date.now();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 77,
      prompt: `${standardPrompt}\nFinalize via lobu CLI or MCP.`,
      token: bearer,
      memoryUrl,
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      cliLaunch: { command: process.execPath, args: ['-e', verifierSource] },
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    expect(Date.now() - started).toBeLessThan(1_000);

    const parentFrames = await fixture.frames;
    const messageFrame = parentFrames
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((frame) => frame.type === 'user');
    const deliveredPrompt = messageFrame.message.content as string;
    const helperDir = path.dirname(delivery.helperPath);
    const helperSocket = path.join(helperDir, 'helper.sock');
    expect(deliveredPrompt).toContain(`'${delivery.helperPath}' exec`);
    expect(deliveredPrompt).toContain(`'${delivery.helperPath}' complete`);
    expect(deliveredPrompt).toContain('final user-visible result on stdin');
    expect(deliveredPrompt).toContain('Do not reuse a helper from an earlier Automation message.');
    expect(deliveredPrompt).toContain('For a window Automation');
    expect(deliveredPrompt).toContain('For an event turn');
    expect(deliveredPrompt).toContain('do not use bare `lobu memory exec` or ambient Lobu MCP');
    expect(deliveredPrompt).toContain('Use the run-specific helper above for all Lobu access.');
    expect(deliveredPrompt).not.toContain('MCP is also fine if already wired');
    expect(deliveredPrompt).not.toContain('query_sdk');
    expect(deliveredPrompt).not.toContain('run_sdk');
    expect(deliveredPrompt).not.toContain('Finalize via lobu CLI or MCP');
    expect(deliveredPrompt).not.toContain('same login as the Owletto menubar');
    expect(deliveredPrompt).not.toContain('~/.config/lobu');
    expect(deliveredPrompt).not.toContain(bearer);
    expect(await Bun.file(delivery.helperPath).text()).not.toContain(bearer);
    expect(lstatSync(helperDir).mode & 0o077).toBe(0);
    expect(lstatSync(delivery.helperPath).mode & 0o077).toBe(0);
    expect(lstatSync(helperSocket).mode & 0o077).toBe(0);

    const moduleSource = 'export default async () => ({ ok: true })';
    await execFileAsync(delivery.helperPath, ['exec', moduleSource], {
      env: { ...process.env, PATH: '', WORKER_API_TOKEN: 'daemon-worker-secret' },
    });
    expect(await access).toEqual({
      token: bearer,
      memoryUrl,
      workerToken: null,
      args: ['memory', 'exec', moduleSource],
    });

    await runHelper(
      delivery.helperPath,
      ['complete'],
      `final result for ChatGPT; bearer=${bearer}`,
      { ...process.env, PATH: '' }
    );
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'final result for ChatGPT; bearer=[REDACTED]',
    });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('caps completion stdin, preserves truncation evidence, and works without PATH', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 78,
      prompt: 'Do work',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helper = await Bun.file(delivery.helperPath).text();
    expect(helper.startsWith(`#!${process.execPath}\n`)).toBe(true);

    await runHelper(delivery.helperPath, ['complete'], Buffer.alloc(RESULT_CAP_BYTES + 1, 97), {
      ...process.env,
      PATH: '',
    });
    const completion = await delivery.completion;
    expect(completion.kind).toBe('completed');
    if (completion.kind !== 'completed') throw new Error(completion.error);
    expect(Buffer.byteLength(completion.output)).toBeLessThanOrEqual(RESULT_CAP_BYTES);
    expect(completion.output.endsWith('\n[result truncated]')).toBe(true);
  });

  test('rejects unsafe or unavailable Node executables before parent delivery', async () => {
    const fixture = await parentFixture();
    const unavailable = path.join(fixture.dir, 'missing-node');
    const notExecutable = path.join(fixture.dir, 'not-executable-node');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o600 });

    for (const command of ['node', unavailable, notExecutable, '/bin/node\ninjected']) {
      const delivery = await handoffToParentClaude({
        session: fixture.session,
        runId: 79,
        prompt: 'Do work',
        token: 'run-secret',
        memoryUrl: 'https://gateway.test/mcp/test',
        timeoutMs: 10_000,
        cliLaunch: { command, args: [] },
      });
      expect(delivery.kind).toBe('not-delivered');
      if (delivery.kind === 'not-delivered') {
        expect(delivery.reason).toContain('Node executable');
      }
    }
  });

  test('rejects malformed and oversized completion frames without settling the attempt', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 80,
      prompt: 'Do work',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const config = readHelperConfig(delivery.helperPath);

    expect(await rawHelperRequest(config.socketPath, 'not-json\n')).toBe('{"ok":false}\n');
    expect(
      await rawHelperRequest(
        config.socketPath,
        `${JSON.stringify({
          version: 1,
          run_id: config.runId,
          nonce: config.nonce,
          op: 'complete',
          output_base64: Buffer.alloc(RESULT_CAP_BYTES + 1).toString('base64'),
          truncated: false,
        })}\n`
      )
    ).toBe('{"ok":false}\n');

    await runHelper(delivery.helperPath, ['complete'], 'valid answer');
    expect(await delivery.completion).toMatchObject({
      kind: 'completed',
      output: 'valid answer',
    });
  });

  test("a prior attempt's credentials cannot complete a later attempt", async () => {
    const fixture = await parentFixture();
    const first = await handoffToParentClaude({
      session: fixture.session,
      runId: 81,
      prompt: 'First attempt',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(first.kind).toBe('handed-off');
    if (first.kind !== 'handed-off') throw new Error(first.reason);

    // Capture the first attempt's nonce before its helper directory is removed.
    const staleNonce = readHelperConfig(first.helperPath).nonce;
    await runHelper(first.helperPath, ['complete'], 'first answer');
    expect(await first.completion).toMatchObject({ kind: 'completed', output: 'first answer' });

    const second = await handoffToParentClaude({
      session: fixture.session,
      runId: 81,
      prompt: 'Second attempt',
      token: 'run-secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
    });
    expect(second.kind).toBe('handed-off');
    if (second.kind !== 'handed-off') throw new Error(second.reason);
    const current = readHelperConfig(second.helperPath);
    expect(staleNonce).not.toBe(current.nonce);

    // The same run id on the live socket, replaying the retired attempt's nonce.
    const replay = (op: Record<string, unknown>) =>
      rawHelperRequest(
        current.socketPath,
        `${JSON.stringify({ version: 1, run_id: current.runId, nonce: staleNonce, ...op })}\n`
      );
    expect(await replay({ op: 'credentials' })).toBe('{"ok":false}\n');
    expect(
      await replay({
        op: 'complete',
        output_base64: Buffer.from('stale answer').toString('base64'),
        truncated: false,
      })
    ).toBe('{"ok":false}\n');

    await runHelper(second.helperPath, ['complete'], 'current answer');
    expect(await second.completion).toMatchObject({
      kind: 'completed',
      output: 'current answer',
    });
  });

  test('daemon shutdown completes a delivered handoff and removes its helper', async () => {
    const fixture = await parentFixture();
    const shutdown = new AbortController();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 82,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
      disconnectCheckIntervalMs: 10_000,
      shutdownSignal: shutdown.signal,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helperDir = path.dirname(delivery.helperPath);
    shutdown.abort();
    expect(await delivery.completion).toMatchObject({ kind: 'shutdown' });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('the existing run timeout bounds a parent handoff', async () => {
    const fixture = await parentFixture();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 83,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 20,
      disconnectCheckIntervalMs: 10_000,
    });

    expect(delivery.kind).toBe('handed-off');
    if (delivery.kind !== 'handed-off') throw new Error(delivery.reason);
    const helperDir = path.dirname(delivery.helperPath);
    expect(await delivery.completion).toMatchObject({ kind: 'timeout' });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('an unavailable inbox is unambiguously not delivered', async () => {
    const fixture = await parentFixture();
    await close(cleanupServers.pop()!);
    rmSync(fixture.session.socketPath, { force: true });

    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 84,
      prompt: 'Do work',
      token: 'secret',
      memoryUrl: 'https://gateway.test/mcp/test',
      timeoutMs: 10_000,
    });

    expect(delivery).toEqual({
      kind: 'not-delivered',
      reason: 'parent inbox was unavailable before delivery',
    });
  });
});
