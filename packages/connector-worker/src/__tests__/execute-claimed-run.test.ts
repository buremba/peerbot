import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { CompleteAutomationResponse, PollResponse } from '@lobu/core/contracts/worker/protocol';
import {
  executeClaimedAutomationRun,
  UnexecutableRunError,
} from '../daemon/execute-run.js';

/**
 * The one-shot handoff a native bridge uses: it has ALREADY claimed the run, so
 * the contract under test is ownership. A refusal must reach the caller with
 * nothing posted (the caller still has to report), and a delivered outcome must
 * NOT surface as a refusal (or the run gets reported twice).
 */

const tmp = mkdtempSync(path.join(os.tmpdir(), 'lobu-execute-claimed-'));
const fakeBinary = path.join(tmp, 'pi');

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
  } as unknown as PollResponse;
}

let server: http.Server;
let baseUrl: string;
let requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }>;
let script: CompleteAutomationResponse[];

beforeAll(async () => {
  writeFileSync(fakeBinary, '#!/bin/sh\necho "FAKE_OUTPUT"\nexit 0\n');
  chmodSync(fakeBinary, 0o755);

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : {},
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.includes('/complete-automation')) {
        res.end(JSON.stringify(script.shift() ?? { status: 'completed' }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr == null || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  script = [];
});

function opts(overrides: Record<string, unknown> = {}) {
  return {
    apiUrl: baseUrl,
    workerId: 'wrk_1',
    authToken: 'session_token_from_the_claimer',
    job: automationJob(),
    binaryOverrides: { pi: fakeBinary },
    workspaceRoot: path.join(tmp, 'workspaces'),
    ...overrides,
  } as Parameters<typeof executeClaimedAutomationRun>[0];
}

describe('executeClaimedAutomationRun', () => {
  test('spawns the agent and posts the exit report as the CLAIMING worker', async () => {
    const result = await executeClaimedAutomationRun(opts());

    expect(result.error).toBeUndefined();
    const completion = requests.find((r) => r.path.includes('/complete-automation'));
    expect(completion).toBeDefined();
    // worker_id must be the claimer's: /complete-automation authorizes on
    // `runs.claimed_by`, and the live suite pins what a mismatch actually costs.
    expect(completion?.body.worker_id).toBe('wrk_1');
    expect(completion?.body.exit_code).toBe(0);
    expect(String(completion?.body.output)).toContain('FAKE_OUTPUT');
    // The caller's own bearer, verbatim — not a credential discovered on disk.
    expect(completion?.auth).toBe('Bearer session_token_from_the_claimer');
  });

  test('a run that FAILS is still a delivered outcome, not a refusal', async () => {
    // An agent_kind with no AgentSpec. Deliberately not a real-but-uninstalled
    // kind like `codex`: the spec table would still resolve and the arm would
    // spawn whatever is on this machine's PATH, so the test would pass or hang
    // depending on the developer's laptop. The arm reports this through
    // /complete-automation, so ownership has transferred and the caller must
    // not report again.
    const job = automationJob() as unknown as Record<string, unknown>;
    (job.payload as { automation: { agent_kind: string } }).automation.agent_kind =
      'not-a-real-agent';

    const result = await executeClaimedAutomationRun(
      opts({ job, binaryOverrides: undefined })
    );

    expect(result.error).toContain('no local agent executor configured');
    const completion = requests.find((r) => r.path.includes('/complete-automation'));
    expect(completion).toBeDefined();
    expect(completion?.body.worker_id).toBe('wrk_1');
  });

  test('refuses a non-automation run without contacting the server', async () => {
    const job = { ...automationJob(), run_type: 'sync' };
    await expect(executeClaimedAutomationRun(opts({ job }))).rejects.toThrow(
      UnexecutableRunError
    );
    expect(requests).toHaveLength(0);
  });

  test('refuses a run with no run_id without contacting the server', async () => {
    const job = automationJob() as unknown as Record<string, unknown>;
    job.run_id = undefined;
    await expect(executeClaimedAutomationRun(opts({ job }))).rejects.toThrow(
      /run_id must be a positive number/
    );
    expect(requests).toHaveLength(0);
  });

  test('refuses a non-object envelope without contacting the server', async () => {
    await expect(executeClaimedAutomationRun(opts({ job: '[]' }))).rejects.toThrow(
      /expected a JSON object/
    );
    expect(requests).toHaveLength(0);
  });

  test('refuses a blank workerId — a non-claiming id loses the report silently', async () => {
    await expect(executeClaimedAutomationRun(opts({ workerId: '  ' }))).rejects.toThrow(
      /workerId is required/
    );
    expect(requests).toHaveLength(0);
  });

  test('refuses a blank auth token', async () => {
    await expect(executeClaimedAutomationRun(opts({ authToken: '' }))).rejects.toThrow(
      /auth token is required/
    );
    expect(requests).toHaveLength(0);
  });

  test('does NOT require a durable owl_pat_ token — a claimer polls with a session bearer', async () => {
    const result = await executeClaimedAutomationRun(
      opts({ authToken: 'oauth_session_token' })
    );
    expect(result.error).toBeUndefined();
    const completion = requests.find((r) => r.path.includes('/complete-automation'));
    expect(completion?.auth).toBe('Bearer oauth_session_token');
  });

  test('falls back to defaultAgentKind when the Automation names none', async () => {
    // The Mac app has always resolved an unset kind from the user's menubar
    // pick. Without this the run fails on the device with "no local agent
    // executor configured" — a regression the moment the Swift dispatcher is
    // deleted in favour of this path.
    const job = automationJob() as unknown as Record<string, unknown>;
    (job.payload as { automation: { agent_kind?: string | null } }).automation.agent_kind =
      null;

    const result = await executeClaimedAutomationRun(
      opts({ job, defaultAgentKind: 'pi' })
    );

    expect(result.error).toBeUndefined();
    const completion = requests.find((r) => r.path.includes('/complete-automation'));
    expect(String(completion?.body.output)).toContain('FAKE_OUTPUT');
  });

  test("an explicit agent_kind still WINS over the caller's default", async () => {
    const result = await executeClaimedAutomationRun(
      // Envelope says `pi`; the default names an agent with no binary override,
      // so if the default won this would report "no local agent executor".
      opts({ defaultAgentKind: 'not-a-real-agent' as never })
    );

    expect(result.error).toBeUndefined();
    const completion = requests.find((r) => r.path.includes('/complete-automation'));
    expect(String(completion?.body.output)).toContain('FAKE_OUTPUT');
  });

  test('no agent_kind and no default still reports through the server', async () => {
    const job = automationJob() as unknown as Record<string, unknown>;
    (job.payload as { automation: { agent_kind?: string | null } }).automation.agent_kind =
      null;

    const result = await executeClaimedAutomationRun(opts({ job }));

    expect(result.error).toContain("agent_kind='(unset)'");
    expect(requests.find((r) => r.path.includes('/complete-automation'))).toBeDefined();
  });

  test('honours the server resume decision through the shared arm', async () => {
    script = [
      { status: 'resume', attempt: 2, max_attempts: 3, nudge: 'finalize it' },
      { status: 'completed' },
    ];
    await executeClaimedAutomationRun(opts());
    const completions = requests.filter((r) => r.path.includes('/complete-automation'));
    expect(completions).toHaveLength(2);
    expect(completions[1]?.body.finalize_attempt).toBe(2);
  });
});
