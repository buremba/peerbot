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
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutorJob } from '../src/executor/interface.ts';
import { SubprocessError, SubprocessExecutor } from '../src/executor/subprocess.ts';

// Minimal V1 ExecutorJob — see subprocess.test.ts for shape rationale.
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

async function runtimeDirsForThisProcess(): Promise<string[]> {
  return runtimeDirsFor(process.pid, process.cwd());
}

async function runtimeDirsFor(pid: number, cwd: string): Promise<string[]> {
  const prefix = `.connector-child-${pid}-`;
  return (await readdir(cwd)).filter((name) => name.startsWith(prefix));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
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
        BASE_JOB
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

  test('uses Bun for child-runner.ts inside a nix-shell wrapper', async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), 'lobu-fake-nix-shell-'));
    const fakeNixShell = join(fakeBin, 'nix-shell');
    await writeFile(
      fakeNixShell,
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--run" ]; then
    shift
    exec /bin/sh -c "$1"
  fi
  shift
done
exit 2
`,
      { mode: 0o755 }
    );
    await chmod(fakeNixShell, 0o755);

    // Run in a clean process whose PATH is fixed before subprocess.ts is
    // imported. hasNixShell() deliberately memoizes its production probe;
    // mutating this test runner's process-global PATH could otherwise inherit a
    // cached "missing" result from another test file on a Nix-less CI host.
    const subprocessUrl = new URL('../src/executor/subprocess.ts', import.meta.url).href;
    const probe = `
      const { SubprocessExecutor } = await import(${JSON.stringify(subprocessUrl)});
      try {
        const result = await new SubprocessExecutor({
          timeoutMs: 30_000,
          maxOldSpaceSize: 256
        }).execute(
          ${JSON.stringify(compiled(`return { events: [], checkpoint: null };`))},
          ${JSON.stringify(BASE_JOB)},
          undefined,
          { nixPackages: ['curl'] }
        );
        process.exit(result.mode === 'sync' ? 0 : 2);
      } catch (error) {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      }
    `;

    try {
      const probeProcess = Bun.spawn([process.execPath, '--eval', probe], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        probeProcess.exited,
        new Response(probeProcess.stdout).text(),
        new Response(probeProcess.stderr).text(),
      ]);
      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test('cleans child artifacts and rejects by deadline when a terminal result waits on a hung hook', async () => {
    expect(await runtimeDirsForThisProcess()).toEqual([]);

    const neverResolvingHook = new Promise<void>(() => {});
    let reportHookStarted!: () => void;
    const hookStarted = new Promise<void>((resolve) => {
      reportHookStarted = resolve;
    });
    let executionSettled = false;
    const startedAt = Date.now();
    // Leave loaded CI enough time to observe cleanup before the deadline settles the execution.
    const executor = new SubprocessExecutor({ timeoutMs: 3_000, maxOldSpaceSize: 256 });
    const outcome = executor
      .execute(
        compiled(`
          await _ctx.emitEvents([{ type: 'upsert', entity: { id: 'cleanup-test' } }]);
          return { events: [], checkpoint: null };
        `),
        BASE_JOB,
        {
          onEventChunk: async () => {
            reportHookStarted();
            await neverResolvingHook;
          },
        }
      )
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error })
      )
      .finally(() => {
        executionSettled = true;
      });

    await hookStarted;
    await waitFor(async () => (await runtimeDirsForThisProcess()).length === 0);
    // Before the deadline, result settlement still waits for the ordered hook.
    expect(executionSettled).toBe(false);

    const { result, error } = await outcome;
    expect(result).toBeNull();
    expect(error).toBeInstanceOf(SubprocessError);
    expect((error as SubprocessError).exitReason).toBe('timeout');
    expect((error as SubprocessError).message).toContain('timed out after 3000ms');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await runtimeDirsForThisProcess()).toEqual([]);
  });

  test('child removes its runtime directory when a detached process group receives SIGTERM', async () => {
    if (process.platform === 'win32') return;

    const isolatedCwd = await mkdtemp(join(tmpdir(), 'lobu-connector-group-shutdown-'));
    const readyMarker = join(isolatedCwd, 'connector-ready');
    const runtimeUrl = new URL('../src/executor/runtime.ts', import.meta.url).href;
    const hangingConnector = `
      export default class GroupShutdownConnector {
        async sync() {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(${JSON.stringify(readyMarker)}, 'ready');
          await new Promise(() => {});
        }
        async execute() { return { success: false, error: 'no actions' }; }
      }
    `;
    const probe = `
      const { executeCompiledConnector } = await import(${JSON.stringify(runtimeUrl)});
      await executeCompiledConnector({
        compiledCode: ${JSON.stringify(hangingConnector)},
        job: {
          mode: 'sync', feedKey: 'test', config: {}, checkpoint: null,
          entityIds: [], credentials: null, sessionState: null, env: {}
        },
        timeoutMs: 0
      });
    `;

    const probeProcess = spawn(process.execPath, ['--eval', probe], {
      cwd: isolatedCwd,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const probePid = probeProcess.pid;
    if (!probePid || probePid <= 1) {
      probeProcess.kill('SIGKILL');
      await rm(isolatedCwd, { recursive: true, force: true });
      throw new Error('Detached shutdown probe did not receive a safe process id');
    }
    let stderr = '';
    probeProcess.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const probeExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        probeProcess.once('exit', (code, signal) => resolve({ code, signal }));
      }
    );

    try {
      await waitFor(async () => {
        const entries = await readdir(isolatedCwd);
        return (
          entries.includes('connector-ready') &&
          (await runtimeDirsFor(probePid, isolatedCwd)).length === 1
        );
      });

      // The detached probe is its process-group leader; its connector child
      // inherits that group. This reproduces service shutdown signaling both
      // processes before an IPC disconnect can drive cleanup.
      process.kill(-probePid, 'SIGTERM');
      const exit = await Promise.race([
        probeExit,
        Bun.sleep(5_000).then(() => {
          throw new Error(`Detached shutdown probe did not exit: ${stderr}`);
        }),
      ]);
      expect(exit.signal === 'SIGTERM' || exit.code === 143, stderr).toBe(true);
      await waitFor(async () => (await runtimeDirsFor(probePid, isolatedCwd)).length === 0);
    } finally {
      try {
        process.kill(-probePid, 'SIGKILL');
      } catch {
        // The process group exited as expected.
      }
      await rm(isolatedCwd, { recursive: true, force: true });
    }
  });

  test('resolves runtime-provided packages when the daemon cwd has no node_modules', async () => {
    const isolatedCwd = await mkdtemp(join(tmpdir(), 'lobu-connector-runtime-cwd-'));
    const runtimeUrl = new URL('../src/executor/runtime.ts', import.meta.url).href;
    const sdkConnector = `
      import { nixPackageAttrRef } from '@lobu/connector-sdk/nix-package';
      export default class RuntimeDependencyConnector {
        async sync() {
          if (nixPackageAttrRef('curl') !== 'pkgs.curl') throw new Error('SDK subpath failed');
          return { events: [], checkpoint: null };
        }
        async execute() { return { success: false, error: 'no actions' }; }
      }
    `;
    const probe = `
      const { executeCompiledConnector } = await import(${JSON.stringify(runtimeUrl)});
      try {
        const result = await executeCompiledConnector({
          compiledCode: ${JSON.stringify(sdkConnector)},
          job: {
            mode: 'sync', feedKey: 'test', config: {}, checkpoint: null,
            entityIds: [], credentials: null, sessionState: null, env: {}
          },
          timeoutMs: 30_000
        });
        process.exit(result.mode === 'sync' ? 0 : 2);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `;

    try {
      const child = Bun.spawn([process.execPath, '--eval', probe], {
        cwd: isolatedCwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(await readdir(isolatedCwd)).toEqual([]);
    } finally {
      await rm(isolatedCwd, { recursive: true, force: true });
    }
  });
});
