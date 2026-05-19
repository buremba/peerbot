/**
 * Connector-runtime env whitelist.
 *
 * Connector subprocesses (`SubprocessExecutor.fork`) inherit
 * `context.env`, which becomes `process.env` inside the connector child.
 * The standalone `connector-worker` CLI builds this set deliberately so
 * connectors only see the env vars they actually need (GitHub token,
 * provider API keys, etc.) — never the host process's secrets.
 *
 * Used by both the standalone CLI (`bin.ts`) and the in-process embedded
 * worker (`packages/server/src/scheduled/embedded-connector-worker.ts`).
 * Lives in its own module so the embedded worker can import the helper
 * without pulling in `bin.ts`'s top-level `main()` call (which would
 * print CLI usage and `process.exit` on startup).
 */

import type { Env } from '@lobu/connector-sdk';

export function buildConnectorWorkerEnv(): Env {
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    X_USERNAME: process.env.X_USERNAME,
    X_PASSWORD: process.env.X_PASSWORD,
    X_EMAIL: process.env.X_EMAIL,
    X_2FA_SECRET: process.env.X_2FA_SECRET,
    X_COOKIES: process.env.X_COOKIES,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
    WORKER_API_TOKEN: process.env.WORKER_API_TOKEN,
  };
}
