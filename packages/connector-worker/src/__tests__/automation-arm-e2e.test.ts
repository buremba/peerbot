import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CompleteAutomationResponse, PollResponse } from '@lobu/core/contracts/worker/protocol';
import { WorkerClient } from '../daemon/client.js';
import { executeAutomationRun } from '../daemon/automation.js';
import type { ExecutorConfig } from '../daemon/executor.js';

/**
 * End-to-end automation arm: a real CLI subprocess (fake `pi` binary) + a real
 * HTTP round-trip against a stub gateway. Pins that the daemon actually spawns
 * the CLI, drains its output, and posts the exit report — the path the unit
 * tests mock away.
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobu-automation-e2e-'));
const fakeBinary = path.join(tmp, 'pi');
const argsLog = path.join(tmp, 'args.log');

function automationJob(): PollResponse {
  return {
    run_id: 42,
    run_type: 'automation',
    organization_id: 'org_test',
    payload: {
      automation: {
        id: 'beh_1',
        name: 'Test',
        slug: 'test',
        agent_kind: 'pi',
        prompt: 'do a thing',
      },
      event: { trigger_event_id: null, fired_at: '2026-07-30T00:00:00Z', payload: {} },
      context: { device: { worker_id: 'wrk_1' }, user: { user_id: 'usr_1' } },
    },
  };
}

let server: http.Server;
let baseUrl: string;
let completions: Array<{ path: string; body: Record<string, unknown> }>;
let script: CompleteAutomationResponse[];

function cfg(): ExecutorConfig {
  return {
    batchSize: 10,
    heartbeatIntervalMs: 60_000,
    generateEmbeddings: true,
    timeoutMs: 30_000,
    maxOldSpaceSize: 1024,
    binaryOverrides: { pi: fakeBinary },
  };
}

function client(): WorkerClient {
  return new WorkerClient({
    apiUrl: baseUrl,
    workerId: 'wrk_1',
    authToken: 'owl_pat_test',
    capabilities: {},
  });
}

beforeAll(async () => {
  writeFileSync(
    fakeBinary,
    `#!/bin/sh\necho "FAKE_OUTPUT"\necho "---INVOCATION---" >> "$FAKE_CLI_LOG"\nprintf '%s\\n' "$@" >> "$FAKE_CLI_LOG"\nexit 0\n`
  );
  chmodSync(fakeBinary, 0o755);
  process.env.FAKE_CLI_LOG = argsLog;

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.url?.includes('/complete-automation')) {
        completions.push({ path: req.url ?? '', body: body ? JSON.parse(body) : {} });
        const reply = script.shift() ?? { status: 'completed' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
        return;
      }
      if (req.method === 'POST' && req.url?.includes('/heartbeat')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  delete process.env.FAKE_CLI_LOG;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(argsLog, { force: true });
});

function readArgsLog(): string {
  try {
    return readFileSync(argsLog, 'utf8');
  } catch {
    return '';
  }
}

describe('automation arm e2e', () => {
  test('spawns the CLI, drains output, and posts the exit report', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const result = await executeAutomationRun(client(), automationJob(), cfg());

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(1);
    expect(completions[0].path).toBe('/api/workers/me/runs/42/complete-automation');
    expect(completions[0].body.worker_id).toBe('wrk_1');
    expect(completions[0].body.output).toContain('FAKE_OUTPUT');
    expect(completions[0].body.exit_reason).toBe('ok');
    expect(completions[0].body.finalize_attempt).toBe(0);
    expect(readArgsLog().split('---INVOCATION---').length - 1).toBe(1);
  });

  test("a granted resume re-spawns the CLI with the server's nudge in the prompt", async () => {
    completions = [];
    script = [
      { status: 'resume', attempt: 2, max_attempts: 3, nudge: 'finalize it' },
      { status: 'completed' },
    ];
    const result = await executeAutomationRun(client(), automationJob(), cfg());

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(2);
    expect(completions[1].body.finalize_attempt).toBe(2);
    const log = readArgsLog();
    expect(log.split('---INVOCATION---').length - 1).toBe(2);
    expect(log).toContain('finalize it');
    expect(log).toContain('FINALIZE NUDGE');
  });

  test('a missing binary reports a terminal failure instead of hanging', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const missing = cfg();
    missing.binaryOverrides = { pi: path.join(tmp, 'does-not-exist') };
    const result = await executeAutomationRun(client(), automationJob(), missing);

    expect(result.error).toContain('binary not found');
    expect(completions).toHaveLength(1);
    expect(completions[0].body.error).toContain('binary not found');
    expect(completions[0].body.exit_reason).toBe('error_message');
  });
});

/**
 * Regression: a grandchild that inherits the CLI's stdout keeps the pipe's
 * write end open after the CLI itself is reaped. Draining without a deadline
 * parked the run forever — claimed and heartbeating, so the server's stale-run
 * sweep never reclaimed it either. `runCli` now caps the post-exit flush.
 */
describe('automation arm drain deadline', () => {
  const hangBinary = path.join(tmp, 'pi-orphan-pipe');

  beforeAll(() => {
    writeFileSync(
      hangBinary,
      // Ignore SIGTERM so the run reaches the SIGKILL arm, and leave a
      // grandchild holding stdout well past the 2s post-SIGKILL flush window.
      `#!/bin/sh\ntrap '' TERM\nsleep 15 &\necho "PARTIAL_OUTPUT"\nsleep 15\n`
    );
    chmodSync(hangBinary, 0o755);
  });

  test('a CLI whose grandchild holds stdout still reports, keeping flushed output', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const hang = cfg();
    hang.timeoutMs = 500;
    hang.binaryOverrides = { pi: hangBinary };

    const startedAt = Date.now();
    const result = await executeAutomationRun(client(), automationJob(), hang);
    const elapsedMs = Date.now() - startedAt;

    expect(result.error).toBeUndefined();
    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // The bytes the CLI did flush survive the forced close.
    expect(completions[0].body.output).toContain('PARTIAL_OUTPUT');
    // Well under the 15s the grandchild holds the pipe: the deadline fired.
    expect(elapsedMs).toBeLessThan(12_000);
  }, 30_000);
});
