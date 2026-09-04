/**
 * The daemon compiles a bundled connector for the ISOLATE, always.
 *
 * There is one executor: `selectExecutor` returns an `IsolateExecutor` whatever
 * the job says. The compiler must not disagree with it. This used to be a pair
 * of matching branches on `job.lane` — one choosing the executor, one choosing
 * the compiler — and when the process lane was deleted only the executor half
 * was collapsed. The compiler half then fell through to the SDK-EXTERNALIZED
 * ESM build for every job, because the gateway sends no `lane` at all.
 *
 * That bundle cannot run in an isolate: it has bare imports and no module
 * loader to resolve them. It reaches production on the FLEET worker path, where
 * the gateway deliberately omits `compiled_code` and has the worker compile
 * from its own image (lobu#772), so no test carrying `compiled_code` can see it.
 *
 * The assertions below are about the ARTIFACT, not the flag: a bundle that
 * survives `assertIsolateEligible` and inlines the SDK. A future job field
 * cannot quietly reintroduce the split.
 */
import { describe, expect, it } from 'bun:test';
import type { PollResponse } from '@lobu/core/contracts/worker/protocol';
import { resolveJobCode } from '../daemon/executor.js';
import { assertIsolateEligible } from '../isolate/eligibility.js';

function sourceBackedJob(overrides: Partial<PollResponse> = {}): PollResponse {
  // No `compiled_code`: the fleet-worker shape, where the worker compiles the
  // bundled source out of its own image.
  return { run_id: 1, run_type: 'sync', connector_key: 'hackernews', ...overrides } as PollResponse;
}

describe('resolveJobCode', () => {
  it('compiles an isolate-loadable bundle when the job carries no lane', async () => {
    const result = await resolveJobCode(sourceBackedJob());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => assertIsolateEligible(result.code, 'hackernews')).not.toThrow();
    // The SDK is INLINED for the isolate; the other build leaves it external.
    expect(result.code).not.toMatch(/from\s+['"]@lobu\/connector-sdk['"]/);
    expect(result.code).not.toMatch(/require\(\s*['"]@lobu\/connector-sdk['"]\s*\)/);
  }, 120_000);

  it('ignores a stale lane on the job rather than compiling a bundle it cannot run', async () => {
    // An older gateway may still stamp the retired value. The worker must not
    // change what it builds because of it.
    const stale = await resolveJobCode(sourceBackedJob({ lane: 'process' } as Partial<PollResponse>));
    const current = await resolveJobCode(sourceBackedJob({ lane: 'isolate' } as Partial<PollResponse>));
    expect(stale.ok).toBe(true);
    expect(current.ok).toBe(true);
    if (!stale.ok || !current.ok) return;
    expect(() => assertIsolateEligible(stale.code, 'hackernews')).not.toThrow();
    expect(stale.code).toBe(current.code);
  }, 120_000);
});
