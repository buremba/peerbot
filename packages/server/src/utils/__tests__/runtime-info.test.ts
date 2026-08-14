import { describe, expect, it } from 'vitest';
import {
  getRuntimeInfo,
  resolveRuntimeEnvironment,
  resolveSentryRuntime,
} from '../runtime-info';

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

describe('resolveSentryRuntime', () => {
  it('ignores the baked-in NODE_ENV=production when ENVIRONMENT is missing', () => {
    // Docker images always set NODE_ENV=production; only an explicit
    // ENVIRONMENT in the supplied snapshot may tag Sentry events as production.
    // An unrelated host value must not leak into an explicit test/runtime snapshot.
    const previousEnvironment = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'production';
    try {
      expect(resolveSentryRuntime({ NODE_ENV: 'production' })).toEqual({
        environment: 'development',
        isDevelopment: true,
        devTaggedAsProduction: false,
      });
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = previousEnvironment;
      }
    }
  });

  it('tags production only when ENVIRONMENT declares it', () => {
    expect(
      resolveSentryRuntime({ ENVIRONMENT: 'production', NODE_ENV: 'production' })
    ).toEqual({
      environment: 'production',
      isDevelopment: false,
      devTaggedAsProduction: false,
    });
  });

  it('downgrades only a development runtime carrying a production tag', () => {
    expect(
      resolveSentryRuntime({ ENVIRONMENT: 'production', NODE_ENV: 'development' })
    ).toEqual({
      environment: 'development',
      isDevelopment: true,
      devTaggedAsProduction: true,
    });
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
