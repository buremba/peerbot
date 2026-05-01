let envResolver: ((key: string) => string | undefined) | null = null;

/**
 * Register a custom env resolver that takes priority over process.env.
 * Used by SystemEnvStore to inject runtime-resolved env vars.
 */
export function setEnvResolver(fn: (key: string) => string | undefined): void {
  envResolver = fn;
}

/**
 * Resolve an environment variable using the registered envResolver with
 * process.env as fallback. Reusable by provider modules.
 */
export function resolveEnv(key: string): string | undefined {
  return envResolver?.(key) ?? process.env[key];
}
