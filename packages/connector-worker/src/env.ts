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

/** Mirror the server's isCloudMode() truthiness (1/true/yes, case-insensitive) —
 *  a bare `process.env.LOBU_CLOUD_MODE ?` would wrongly treat "0"/"false" as on.
 *  Duplicated rather than imported: connector-worker can't depend on @lobu/server. */
function cloudModeOn(): boolean {
  const v = process.env.LOBU_CLOUD_MODE?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function buildConnectorWorkerEnv(): Env {
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
    WORKER_API_TOKEN: process.env.WORKER_API_TOKEN,
    // DB connectors reject internal/metadata hosts under cloud mode; self-hosted
    // reaches its own private DB. Delivered to the connector subprocess as config.
    LOBU_DB_EGRESS_POLICY: cloudModeOn() ? 'block-private' : 'allow-private',
  };
}
