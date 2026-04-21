/**
 * Env var names that the worker must never forward to child processes or
 * expose through bash tool invocations. Pair with `stripEnv` from @lobu/core.
 */
export const SENSITIVE_WORKER_ENV_KEYS = [
  "WORKER_TOKEN",
  "DISPATCHER_URL",
] as const;
