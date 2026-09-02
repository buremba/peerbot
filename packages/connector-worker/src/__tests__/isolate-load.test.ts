import { describe, expect, it } from 'bun:test';
import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';

describe('loadIsolatedVm under Bun', () => {
  it('reports null and names Bun as the reason', async () => {
    // bun:test always runs on Bun, which cannot load the isolated-vm addon.
    expect(typeof process.versions.bun).toBe('string');
    expect(await loadIsolatedVm()).toBeNull();
    // Memoized: a second call must not retry the import.
    expect(await loadIsolatedVm()).toBeNull();
    expect(isolatedVmUnavailableReason()).toMatch(/Bun/);
  });
});
