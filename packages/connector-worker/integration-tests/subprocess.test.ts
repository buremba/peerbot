/**
 * Integration tests for the subprocess diagnostic substrate.
 *
 * These spawn real child processes via SubprocessExecutor and require the
 * package (and its workspace deps) to be built. Run with:
 *
 *   make build-packages
 *   bun test packages/connector-worker/integration-tests
 *
 * They live outside `src/` so tsc doesn't compile them and so `bun test`
 * picked up by default test discovery doesn't pull them into unit-test
 * runs that haven't built the workspace.
 */
import { describe, expect, test } from 'bun:test';
import type { ExecutorJob } from '../dist/executor/interface.js';
import { SubprocessError, SubprocessExecutor } from '../dist/executor/subprocess.js';

// Minimal V1 ExecutorJob — the subprocess executor only reads what each
// connector body needs; the diagnostic tests below exercise the crash /
// throw / redact paths, which don't touch most fields, but the shape
// itself has to be valid `ExecutorJob` so the parent's IPC envelope is
// well-formed.
const BASE_JOB: ExecutorJob = {
  mode: 'sync',
  feedKey: 'integration-test',
  config: {},
  checkpoint: null,
  entityIds: [],
  credentials: null,
  sessionState: null,
  env: {},
};

// Synthetic connector source. The class needs `sync` and `execute` on its
// prototype for `findRuntimeClass` to accept it. `sync` receives a V1
// `SyncContext` (with `emitEvents` / `updateCheckpoint` hooks), `execute`
// returns a V1 `ActionResult` — both unused by these crash-path tests.
function compiled(body: string): string {
  return `
    class ConnectorRuntime {
      async sync(_ctx) {
        ${body}
      }
      async execute() { return { success: false, error: 'no actions' }; }
    }
    module.exports = { ConnectorRuntime };
  `;
}

describe('an orphaned chrome dispatch reply', () => {
  /**
   * A connector may fire a chrome dispatch it never awaits — a local timeout it
   * cannot cancel, a phase budget it ran out of — and then finish and exit. The
   * device's answer then arrives with no child left to receive it.
   *
   * The parent must treat that as a no-op. It used to call `child.send` inside
   * a synchronous try/catch, which does NOT catch this: Bun reports a closed
   * IPC channel asynchronously, so the rejection escaped the task queue and
   * exited the worker daemon — killing every other connector's run on that
   * worker. In prod (feed 309, 2026-09-02) it did exactly that, and on the next
   * attempt failed a sync run that had already written its 60 events.
   */
  test('does not fail the run or kill the parent when the child has exited', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let dispatched = false;
    let result: unknown = null;
    let err: SubprocessError | null = null;
    try {
      result = await executor.execute(
        compiled(`
          // Fire and DO NOT await: the run finishes while this is in flight.
          _ctx.sessionState.chrome_dispatcher.dispatch('evaluate', { expression: '1' });
          return { events: [], checkpoint: null };
        `),
        { ...BASE_JOB, sessionState: {} },
        {
          onChromeDispatch: async () => {
            dispatched = true;
            // Answer after the child is gone, the way a real device does.
            await new Promise((resolve) => setTimeout(resolve, 750));
            return { value: 1 };
          },
        }
      );
    } catch (e) {
      err = e as SubprocessError;
    }

    expect(dispatched).toBe(true);
    // The specific regression: the reply must not surface as the run's failure.
    if (err) {
      expect(err.message).not.toContain('cannot be used after the process has exited');
      expect(err.message).not.toContain('EPIPE');
    }
    expect(result ?? err).not.toBeNull();
  });
});

describe('SubprocessExecutor diagnostic capture', () => {
  test('captures stdout tail and classifies as crash on process.exit(1)', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          console.log('starting connector run');
          console.log('about to die hard');
          process.exit(1);
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitCode).toBe(1);
    expect(err!.exitSignal).toBeNull();
    expect(err!.exitReason).toBe('crash');
    expect(err!.outputTail).toContain('about to die hard');
  });

  test('thrown sync() error is caught by the runner try/catch and reported as error_message', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          throw new Error('connector blew up');
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('connector blew up');
  });

  test('uncaughtException handler catches asynchronous setTimeout throw', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          setTimeout(() => { throw new Error('async tick throw'); }, 0);
          await new Promise(() => {});
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('async tick throw');
  });

  test('unhandledRejection handler catches dangling Promise.reject', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          Promise.reject(new Error('dangling rejection'));
          await new Promise(() => {});
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('error_message');
    expect(err!.message).toContain('dangling rejection');
  });

  test('output tail is redacted before reaching the parent', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          console.error('Authorization: Bearer abc123secret456789');
          console.error('CH_API_KEY=longvaluesecret789');
          process.exit(1);
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.outputTail).not.toContain('abc123secret456789');
    expect(err!.outputTail).not.toContain('longvaluesecret789');
    expect(err!.outputTail).toContain('[REDACTED]');
  });

  test('redacts secrets embedded in a thrown Error message and stack', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          throw new Error('upstream failed: api_key=sk_live_abcdefghijklmn123');
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.message).not.toContain('sk_live_abcdefghijklmn123');
    expect(err!.message).toContain('[REDACTED]');
    if (err!.stack) {
      expect(err!.stack).not.toContain('sk_live_abcdefghijklmn123');
    }
  });

  test('preserves a missing relative-module diagnostic', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        `
          import { createRequire } from 'node:module';
          const require = createRequire(import.meta.url);
          require('./missing-relative-module.cjs');
        `,
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.message).toContain("Cannot find module './missing-relative-module.cjs'");
    expect(err!.message).not.toContain('Connector requires');
  });

  test('classifies parent-driven SIGKILL as timeout', async () => {
    const executor = new SubprocessExecutor({ timeoutMs: 1_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          await new Promise(() => {});
        `),
        BASE_JOB
      );
    } catch (e) {
      err = e as SubprocessError;
    }
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.exitReason).toBe('timeout');
  });
});
