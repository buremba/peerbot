import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { AutomationPollPayload, PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun, isInteractiveSessionEligible } from '../daemon/automation.js';
import { executeRun } from '../daemon/executor.js';
import { executeRun } from '../daemon/executor.js';
import * as interactive from '../daemon/interactive-session.js';
import { resolveDaemonWorkerId } from '../daemon/start.js';

function payload(agentKind: 'claude-code' | 'pi' = 'claude-code'): AutomationPollPayload {
  return {
    automation: {
      id: 'automation-1',
      name: 'Inside Claude test',
      agent_kind: agentKind,
      prompt: 'Do the bounded work',
    },
    event: { fired_at: '2026-08-21T00:00:00.000Z', payload: {} },
    context: {
      device: { worker_id: 'worker-test' },
      user: { user_id: 'user-test' },
      agent_session: {
        conversation_id: 'agent_automation_1_run_91',
        mcp_url: 'https://gateway.test/mcp/test',
        token: 'run-token',
        expires_at: Date.now() + 60_000,
      },
    },
  };
}

afterEach(() => {
  mock.restore();
});

describe('interactive-session routing', () => {
  test('an explicit worker id wins over the inside-Claude derived identity', () => {
    expect(
      resolveDaemonWorkerId(
        { workerId: 'headless:operator-selected' },
        'headless',
        'test-host',
        { kind: 'codex', sessionId: 'session-a', threadId: 'session-a' }
      )
    ).toBe('headless:operator-selected');
  });

  test('requires a matching session kind and a run-scoped agent session', () => {
    const claude = payload();
    const session: interactive.InteractiveSession = {
      kind: 'claude-code',
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    expect(isInteractiveSessionEligible('claude-code', session, claude)).toBe(true);
    expect(isInteractiveSessionEligible('claude-code', undefined, claude)).toBe(false);
    expect(isInteractiveSessionEligible('pi', session, payload('pi'))).toBe(false);
    delete claude.context.agent_session;
    expect(isInteractiveSessionEligible('claude-code', session, claude)).toBe(false);
  });

  test('never falls back to a subprocess after a prior parent write', async () => {
    const session: interactive.ParentClaudeSession = {
      kind: 'claude-code',
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    spyOn(interactive, 'detectInteractiveSession').mockReturnValue({ ok: true, session });
    let finishParent!: () => void;
    const parentCompletion = new Promise<interactive.InteractiveSessionCompletion>((resolve) => {
      finishParent = () =>
        resolve({ kind: 'completed', durationMs: 12, output: 'parent answer' });
    });
    const handoff = spyOn(interactive, 'handoffToInteractiveSession')
      .mockResolvedValueOnce({
        kind: 'handed-off',
        certainty: 'possible',
        helperPath: '/private/helper',
        completion: parentCompletion,
      })
      .mockResolvedValueOnce({ kind: 'not-delivered', reason: 'inbox closed' });

    const reports: Array<Record<string, unknown>> = [];
    let heartbeats = 0;
    const client = {
      id: 'worker-test',
      mcpWiring: undefined,
      async heartbeat() {
        heartbeats++;
      },
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        reports.push(request);
        return reports.length === 1
          ? { ok: true, status: 'resume', attempt: 1, nudge: 'finish the window' }
          : { ok: true, status: 'completed' };
      },
    };
    const job: PollResponse = {
      run_id: 91,
      run_type: 'automation',
      payload: payload(),
    };

    const execution = executeAutomationRun(client as never, job, {
      insideClaude: true,
      heartbeatIntervalMs: 5,
      binaryOverrides: { 'claude-code': '/definitely/not/a/claude/binary' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishParent();
    await execution;

    expect(handoff).toHaveBeenCalledTimes(2);
    expect(handoff.mock.calls[0]?.[0].prompt).toContain('completeWindow');
    expect(handoff.mock.calls[0]?.[0].prompt).not.toContain('Do NOT call completeWindow');
    expect(heartbeats).toBeGreaterThan(0);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.exit_reason).toBe('ok');
    expect(reports[0]?.output).toBe('parent answer');
    expect(reports[1]?.exit_reason).toBe('crash');
    expect(reports[1]?.error).toBe('interactive claude-code delivery failed: inbox closed');
  });

  test('passes the turn contract to the parent and reports its final result', async () => {
    const session: interactive.ParentClaudeSession = {
      kind: 'claude-code',
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    spyOn(interactive, 'detectInteractiveSession').mockReturnValue({ ok: true, session });
    const handoff = spyOn(interactive, 'handoffToInteractiveSession').mockResolvedValue({
      kind: 'handed-off',
      certainty: 'possible',
      helperPath: '/private/helper',
      completion: Promise.resolve({
        kind: 'completed',
        durationMs: 12,
        output: 'turn parent result',
      }),
    });

    const reports: Array<Record<string, unknown>> = [];
    const client = {
      id: 'worker-test',
      mcpWiring: undefined,
      async heartbeat() {},
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        reports.push(request);
        return { ok: true, status: 'completed' };
      },
    };
    const turnPayload = payload();
    turnPayload.event.payload = { trigger_execution: 'turn' };

    await executeAutomationRun(
      client as never,
      { run_id: 93, run_type: 'automation', payload: turnPayload } satisfies PollResponse,
      { insideClaude: true, binaryOverrides: { 'claude-code': '/never/spawned' } }
    );

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff.mock.calls[0]?.[0].prompt).toContain('Do NOT call completeWindow');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.output).toBe('turn parent result');
  });

  test('reports no exit code or OS signal, because no child process ran', async () => {
    const session: interactive.ParentClaudeSession = {
      kind: 'claude-code',
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    spyOn(interactive, 'detectInteractiveSession').mockReturnValue({ ok: true, session });
    spyOn(interactive, 'handoffToInteractiveSession').mockResolvedValue({
      kind: 'handed-off',
      certainty: 'possible',
      helperPath: '/private/helper',
      completion: Promise.resolve({
        kind: 'shutdown',
        durationMs: 12,
        error: 'daemon shut down before parent Claude completed the Automation',
      }),
    });

    const reports: Array<Record<string, unknown>> = [];
    const client = {
      id: 'worker-test',
      mcpWiring: undefined,
      async heartbeat() {},
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        reports.push(request);
        return { ok: true, status: 'completed' };
      },
    };

    await executeAutomationRun(
      client as never,
      { run_id: 92, run_type: 'automation', payload: payload() } satisfies PollResponse,
      { insideClaude: true, binaryOverrides: { 'claude-code': '/definitely/not/a/claude/binary' } }
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]?.exit_reason).toBe('crash');
    expect(reports[0]?.exit_code).toBeNull();
    expect(reports[0]?.exit_signal).toBeNull();
    expect(reports[0]?.error).toBe(
      'daemon shut down before parent Claude completed the Automation'
    );
  });

  test('Codex handoff preserves completion and finalize-resume semantics without subprocess fallback', async () => {
    const session: interactive.CodexInteractiveSession = {
      kind: 'codex',
      sessionId: 'thread-exact',
      threadId: 'thread-exact',
    };
    const handoff = spyOn(interactive, 'handoffToInteractiveSession')
      .mockResolvedValueOnce({
        kind: 'handed-off',
        certainty: 'acknowledged',
        helperPath: '/private/codex-helper-1',
        completion: Promise.resolve({ kind: 'completed', durationMs: 12, output: 'round one' }),
      })
      .mockResolvedValueOnce({
        kind: 'handed-off',
        certainty: 'acknowledged',
        helperPath: '/private/codex-helper-2',
        completion: Promise.resolve({ kind: 'completed', durationMs: 8, output: 'round two' }),
      });
    const reports: Array<Record<string, unknown>> = [];
    const client = {
      id: 'worker-codex',
      async heartbeat() {},
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        reports.push(request);
        return reports.length === 1
          ? { ok: true, status: 'resume', attempt: 1, nudge: 'complete the window now' }
          : { ok: true, status: 'completed' };
      },
    };
    const codexPayload = payload();
    codexPayload.automation.agent_kind = 'codex';

    const config = interactive.attachInteractiveSession(
      {
        binaryOverrides: { codex: '/definitely/not/a/subprocess-codex' },
      },
      session
    );
    await executeAutomationRun(
      client as never,
      { run_id: 94, run_type: 'automation', payload: codexPayload } satisfies PollResponse,
      config
    );

    expect(handoff).toHaveBeenCalledTimes(2);
    expect(handoff.mock.calls[0]?.[0].codexCommand).toBe('/definitely/not/a/subprocess-codex');
    expect(handoff.mock.calls[1]?.[0].prompt).toContain('complete the window now');
    expect(reports.map((report) => report.output)).toEqual(['round one', 'round two']);
    expect(reports.every((report) => report.exit_reason === 'ok')).toBe(true);
  });

  test('executeRun carries the attached session into the automation arm', async () => {
    // The session rides on a non-enumerable symbol, so any spread of the
    // executor config silently drops it and the run falls back to a subprocess.
    const session: interactive.CodexInteractiveSession = {
      kind: 'codex',
      sessionId: 'thread-through-execute-run',
      threadId: 'thread-through-execute-run',
    };
    const handoff = spyOn(interactive, 'handoffToInteractiveSession').mockResolvedValue({
      kind: 'handed-off',
      certainty: 'acknowledged',
      helperPath: '/private/codex-helper',
      completion: Promise.resolve({ kind: 'completed', durationMs: 5, output: 'via executeRun' }),
    });
    const reports: Array<Record<string, unknown>> = [];
    const client = {
      id: 'worker-codex',
      async heartbeat() {},
      async completeAutomation(_runId: number, request: Record<string, unknown>) {
        reports.push(request);
        return { ok: true, status: 'completed' };
      },
    };
    const codexPayload = payload();
    codexPayload.automation.agent_kind = 'codex';

    const executorConfig = interactive.attachInteractiveSession(
      { binaryOverrides: { codex: '/definitely/not/a/subprocess-codex' } },
      session
    );
    await executeRun(
      client as never,
      { run_id: 95, run_type: 'automation', payload: codexPayload } satisfies PollResponse,
      {} as never,
      executorConfig
    );

    expect(handoff).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.output).toBe('via executeRun');
  });
});
