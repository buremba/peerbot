import { describe, expect, it } from 'bun:test';
import type { ExecutorJob } from '../executor/interface.js';
import { IsolateExecutor, IsolateRuntimeUnavailableError } from '../executor/isolate.js';
import { IsolateLaneIneligibleError } from '../isolate/eligibility.js';

const job: ExecutorJob = {
  mode: 'sync',
  feedKey: 'f',
  config: {},
  checkpoint: null,
  entityIds: [],
  credentials: null,
  sessionState: null,
  env: {},
};

describe('IsolateExecutor options', () => {
  it('accepts the defaults and partial overrides', () => {
    expect(() => new IsolateExecutor()).not.toThrow();
    expect(() => new IsolateExecutor({ timeoutMs: 0, memoryMb: 8, allowedDomains: ['Example.COM'] })).not.toThrow();
    // An empty allowlist is the default and means egress is closed, not misconfigured.
    expect(() => new IsolateExecutor({ allowedDomains: [] })).not.toThrow();
    expect(() => new IsolateExecutor({ timeoutMs: undefined })).not.toThrow();
  });

  it('rejects out-of-range limits', () => {
    expect(() => new IsolateExecutor({ timeoutMs: -1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ timeoutMs: Number.NaN })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ memoryMb: 4 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ messageBytes: 512 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ fetchBodyBytes: 1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ logBytes: 1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ allowedDomains: ['  '] })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ allowedDomains: ['example.com', ''] })).toThrow(RangeError);
  });

  it('rejects a bundle that still requires a Node builtin before touching isolated-vm', async () => {
    const failure = await new IsolateExecutor()
      .execute('var fs = require("node:fs"); module.exports.default = class {};', job)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateLaneIneligibleError);
    expect((failure as IsolateLaneIneligibleError).builtins).toEqual(['fs']);
  });

  it('fails an eligible run loudly when isolated-vm is unavailable (Bun)', async () => {
    const failure = await new IsolateExecutor()
      .execute('module.exports.default = class { sync() {} execute() {} };', job)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateRuntimeUnavailableError);
    expect((failure as Error).message).toMatch(
      /^isolate lane required but isolated-vm is unavailable on this worker \(Bun [^)]+\)/
    );
  });

  it('refuses nix packages: there is no shell around an isolate', async () => {
    const failure = await new IsolateExecutor()
      .execute('module.exports.default = class { sync() {} execute() {} };', job, undefined, {
        nixPackages: ['ffmpeg'],
      })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('native packages [ffmpeg]');
    expect((failure as Error).message).toContain('process lane');
  });
});
