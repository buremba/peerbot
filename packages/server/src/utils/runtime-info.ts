import packageJson from '../../package.json';

interface RuntimeEnvLike {
  ENVIRONMENT?: string;
  NODE_ENV?: string;
  APP_GIT_SHA?: string;
  APP_BUILD_TIME?: string;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveRuntimeEnvironment(env?: RuntimeEnvLike | null): string {
  return (
    cleanString(env?.ENVIRONMENT) ||
    cleanString(env?.NODE_ENV) ||
    cleanString(process.env.ENVIRONMENT) ||
    cleanString(process.env.NODE_ENV) ||
    'development'
  );
}

export function getRuntimeInfo(env?: RuntimeEnvLike | null) {
  return {
    version: packageJson.version,
    revision:
      cleanString(env?.APP_GIT_SHA) ||
      cleanString(process.env.APP_GIT_SHA) ||
      'unknown',
    build_time:
      cleanString(env?.APP_BUILD_TIME) ||
      cleanString(process.env.APP_BUILD_TIME) ||
      null,
    environment: resolveRuntimeEnvironment(env),
  };
}
