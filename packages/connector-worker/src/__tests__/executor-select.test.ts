import { describe, expect, it } from 'bun:test';
import { IsolateRuntimeUnavailableError } from '../executor/isolate.js';
import { selectExecutor } from '../executor/select.js';

describe('selectExecutor', () => {
  it('refuses execution when isolated-vm cannot load under Bun', async () => {
    // bun:test runs on Bun, where loadIsolatedVm() is null by construction.
    expect(typeof process.versions.bun).toBe('string');
    const failure = await selectExecutor({ timeoutMs: 1000 }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(IsolateRuntimeUnavailableError);
    expect((failure as Error).message).toMatch(
      /^isolate lane required but isolated-vm is unavailable on this worker \(Bun [^)]+\): .*Bun/
    );
  });
});
