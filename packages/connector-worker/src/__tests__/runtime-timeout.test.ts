import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SLOW_CONNECTOR = `
export class SlowConnector {
  async sync() { return { events: [], checkpoint: null }; }
  async execute() { return { output: {} }; }
  async query() {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return { rows: [], columns: [] };
  }
}
`;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for probe state');
    await Bun.sleep(25);
  }
}

describe('executeCompiledConnector timeout', () => {
  it('kills the connector subprocess at the caller deadline', async () => {
    const startedAt = Date.now();
    const isolatedTempRoot = await mkdtemp(
      join(tmpdir(), 'lobu-runtime-timeout-test-')
    );
    const runtimeUrl = new URL('../executor/runtime.ts', import.meta.url).href;
    // Several worker tests use Bun's process-global mock.module on this seam.
    // Exercise the real runtime in a clean process so test order cannot replace
    // SubprocessExecutor with another file's stub.
    const probe = `
      const backup = setTimeout(() => process.exit(3), 5_000);
      const { executeCompiledConnector } = await import(${JSON.stringify(runtimeUrl)});
      try {
        await executeCompiledConnector({
          compiledCode: ${JSON.stringify(SLOW_CONNECTOR)},
          job: {
            mode: 'query', query: 'SELECT 1', config: {}, credentials: null,
            sessionState: null, env: {}
          },
          timeoutMs: 100
        });
        process.exit(2);
      } catch (error) {
        clearTimeout(backup);
        process.exit(error?.exitReason === 'timeout' ? 0 : 1);
      }
    `;
    try {
      const child = Bun.spawn([process.execPath, '--eval', probe], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          TMPDIR: isolatedTempRoot,
          TMP: isolatedTempRoot,
          TEMP: isolatedTempRoot,
        },
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      if (exitCode !== 0) {
        throw new Error(`timeout probe exited ${exitCode}: ${stderr}`);
      }
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await readdir(isolatedTempRoot)).toEqual([]);
    } finally {
      await rm(isolatedTempRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'removes the runtime directory when the parent is killed',
    async () => {
      const isolatedTempRoot = await mkdtemp(
        join(tmpdir(), 'lobu-runtime-parent-death-test-')
      );
      const runtimeUrl = new URL(
        '../../dist/executor/runtime.js',
        import.meta.url
      ).href;
      const probe = `
        const { executeCompiledConnector } = await import(${JSON.stringify(
          runtimeUrl
        )});
        await executeCompiledConnector({
          compiledCode: ${JSON.stringify(SLOW_CONNECTOR)},
          job: {
            mode: 'query', query: 'SELECT 1', config: {}, credentials: null,
            sessionState: null, env: {}
          },
          timeoutMs: 60_000
        });
      `;
      const env = {
        ...process.env,
        TMPDIR: isolatedTempRoot,
        TMP: isolatedTempRoot,
        TEMP: isolatedTempRoot,
      };
      delete env.NODE_PATH;
      const parent = Bun.spawn(
        ['node', '--input-type=module', '--eval', probe],
        { stdout: 'pipe', stderr: 'pipe', env }
      );

      try {
        await waitFor(async () => {
          const entries = await readdir(isolatedTempRoot);
          return entries.some((entry) =>
            existsSync(join(isolatedTempRoot, entry, 'connector.mjs'))
          );
        });
        parent.kill('SIGKILL');
        await parent.exited;
        await waitFor(async () => (await readdir(isolatedTempRoot)).length === 0);
      } finally {
        try {
          parent.kill('SIGKILL');
        } catch {
          // Already exited.
        }
        await rm(isolatedTempRoot, { recursive: true, force: true });
      }
    }
  );
});
