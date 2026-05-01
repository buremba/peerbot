import { describe, expect, it } from 'vitest';
import { getRuntimeInfo, resolveRuntimeEnvironment } from '../runtime-info';

describe('resolveRuntimeEnvironment', () => {
  it('prefers ENVIRONMENT over NODE_ENV', () => {
    expect(resolveRuntimeEnvironment({ ENVIRONMENT: 'production', NODE_ENV: 'development' })).toBe(
      'production'
    );
  });

  it('falls back to NODE_ENV when ENVIRONMENT is missing', () => {
    expect(resolveRuntimeEnvironment({ NODE_ENV: 'production' })).toBe('production');
  });
});

describe('getRuntimeInfo', () => {
  it('returns revision and build metadata from env', () => {
    expect(
      getRuntimeInfo({
        NODE_ENV: 'production',
        APP_GIT_SHA: 'abc123',
        APP_BUILD_TIME: '2026-04-12T23:00:00Z',
      })
    ).toMatchObject({
      environment: 'production',
      revision: 'abc123',
      build_time: '2026-04-12T23:00:00Z',
    });
  });
});
