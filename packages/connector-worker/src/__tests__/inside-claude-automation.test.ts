import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { AutomationPollPayload, PollResponse } from '@lobu/core/contracts/worker/protocol';
import { executeAutomationRun, isParentClaudeEligible } from '../daemon/automation.js';
import * as parentClaude from '../daemon/parent-claude.js';
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

describe('inside-Claude routing', () => {
  test('an explicit worker id wins over the inside-Claude derived identity', () => {
    expect(
      resolveDaemonWorkerId(
        { workerId: 'headless:operator-selected', insideClaude: true },
        'headless',
        'test-host'
      )
    ).toBe('headless:operator-selected');
  });

  test('requires the explicit flag, claude-code, and a run-scoped agent session', () => {
    const claude = payload();
    expect(isParentClaudeEligible('claude-code', true, claude)).toBe(true);
    expect(isParentClaudeEligible('claude-code', false, claude)).toBe(false);
    expect(isParentClaudeEligible('pi', true, payload('pi'))).toBe(false);
    delete claude.context.agent_session;
    expect(isParentClaudeEligible('claude-code', true, claude)).toBe(false);
  });

  test('never falls back to a subprocess after a prior parent write', async () => {
    const session: parentClaude.ParentClaudeSession = {
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    spyOn(parentClaude, 'detectParentClaudeSession').mockReturnValue({ ok: true, session });
    let finishParent!: () => void;
    const parentCompletion = new Promise<parentClaude.ParentClaudeCompletion>((resolve) => {
      finishParent = () => resolve({ kind: 'completed', durationMs: 12 });
    });
    const handoff = spyOn(parentClaude, 'handoffToParentClaude')
      .mockResolvedValueOnce({
        kind: 'handed-off',
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
    expect(heartbeats).toBeGreaterThan(0);
    expect(reports).toHaveLength(2);
    expect(reports[0]?.exit_reason).toBe('ok');
    expect(reports[1]?.exit_reason).toBe('crash');
    expect(reports[1]?.error).toBe('parent Claude delivery failed: inbox closed');
  });

  test('reports no exit code or OS signal, because no child process ran', async () => {
    const session: parentClaude.ParentClaudeSession = {
      pid: process.pid,
      sessionId: 'parent-session',
      socketPath: '/private/unused-parent.sock',
      messagingToken: 'messaging-token',
      registryPath: '/private/unused-session.json',
    };
    spyOn(parentClaude, 'detectParentClaudeSession').mockReturnValue({ ok: true, session });
    spyOn(parentClaude, 'handoffToParentClaude').mockResolvedValue({
      kind: 'handed-off',
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
});
