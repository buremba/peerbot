/**
 * Source-mode regression test for the Bun-fork fix.
 *
 * The diagnostic suite in subprocess.test.ts imports from `../dist/`, which
 * means SubprocessExecutor's internal `__dirname` resolves to the dist/
 * folder where `child-runner.js` exists. That path takes the .js branch and
 * does NOT exercise the .ts fallback that runs in production worker pods.
 *
 * Production workers run `bun src/bin.ts daemon` — the SubprocessExecutor
 * loaded from src/ has only `child-runner.ts` next to it, so the executor
 * falls through to the second branch and (before this fix) added
 * `--import tsx` to execArgv, which crashed Bun children with
 * `Cannot find module './cjs/index.cjs' from ''`.
 *
 * This file imports SubprocessExecutor from `../src/executor/subprocess.ts`
 * so the test runner reproduces the source-mode environment. Bun runs .ts
 * natively, so the import works as-is.
 */
import { describe, expect, test } from 'bun:test';
import type { SyncContext } from '../src/executor/interface.ts';
import { SubprocessError, SubprocessExecutor } from '../src/executor/subprocess.ts';

const BASE_CONTEXT: SyncContext = {
  options: {} as any,
  checkpoint: null,
  env: {},
  apiType: 'api',
};

function compiled(body: string): string {
  return `
    class ConnectorRuntime {
      async sync(_ctx, _hooks) {
        ${body}
      }
      async execute() { return { contents: [], checkpoint: null }; }
    }
    module.exports = { ConnectorRuntime };
  `;
}

describe('SubprocessExecutor (source-mode, Bun runtime)', () => {
  test('forks child-runner.ts on Bun without crashing on tsx loader', async () => {
    // Sanity check: confirm we are actually exercising the .ts branch.
    expect(typeof (process.versions as { bun?: string }).bun).toBe('string');

    const executor = new SubprocessExecutor({ timeoutMs: 30_000, maxOldSpaceSize: 256 });
    let err: SubprocessError | null = null;
    try {
      await executor.execute(
        compiled(`
          console.log('source-mode child ran');
          process.exit(1);
        `),
        BASE_CONTEXT
      );
    } catch (e) {
      err = e as SubprocessError;
    }

    // Before the fix, the child crashed with
    //   "Cannot find module './cjs/index.cjs' from ''"
    // and exitCode was 1 with a tsx-loader stderr in outputTail. The fix
    // removes --import tsx on Bun, so the child now reaches our compiled
    // connector code and we see the expected diagnostic output.
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err!.outputTail).toContain('source-mode child ran');
    expect(err!.outputTail ?? '').not.toContain("Cannot find module './cjs/index.cjs'");
    expect(err!.exitReason).toBe('crash');
  });
});
