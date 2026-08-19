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
  const bothPipesBinary = path.join(tmp, 'pi-orphan-both');

  beforeAll(() => {
    writeFileSync(
      bothPipesBinary,
      // Same as above, but the grandchild inherits stderr too — the only shape
      // that can tell a shared deadline apart from two sequential ones.
      `#!/bin/sh\ntrap '' TERM\nsleep 20 &\necho "PARTIAL_OUTPUT"\nsleep 20\n`
    );
    chmodSync(bothPipesBinary, 0o755);

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

  /**
   * The two pipes must race one clock. Awaiting stdout's deadline and *then*
   * stderr's gave each a full window, so a grandchild holding both cost twice
   * the deadline. Measured on the 60s clean-exit path that was 120s, not 60s.
   */
  test('a grandchild holding BOTH pipes costs one deadline, not two', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const both = cfg();
    both.timeoutMs = 500;
    both.binaryOverrides = { pi: bothPipesBinary };

    const startedAt = Date.now();
    await executeAutomationRun(client(), automationJob(), both);
    const elapsedMs = Date.now() - startedAt;

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // ~3.5s to SIGTERM→SIGKILL→reap, then ONE 2s post-SIGKILL flush window.
    // Serialized deadlines spent two of them and landed past 7.5s.
    expect(elapsedMs).toBeLessThan(6_500);
  }, 30_000);
});

/**
 * A CLI that reports its fatal on stdout must still be diagnosable. `claude`
 * prints "Credit balance is too low" to stdout and leaves stderr empty, which
 * a stderr-only error message reduced to "exited with non-zero status 1".
 */
describe('automation arm failure diagnosis', () => {
  const stdoutFatalBinary = path.join(tmp, 'pi-stdout-fatal');

  beforeAll(() => {
    writeFileSync(
      stdoutFatalBinary,
      `#!/bin/sh\necho "Credit balance is too low"\nexit 1\n`
    );
    chmodSync(stdoutFatalBinary, 0o755);
  });

  test('falls back to stdout when the CLI leaves stderr empty', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const failing = cfg();
    failing.binaryOverrides = { pi: stdoutFatalBinary };

    await executeAutomationRun(client(), automationJob(), failing);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('error_message');
    expect(completions[0].body.error).toContain('Credit balance is too low');
  });
});

/**
 * A timed-out CLI is the one exit path with no diagnosis attached: the run row
 * gets `output_tail` from stdout only, and the timeout branch built its error
 * from a fixed string, so whatever the CLI wrote to stderr before it stalled
 * was dropped. That is how a device Automation can fail 39 times in a row and
 * leave nothing behind to explain why (prod #71, Aug 18-19).
 */
describe('automation arm timeout diagnosis', () => {
  const stderrStallBinary = path.join(tmp, 'pi-stderr-stall');

  beforeAll(() => {
    // Writes its diagnosis to stderr, then stalls until the deadline kills it.
    writeFileSync(
      stderrStallBinary,
      `#!/bin/sh\necho "MCP server handshake failed: connection refused" >&2\nsleep 4\n`
    );
    chmodSync(stderrStallBinary, 0o755);
  });

  test('keeps the stderr the CLI wrote before it stalled', async () => {
    completions = [];
    script = [{ status: 'completed' }];
    const stalling = cfg();
    stalling.timeoutMs = 500;
    stalling.binaryOverrides = { pi: stderrStallBinary };

    await executeAutomationRun(client(), automationJob(), stalling);

    expect(completions).toHaveLength(1);
    expect(completions[0].body.exit_reason).toBe('timeout');
    // The deadline itself still has to be reported — it is the primary fact.
    expect(completions[0].body.error).toContain('timeout');
    // ...but so does the only evidence of WHY the CLI stalled.
    expect(completions[0].body.error).toContain('MCP server handshake failed');
  }, 30_000);
});
