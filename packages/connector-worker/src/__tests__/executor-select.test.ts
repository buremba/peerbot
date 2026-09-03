import { describe, expect, it, mock } from 'bun:test';

let subprocessConstructions = 0;

mock.module('../executor/subprocess.js', () => ({
  SubprocessExecutor: class {
    constructor(_opts?: unknown) {
      subprocessConstructions += 1;
    }
  },
  SubprocessError: class extends Error {},
  RingBuffer: class {},
}));

import { IsolateRuntimeUnavailableError } from '../executor/isolate.js';
import { selectExecutor } from '../executor/select.js';

describe('selectExecutor', () => {
  it('runs unlaned and process-lane jobs on the process lane', async () => {
    const before = subprocessConstructions;
    await selectExecutor({});
    await selectExecutor({ lane: null });
    await selectExecutor({ lane: 'process', timeoutMs: 1000, maxOldSpaceSize: 256 });
    expect(subprocessConstructions).toBe(before + 3);
  });

  it('refuses an isolate-lane job when isolated-vm cannot load, never falling back to a child process', async () => {
    // bun:test runs on Bun, where loadIsolatedVm() is null by construction.
    expect(typeof process.versions.bun).toBe('string');
    const before = subprocessConstructions;
    const failure = await selectExecutor({ lane: 'isolate', timeoutMs: 1000 }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(IsolateRuntimeUnavailableError);
    expect((failure as Error).message).toMatch(
      /^isolate lane required but isolated-vm is unavailable on this worker \(Bun [^)]+\): .*Bun/
    );
    expect(subprocessConstructions).toBe(before);
  });
});
