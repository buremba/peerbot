import { describe, expect, test } from 'bun:test';
import { DEVICE_AGENT_SPECS_BY_KIND } from '@lobu/core/contracts/worker/device-automation';
import type {
  CompleteAutomationResponse,
} from '@lobu/core/contracts/worker/protocol';
import {
  buildArguments,
  deliverExitReport,
  dispatchAutomationResumeLoop,
  type AutomationRunIo,
  type ExecutorResult,
} from '../daemon/automation.js';
import {
  interpretCompleteAutomationResponse,
  WorkerDecodeError,
  WorkerHttpError,
  type ExecutorClient,
} from '../daemon/client.js';

function okResult(): ExecutorResult {
  return {
    output: 'done',
    error: null,
    exitCode: 0,
    exitSignal: null,
    exitReason: 'ok',
    durationMs: 1,
  };
}

/** Scripted resume-loop IO. `deliver` is a single-shot script (the retry logic
 * lives in `deliverExitReport`, tested separately). */
function scriptedIo(replies: (CompleteAutomationResponse | Error)[]) {
  const nudges: (string | undefined)[] = [];
  const attempts: number[] = [];
  let errors = 0;
  const io: AutomationRunIo = {
    run: async (nudge) => {
      nudges.push(nudge);
      return okResult();
    },
    deliver: async (_result, finalizeAttempt) => {
      attempts.push(finalizeAttempt);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return next ?? { status: 'completed' };
    },
    reportError: async () => {
      errors += 1;
    },
  };
  return { io, nudges, attempts, errors: () => errors };
}

describe('dispatchAutomationResumeLoop (ported DispatcherResumeTests)', () => {
  test("a granted resume re-spawns with the server's nudge and honours its attempt", async () => {
    // Attempt 2, not 1: after one resume a local `+1` would also yield 1.
    const { io, nudges, attempts } = scriptedIo([
      { status: 'resume', attempt: 2, max_attempts: 3, nudge: 'finalize it' },
      { status: 'completed' },
    ]);
    await dispatchAutomationResumeLoop(io);
    expect(nudges).toEqual([undefined, 'finalize it']);
    expect(attempts).toEqual([0, 2]);
  });

  test('a local safety cap bounds spawns at 8 and posts a final error report', async () => {
    const { io, nudges, attempts, errors } = scriptedIo([
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
      { status: 'resume', nudge: 'again' },
    ]);
    await dispatchAutomationResumeLoop(io);
    expect(nudges.length).toBe(8);
    expect(attempts.length).toBe(8);
    expect(errors()).toBe(1);
  });

  test('a spawn throw reports a crash and stops', async () => {
    const { io, errors } = scriptedIo([]);
    const runs: (string | undefined)[] = [];
    const throwingIo: AutomationRunIo = {
      ...io,
      run: async (nudge) => {
        runs.push(nudge);
        throw new Error('boom');
      },
    };
    await dispatchAutomationResumeLoop(throwingIo);
    expect(runs.length).toBe(1);
    expect(errors()).toBe(1);
  });

  test('an unknown delivery outcome (null) leaves the run claimed, no error report', async () => {
    const { io, nudges, errors } = scriptedIo([]);
    const nullDeliver: AutomationRunIo = {
      ...io,
      deliver: async () => null,
    };
    await dispatchAutomationResumeLoop(nullDeliver);
    expect(nudges.length).toBe(1);
    expect(errors()).toBe(0);
  });
});

describe('deliverExitReport (delivery retry + classification)', () => {
  function fakeClient(script: (Error | CompleteAutomationResponse)[]) {
    const calls: number[] = [];
    const client = {
      id: 'wrk_1',
      completeAutomation: async (_runId: number, req: { finalize_attempt?: number }) => {
        calls.push(req.finalize_attempt ?? -1);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next ?? { status: 'completed' };
      },
    } as unknown as ExecutorClient;
    return { client, calls };
  }

  test('a transient failure re-sends the same report, replaying finalize_attempt', async () => {
    const { client, calls } = fakeClient([
      new Error('transport'),
      { status: 'completed' },
    ]);
    const report = await deliverExitReport(client, 7, okResult(), 0);
    expect(report?.status).toBe('completed');
    expect(calls).toEqual([0, 0]);
  });

  test('an HTTP 500 is retried; a 400 is not', async () => {
    const retried = fakeClient([
      new WorkerHttpError(503, '/x', 'upstream'),
      { status: 'completed' },
    ]);
    await deliverExitReport(retried.client, 7, okResult(), 0);
    expect(retried.calls).toEqual([0, 0]);

    const rejected = fakeClient([new WorkerHttpError(400, '/x', 'bad')]);
    const outcome = await deliverExitReport(rejected.client, 7, okResult(), 0);
    expect(outcome).toBeNull();
    expect(rejected.calls).toEqual([0]);
  });

  test('an unreadable 2xx body (decode error) is non-retriable', async () => {
    const { client, calls } = fakeClient([new WorkerDecodeError('garbled')]);
    const outcome = await deliverExitReport(client, 7, okResult(), 0);
    expect(outcome).toBeNull();
    expect(calls).toEqual([0]);
  });
});

describe('interpretCompleteAutomationResponse', () => {
  test('reads a status-carrying body', () => {
    expect(interpretCompleteAutomationResponse({ status: 'resume', nudge: 'x' }).status).toBe('resume');
    expect(interpretCompleteAutomationResponse({ status: 'completed' }).status).toBe('completed');
  });

  test('accepts the legacy minimal ack', () => {
    expect(interpretCompleteAutomationResponse({ ok: true }).status).toBe('completed');
    expect(interpretCompleteAutomationResponse({}).status).toBe('completed');
  });

  test('rejects an error ack and unreadable bodies', () => {
    expect(() => interpretCompleteAutomationResponse({ ok: false })).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse({ error: 'x' })).toThrow(WorkerDecodeError);
    expect(() => interpretCompleteAutomationResponse('<html>502</html>')).toThrow(WorkerDecodeError);
  });
});

describe('buildArguments (ported AgentSpec table)', () => {
  const claude = DEVICE_AGENT_SPECS_BY_KIND.get('claude-code')!;
  const pi = DEVICE_AGENT_SPECS_BY_KIND.get('pi')!;
  const codex = DEVICE_AGENT_SPECS_BY_KIND.get('codex')!;
  const opencode = DEVICE_AGENT_SPECS_BY_KIND.get('opencode')!;
  const agy = DEVICE_AGENT_SPECS_BY_KIND.get('agy')!;

  test('claude: flag prompt, MCP config, model + budget + permission + effort flags', () => {
    const args = buildArguments(
      claude,
      'the prompt',
      {
        model: 'claude-sonnet-5',
        max_budget_usd: 2,
        permission_mode: 'acceptEdits',
        effort: 'high',
      },
      ['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config', '--allowedTools', 'a,b'],
      600
    );
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('the prompt');
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-5');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('2');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('--effort');
    expect(args).toContain('high');
    expect(args).toContain('--mcp-config');
  });

  test('pi: positional prompt goes last, after every flag', () => {
    const args = buildArguments(pi, 'the prompt', undefined, [], 600);
    expect(args[0]).toBe('-p');
    expect(args.at(-1)).toBe('the prompt');
    expect(args).toContain('--no-session');
    expect(args).toContain('--tools');
    expect(args).toContain('read,bash,edit,write');
  });

  test('codex: positional after `exec` subcommand', () => {
    const args = buildArguments(codex, 'the prompt', undefined, [], 600);
    expect(args[0]).toBe('exec');
    expect(args.at(-1)).toBe('the prompt');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
  });

  test('opencode: positional after `run`, model flag is `-m`', () => {
    const args = buildArguments(opencode, 'the prompt', { model: 'gpt-5' }, [], 600);
    expect(args[0]).toBe('run');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5');
    expect(args.at(-1)).toBe('the prompt');
  });

  test('agy: timeout flag carries `<seconds>s` suffix', () => {
    const args = buildArguments(agy, 'the prompt', undefined, [], 600);
    expect(args).toContain('--print-timeout');
    expect(args).toContain('600s');
    expect(args).toContain('--dangerously-skip-permissions');
  });

  test('empty strings and zero budget are treated as unset', () => {
    const args = buildArguments(
      claude,
      'the prompt',
      { model: '', max_budget_usd: 0, permission_mode: '', effort: '' },
      [],
      600
    );
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--max-budget-usd');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--effort');
  });
});
