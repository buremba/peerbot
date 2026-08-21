import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import {
  resolveClaudeSession,
  sendClaudeSessionMessage,
} from '../daemon/claude-session.js';

const cleanups: Array<() => Promise<void> | void> = [];

function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync('/private/tmp/lcs-');
  const socketPath = path.join(root, 'claude.sock');
  const pid = typeof overrides.pid === 'number' ? overrides.pid : 4321;
  const procStart =
    typeof overrides.procStart === 'string'
      ? overrides.procStart
      : 'Fri Aug 21 00:00:00 2026';
  const sessionId = 'session-exact';
  writeFileSync(
    path.join(root, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart,
      peerProtocol: 1,
      kind: 'interactive',
      messagingSocketPath: socketPath,
      ...overrides,
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    path.join(root, `${pid}.fixture.key`),
    JSON.stringify({ peerToken: 'peer-secret', procStart }),
    { mode: 0o600 }
  );
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, socketPath, pid, procStart, sessionId };
}

function socketStat() {
  return { isSocket: () => true, uid: process.getuid?.() ?? 0 };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Claude interactive session resolution', () => {
  test('compares registry UTC procStart against ps forced to UTC, not host local time', () => {
    const f = fixture({ procStart: 'Fri Aug 21 00:00:00 2026' });
    let observedTimezone: string | undefined;
    const fakeSpawn = ((_command: string, _args: readonly string[], options: {
      env?: NodeJS.ProcessEnv;
    }) => {
      observedTimezone = options.env?.TZ;
      return {
        status: 0,
        stdout: 'Fri Aug 21 00:00:00 2026\n',
      };
    }) as unknown as NonNullable<
      Parameters<typeof resolveClaudeSession>[1]
    >['spawnProcess'];
    const resolved = resolveClaudeSession(f.sessionId, {
      sessionsDir: f.root,
      socketStat,
      spawnProcess: fakeSpawn,
    });
    expect(observedTimezone).toBe('UTC');
    expect(resolved.procStart).toBe(f.procStart);
  });

  test('validates the exact live process, socket, ownership, and key procStart', async () => {
    const f = fixture();
    const resolved = resolveClaudeSession(f.sessionId, {
      sessionsDir: f.root,
      processStart: () => f.procStart,
      socketStat,
    });
    expect(resolved).toEqual({
      sessionId: f.sessionId,
      pid: f.pid,
      procStart: f.procStart,
      socketPath: f.socketPath,
      peerToken: 'peer-secret',
    });
  });

  test('rejects non-interactive, dead/reused, non-socket, and wrong-owner records', async () => {
    const nonInteractive = fixture({ kind: 'print' });
    expect(() =>
      resolveClaudeSession(nonInteractive.sessionId, {
        sessionsDir: nonInteractive.root,
        processStart: () => nonInteractive.procStart,
        socketStat,
      })
    ).toThrow('kind is not interactive');

    const dead = fixture();
    expect(() =>
      resolveClaudeSession(dead.sessionId, {
        sessionsDir: dead.root,
        processStart: () => 'different start',
        socketStat,
      })
    ).toThrow('process identity no longer matches');

    const wrongOwner = fixture();
    expect(() =>
      resolveClaudeSession(wrongOwner.sessionId, {
        sessionsDir: wrongOwner.root,
        uid: (process.getuid?.() ?? 0) + 1,
        processStart: () => wrongOwner.procStart,
        socketStat,
      })
    ).toThrow('ownership mismatch');

    const notSocket = fixture();
    expect(() =>
      resolveClaudeSession(notSocket.sessionId, {
        sessionsDir: notSocket.root,
        processStart: () => notSocket.procStart,
        socketStat: () => ({ isSocket: () => false, uid: process.getuid?.() ?? 0 }),
      })
    ).toThrow('not a Unix socket');
  });

  test('writes the authenticated auth frame before the exact user-message frame', async () => {
    const f = fixture();
    const lines: string[] = [];
    const events: string[] = [];
    let ended = false;
    let destroyed = false;
    class FakeSocket extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('connect'));
      }
      setTimeout(timeout: number) {
        events.push(`timeout:${timeout}`);
        return this;
      }
      write(data: string, callback: (error?: Error) => void) {
        lines.push(data.trim());
        queueMicrotask(() => callback());
        return true;
      }
      end(callback: () => void) {
        ended = true;
        events.push('end');
        queueMicrotask(() => {
          events.push('end-callback');
          callback();
        });
        return this;
      }
      destroy() {
        destroyed = true;
        events.push('destroy');
        return this;
      }
    }
    const session = resolveClaudeSession(f.sessionId, {
      sessionsDir: f.root,
      processStart: () => f.procStart,
      socketStat,
    });
    await sendClaudeSessionMessage(
      session,
      'exact prompt',
      5000,
      () => new FakeSocket() as unknown as Socket
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: 'auth', token: 'peer-secret' },
      { type: 'user', message: { role: 'user', content: 'exact prompt' } },
    ]);
    expect(ended).toBe(true);
    expect(destroyed).toBe(true);
    expect(events).toEqual(['timeout:5000', 'end', 'end-callback', 'timeout:0', 'destroy']);
  });
});
