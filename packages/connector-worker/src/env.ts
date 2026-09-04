/**
 * Connector-runtime env whitelist.
 *
 * A connector run receives `context.env`, which the prelude installs as
 * `process.env` inside the isolate guest.
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
  const isCloud = cloudModeOn();
  return {
    ENVIRONMENT: process.env.ENVIRONMENT || 'production',
    GITHUB_TOKEN: isCloud ? undefined : process.env.GITHUB_TOKEN,
    GOOGLE_MAPS_API_KEY: isCloud ? undefined : process.env.GOOGLE_MAPS_API_KEY,
    REDDIT_CLIENT_ID: isCloud ? undefined : process.env.REDDIT_CLIENT_ID,
    REDDIT_CLIENT_SECRET: isCloud ? undefined : process.env.REDDIT_CLIENT_SECRET,
    REDDIT_USER_AGENT: process.env.REDDIT_USER_AGENT,
    // WORKER_API_TOKEN is deliberately absent. Everything returned here reaches
    // connector code — `buildConnectorConfig()` merges `job.env` into the
    // connector's config — and a request bearing this token authenticates as a
    // TRUSTED FLEET worker, which can claim and complete runs across tenants. The
    // daemon authenticates via `DaemonConfig.workerApiToken` instead, which
    // never enters this Env.
    // WORKER-DERIVED DEFAULT egress policy. The gateway ships its OWN
    // cloud-mode decision on the poll response (`db_egress_policy`); the daemon's
    // resolveEffectiveEnv() folds it in and takes the STRICTER of the two, so a
    // gateway that says block-private raises the floor even if this worker's
    // LOBU_CLOUD_MODE is unset (which would otherwise leave allow-private and the
    // SSRF guard OFF). This value is the fallback when the gateway response
    // predates that field. DB connectors reject internal/metadata hosts under
    // block-private; self-hosted (allow-private) reaches its own private DB.
    LOBU_DB_EGRESS_POLICY: cloudModeOn() ? 'block-private' : 'allow-private',
  };
}
