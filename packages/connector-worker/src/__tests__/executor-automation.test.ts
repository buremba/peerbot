/**
 * Headless Automation execution lane — tests through the AutomationRunIo seam.
 *
 * The daemon claims `run_type='automation'` runs only when it advertises
 * `automations.execute` (server-side gate in worker-api/poll.ts); once
 * claimed, the executor must reach a TERMINAL state via complete-automation
 * for every outcome: clean exit, CLI failure, timeout, or an unexpected throw.
 *
 * These tests exercise the dispatchAutomationResumeLoop via its injected IO
 * seam — no real subprocesses are spawned, keeping tests fast and hermetic.
 */

import { describe, expect, test } from 'bun:test';

import {
  dispatchAutomationResumeLoop,
  type AutomationRunIo,
  type ExecutorResult,
} from '../daemon/automation.js';
import type { CompleteAutomationRequest } from '@lobu/core/contracts/worker/protocol';

function makeResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    output: 'fake output',
    error: null,
    exitCode: 0,
    exitSignal: null,
    exitReason: 'ok',
    durationMs: 100,
    ...overrides,
  };
}

describe('dispatchAutomationResumeLoop', () => {
  test('clean exit reports success and returns', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          exit_code: result.exitCode,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_code).toBe(0);
    expect(reports[0]!.exit_reason).toBe('ok');
  });

  test('non-zero exit delivers error via report', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult({ exitCode: 3, error: 'boom', exitReason: 'crash' }); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          error: result.error ?? undefined,
          exit_code: result.exitCode,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_code).toBe(3);
    expect(reports[0]!.exit_reason).toBe('crash');
    expect(reports[0]!.error).toBe('boom');
  });

  test('signal exit is reported', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult({ exitCode: null, exitSignal: 'SIGTERM', exitReason: 'timeout' }); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          exit_signal: result.exitSignal,
          exit_reason: result.exitReason,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]!.exit_signal).toBe('SIGTERM');
  });

  test('resume response re-spawns with nudge', async () => {
    let round = 0;
    const reports: CompleteAutomationRequest[] = [];
    const runs: (string | undefined)[] = [];
    const io: AutomationRunIo = {
      async run(nudge) {
        round++;
        runs.push(nudge);
        if (round === 1) return makeResult({ output: 'partial work' });
        return makeResult({ output: 'done' });
      },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        if (round === 1) {
          return { ok: true, status: 'resume', attempt: 1, max_attempts: 3, nudge: 'Please finalize the window.' };
        }
        return { ok: true, status: 'completed' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(reports).toHaveLength(2);
    expect(runs[0]).toBeUndefined();
    expect(runs[1]).toContain('Please finalize the window.');
  });

  test('loop exhausted by repeated resumes returns error', async () => {
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        return { ok: true, status: 'resume', attempt: 1, max_attempts: 99, nudge: 'again' };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(reports).toHaveLength(8);
    expect(result.error).toContain('safety cap');
  });

  test('run exception reports error and returns', async () => {
    const errors: string[] = [];
    const io: AutomationRunIo = {
      async run() { throw new Error('binary not found'); },
      async deliver() { return { ok: true, status: 'completed' }; },
      async reportError(error) { errors.push(error); },
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toContain('binary not found');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('binary not found');
  });

  test('idempotent response still continues the loop (server-level idempotency)', async () => {
    let round = 0;
    const reports: CompleteAutomationRequest[] = [];
    const io: AutomationRunIo = {
      async run() {
        round++;
        return makeResult({ output: `round ${round}` });
      },
      async deliver(result, finalizeAttempt) {
        reports.push({
          worker_id: 'test-worker',
          output: result.output,
          finalize_attempt: finalizeAttempt,
        });
        if (round === 1) return { ok: true, status: 'resume', attempt: 1, max_attempts: 3, nudge: 'nudge' };
        return { ok: true, status: 'resume', idempotent: true };
      },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(reports).toHaveLength(8);
    expect(result.error).toContain('safety cap');
  });

  test('null deliver response returns without error', async () => {
    const io: AutomationRunIo = {
      async run() { return makeResult(); },
      async deliver() { return null; },
      async reportError() {},
    };

    const result = await dispatchAutomationResumeLoop(io);

    expect(result.error).toBeUndefined();
    expect(result.itemsCollected).toBe(0);
  });
});

describe('executeRun try/catch safety net', () => {
  test('catches unhandled errors and terminates the run via complete', async () => {
    const { executeRun } = await import('../daemon/executor.js');
    const completes: Array<Record<string, unknown>> = [];
    const client = {
      id: 'test-worker',
      version: 'test',
      async heartbeat() {},
      async stream() {},
      async complete(req: Record<string, unknown>) { completes.push(req); },
      async completeAction() {},
      async completeEmbeddings() {},
      async completeAuth() {},
      async emitAuthArtifact() {},
      async pollAuthSignal() { return { signal: null }; },
      async fetchEventsForEmbedding() { return []; },
      async dispatchChromeAction() { return {}; },
      async completeAutomation() { return { ok: true, status: 'completed' }; },
    };

    const result = await executeRun(
      client as any,
      { run_id: 9, run_type: 'sync' } as any,
      {}
    );

    expect(result.error).toContain('Invalid run: missing run_id or connector_key');
    expect(completes).toHaveLength(1);
    expect(completes[0]!.status).toBe('failed');
    expect(completes[0]!.run_id).toBe(9);
  });
});
