import { describe, expect, it } from 'bun:test';

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

describe('executeCompiledConnector timeout', () => {
  it('kills the connector subprocess at the caller deadline', async () => {
    const startedAt = Date.now();
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
    const child = Bun.spawn([process.execPath, '--eval', probe], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(`timeout probe exited ${exitCode}: ${stderr}`);
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
