import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(deliveredPrompt).toContain(`${delivery.helperPath} exec`);
    expect(deliveredPrompt).toContain(`${delivery.helperPath} complete`);
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
      env: { ...process.env, WORKER_API_TOKEN: 'daemon-worker-secret' },
    });
    expect(await access).toEqual({
      token: bearer,
      memoryUrl,
      workerToken: null,
      args: ['memory', 'exec', moduleSource],
    });

    await execFileAsync(delivery.helperPath, ['complete']);
    expect(await delivery.completion).toMatchObject({ kind: 'completed' });
    expect(existsSync(helperDir)).toBe(false);
  });

  test('daemon shutdown completes a delivered handoff and removes its helper', async () => {
    const fixture = await parentFixture();
    const shutdown = new AbortController();
    const delivery = await handoffToParentClaude({
      session: fixture.session,
      runId: 78,
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
      runId: 79,
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
      runId: 80,
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
